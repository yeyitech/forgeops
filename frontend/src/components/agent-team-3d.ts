import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";

export type AgentTeam3DNode = {
  agentId: string;
  state: "running" | "failed" | "waiting";
  stateText: string;
  ownsSteps: number;
  runningCount: number;
  failedCount: number;
};

type WorkerVariant = "robot" | "engineer" | "analyst" | "drone" | "mech";

type WorkerVisual = {
  root: THREE.Group;
  body: THREE.Group;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  phase: number;
  state: AgentTeam3DNode["state"];
  mode: "primitive" | "robot";
  variant: WorkerVariant;
  mixer: THREE.AnimationMixer | null;
  spinnerParts: THREE.Object3D[];
};

type StationVisual = {
  root: THREE.Group;
  ringMaterial: THREE.MeshStandardMaterial;
  beaconMaterial: THREE.MeshStandardMaterial;
  pulseMaterial: THREE.MeshStandardMaterial;
  phase: number;
  state: AgentTeam3DNode["state"];
};

type FlowPod = {
  mesh: THREE.Mesh;
  offset: number;
  speed: number;
};

@customElement("agent-team-3d")
export class AgentTeam3D extends LitElement {
  @property({ attribute: false }) nodes: AgentTeam3DNode[] = [];
  @query(".viewport") private viewportEl!: HTMLDivElement;

  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private animationFrame = 0;
  private clock = new THREE.Clock();
  private elapsedTime = 0;
  private yaw = 0.28;
  private pitch = 0.33;
  private distance = 18;
  private pointerDown = false;
  private pointerX = 0;
  private pointerY = 0;

  private dynamicRoot = new THREE.Group();
  private stations: StationVisual[] = [];
  private workers: WorkerVisual[] = [];
  private flowPods: FlowPod[] = [];
  private flowCurve: THREE.Curve<THREE.Vector3> | null = null;
  private lookAtTarget = new THREE.Vector3(0, 1.4, 0);

  private floorMaterial: THREE.MeshStandardMaterial | null = null;
  private laneMaterial: THREE.MeshStandardMaterial | null = null;
  private loadedTextures: THREE.Texture[] = [];
  private environmentTexture: THREE.Texture | null = null;
  private propTemplates = new Map<string, THREE.Object3D>();
  private workerTemplate: THREE.Object3D | null = null;
  private workerAnimationClips: THREE.AnimationClip[] = [];
  private workerVariantOffset = 0;
  private assetLoadVersion = 0;

  static styles = css`
    :host {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      gap: 10px;
      width: 100%;
      height: 100%;
      min-height: 0;
      align-content: stretch;
    }

    .stage {
      border: 1px solid #2f323d;
      border-radius: 12px;
      overflow: hidden;
      background:
        radial-gradient(620px 320px at 85% -12%, rgba(45, 212, 191, 0.16), transparent 66%),
        radial-gradient(620px 320px at 15% -12%, rgba(59, 130, 246, 0.16), transparent 66%),
        #0b1018;
      min-height: 0;
      height: 100%;
      position: relative;
      touch-action: none;
    }

    .viewport {
      width: 100%;
      height: 100%;
      min-height: 420px;
    }

    .hint {
      position: absolute;
      right: 12px;
      bottom: 10px;
      color: #94a3b8;
      font-size: 11px;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      background: rgba(13, 16, 23, 0.72);
      border: 1px solid #2f323d;
      border-radius: 999px;
      padding: 4px 8px;
      user-select: none;
    }

    .title {
      position: absolute;
      left: 12px;
      top: 10px;
      color: #dbeafe;
      font-size: 11px;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      background: rgba(13, 16, 23, 0.72);
      border: 1px solid #2f323d;
      border-radius: 999px;
      padding: 4px 8px;
      user-select: none;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }

    .legend {
      border: 1px solid #2f323d;
      border-radius: 10px;
      padding: 8px;
      background: #141924;
      display: grid;
      gap: 6px;
      max-height: 220px;
      overflow: auto;
    }

    .legend-item {
      border: 1px solid #2f323d;
      border-radius: 8px;
      background: #10141d;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 8px;
      color: #d9e0ec;
      font-size: 12px;
    }

    .legend-left {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .agent-id {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .legend-meta {
      color: #94a3b8;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      font-size: 11px;
    }

    .state-pill {
      border: 1px solid #2f323d;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10px;
      font-family: "JetBrains Mono", "Fira Code", monospace;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }

    .state-pill.running {
      border-color: rgba(34, 197, 94, 0.55);
      color: #dcfce7;
      background: rgba(34, 197, 94, 0.14);
    }

    .state-pill.failed {
      border-color: rgba(239, 68, 68, 0.55);
      color: #fecaca;
      background: rgba(239, 68, 68, 0.14);
    }

    .state-pill.waiting {
      border-color: rgba(161, 161, 170, 0.46);
      color: #d4d4d8;
      background: rgba(63, 63, 70, 0.24);
    }
  `;

  render() {
    return html`
      <div
        class="stage"
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @pointerleave=${this.onPointerUp}
        @wheel=${this.onWheel}
      >
        <div class="viewport"></div>
        <div class="title">Agent Team Collaboration Lab</div>
        <div class="hint">拖拽旋转 · 滚轮缩放 · 固定机位</div>
      </div>
      <div class="legend">
        ${this.nodes.map((node, index) => {
          const variant = this.resolveWorkerVariant(node, index);
          const roleText = this.getWorkerVariantLabel(variant);
          const roleCode = this.getWorkerVariantCode(variant);
          return html`
          <div class="legend-item">
            <div class="legend-left">
              <span class="agent-id">${node.agentId}</span>
              <span class="legend-meta">role=${roleText} (${roleCode})</span>
              <span class="legend-meta">steps=${node.ownsSteps} · running=${node.runningCount} · failed=${node.failedCount}</span>
            </div>
            <span class=${`state-pill ${node.state}`}>${node.stateText}</span>
          </div>
        `;
        })}
      </div>
    `;
  }

  protected firstUpdated(): void {
    this.setupScene();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("nodes")) {
      this.rebuildSceneActors();
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.disposeScene();
  }

  private setupScene(): void {
    if (!this.viewportEl) return;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#080d14");
    this.scene.fog = new THREE.Fog("#080d14", 20, 50);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 140);
    this.camera.position.set(0, 7.2, 16.4);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.viewportEl.appendChild(this.renderer.domElement);

    const hemisphere = new THREE.HemisphereLight("#dbeafe", "#111827", 0.86);
    this.scene.add(hemisphere);

    const keyLight = new THREE.DirectionalLight("#ffffff", 0.88);
    keyLight.position.set(10, 16, 12);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.left = -18;
    keyLight.shadow.camera.right = 18;
    keyLight.shadow.camera.top = 18;
    keyLight.shadow.camera.bottom = -18;
    this.scene.add(keyLight);

    const rimLight = new THREE.PointLight("#60a5fa", 0.46, 42);
    rimLight.position.set(-14, 7, -4);
    this.scene.add(rimLight);

    this.floorMaterial = new THREE.MeshStandardMaterial({
      color: "#111827",
      roughness: 0.9,
      metalness: 0.04,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(18, 80), this.floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(28, 22, "#22324b", "#152033");
    grid.position.y = -0.01;
    this.scene.add(grid);

    this.scene.add(this.dynamicRoot);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.viewportEl);
    this.clock.start();
    this.elapsedTime = 0;
    this.resize();
    this.rebuildSceneActors();
    this.tickFrame();
    void this.loadExternalAssets();
  }

  private disposeScene(): void {
    this.assetLoadVersion += 1;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = 0;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.clearObject3D(this.dynamicRoot);
    this.disposePropTemplates();
    this.disposeLoadedTextures();
    if (this.environmentTexture) {
      this.environmentTexture.dispose();
      this.environmentTexture = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
      this.renderer = null;
    }
    if (this.scene) {
      this.scene.clear();
      this.scene = null;
    }
    this.camera = null;
    this.flowCurve = null;
    this.stations = [];
    this.workers = [];
    this.flowPods = [];
    this.floorMaterial = null;
    this.laneMaterial = null;
  }

  private disposeLoadedTextures(): void {
    for (const texture of this.loadedTextures) {
      texture.dispose();
    }
    this.loadedTextures = [];
  }

  private disposePropTemplates(): void {
    for (const template of this.propTemplates.values()) {
      this.disposeObjectMaterialGraph(template);
    }
    this.propTemplates.clear();
    if (this.workerTemplate) {
      this.disposeObjectMaterialGraph(this.workerTemplate);
      this.workerTemplate = null;
    }
    this.workerAnimationClips = [];
  }

  private disposeObjectMaterialGraph(root: THREE.Object3D): void {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        material.dispose();
      }
    });
  }

  private clearObject3D(root: THREE.Object3D): void {
    for (let index = root.children.length - 1; index >= 0; index -= 1) {
      const child = root.children[index];
      this.clearObject3D(child);
      root.remove(child);
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        material.dispose();
      }
    }
  }

  private getStatePalette(state: AgentTeam3DNode["state"]) {
    if (state === "running") {
      return { core: "#22c55e", soft: "#a7f3d0", emissive: "#16a34a", accent: "#86efac" };
    }
    if (state === "failed") {
      return { core: "#ef4444", soft: "#fecaca", emissive: "#dc2626", accent: "#fca5a5" };
    }
    return { core: "#64748b", soft: "#d1d5db", emissive: "#475569", accent: "#94a3b8" };
  }

  private hashSeed(value: string): number {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 31 + value.charCodeAt(index)) | 0;
    }
    return Math.abs(hash);
  }

  private getWorkerAccent(node: AgentTeam3DNode, index: number): THREE.Color {
    const seed = this.hashSeed(`${node.agentId}:${index}`);
    const hue = (seed % 360) / 360;
    const saturation = 0.52 + ((seed >> 3) % 30) / 100;
    const lightness = 0.5 + ((seed >> 5) % 16) / 100;
    return new THREE.Color().setHSL(hue, Math.min(0.78, saturation), Math.min(0.7, lightness));
  }

  private resolveWorkerVariant(node: AgentTeam3DNode, index: number): WorkerVariant {
    const variants: WorkerVariant[] = ["engineer", "analyst", "mech"];
    return variants[(index + this.workerVariantOffset) % variants.length];
  }

  private getWorkerVariantLabel(variant: WorkerVariant): string {
    if (variant === "robot") return "机器人";
    if (variant === "engineer") return "工程师";
    if (variant === "analyst") return "分析师";
    if (variant === "drone") return "无人机";
    return "重装机甲";
  }

  private getWorkerVariantCode(variant: WorkerVariant): string {
    if (variant === "robot") return "RB";
    if (variant === "engineer") return "EN";
    if (variant === "analyst") return "AN";
    if (variant === "drone") return "DR";
    return "MK";
  }

  private shortAgentName(agentId: string): string {
    const compact = agentId.trim().split(/[\\s/_-]+/).filter(Boolean);
    if (compact.length === 0) return "AGENT";
    const primary = compact[0];
    if (primary.length <= 6) return primary.toUpperCase();
    return primary.slice(0, 6).toUpperCase();
  }

  private addRobotRoleAccessory(body: THREE.Group, variant: WorkerVariant, accent: THREE.Color): void {
    if (variant === "robot") return;
    if (variant === "engineer") {
      const tool = this.clonePropTemplate("Drill_01");
      if (tool) {
        tool.scale.multiplyScalar(0.7);
        tool.position.set(0.42, 0.92, 0.16);
        tool.rotation.set(0.12, -Math.PI / 2.8, -Math.PI / 12);
        body.add(tool);
      } else {
        const fallback = new THREE.Mesh(
          new THREE.CylinderGeometry(0.03, 0.03, 0.44, 12),
          new THREE.MeshStandardMaterial({
            color: accent,
            roughness: 0.2,
            metalness: 0.72,
            emissive: accent.clone().multiplyScalar(0.3),
            emissiveIntensity: 0.3,
          }),
        );
        fallback.position.set(0.42, 0.92, 0.16);
        fallback.rotation.z = -Math.PI / 10;
        body.add(fallback);
      }
      return;
    }

    if (variant === "analyst") {
      const holoPanel = new THREE.Mesh(
        new THREE.BoxGeometry(0.28, 0.18, 0.02),
        new THREE.MeshStandardMaterial({
          color: "#dbeafe",
          roughness: 0.1,
          metalness: 0.58,
          emissive: accent.clone().multiplyScalar(0.48),
          emissiveIntensity: 0.42,
        }),
      );
      holoPanel.position.set(0.32, 1.02, 0.2);
      holoPanel.rotation.y = -Math.PI / 6;
      holoPanel.rotation.x = -Math.PI / 12;
      holoPanel.castShadow = true;
      body.add(holoPanel);

      const antenna = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.01, 0.24, 10),
        new THREE.MeshStandardMaterial({ color: accent, roughness: 0.2, metalness: 0.62 }),
      );
      antenna.position.set(-0.16, 2.02, -0.04);
      body.add(antenna);
      return;
    }

    const plateMaterial = new THREE.MeshStandardMaterial({
      color: accent.clone().lerp(new THREE.Color("#334155"), 0.34),
      roughness: 0.28,
      metalness: 0.66,
      emissive: accent.clone().multiplyScalar(0.2),
      emissiveIntensity: 0.2,
    });
    const shoulderLeft = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.12, 0.3), plateMaterial);
    shoulderLeft.position.set(-0.4, 1.3, 0);
    shoulderLeft.castShadow = true;
    body.add(shoulderLeft);

    const shoulderRight = shoulderLeft.clone();
    shoulderRight.position.x = 0.4;
    body.add(shoulderRight);

    const backCore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.24, 20),
      new THREE.MeshStandardMaterial({
        color: "#0f172a",
        roughness: 0.16,
        metalness: 0.8,
        emissive: accent.clone().multiplyScalar(0.5),
        emissiveIntensity: 0.46,
      }),
    );
    backCore.rotation.x = Math.PI / 2;
    backCore.position.set(0, 1.1, -0.26);
    backCore.castShadow = true;
    body.add(backCore);
  }

  private rebuildSceneActors(): void {
    if (!this.scene) return;
    for (const worker of this.workers) {
      worker.mixer?.stopAllAction();
    }
    this.clearObject3D(this.dynamicRoot);
    this.stations = [];
    this.workers = [];
    this.flowPods = [];
    this.flowCurve = null;

    if (this.nodes.length === 0) {
      this.lookAtTarget.set(0, 1.4, 0);
      return;
    }

    const stationCount = this.nodes.length;
    const teamSeed = this.hashSeed(this.nodes.map((node) => node.agentId).join("|"));
    this.workerVariantOffset = teamSeed % 3;
    const pairRows = Math.ceil(stationCount / 2);
    const sideOffset = 1.32;
    const rowSpacing = 2.72;
    const stationPositions: THREE.Vector3[] = [];

    for (let index = 0; index < stationCount; index += 1) {
      const row = Math.floor(index / 2);
      const inRow = index % 2;
      const sideSign = row % 2 === 0
        ? (inRow === 0 ? -1 : 1)
        : (inRow === 0 ? 1 : -1);
      const x = sideSign * sideOffset;
      const z = (row - (pairRows - 1) / 2) * rowSpacing;
      stationPositions.push(new THREE.Vector3(x, 0, z));
    }

    this.lookAtTarget.set(0, 1.2, 0);
    this.buildConveyorLane(stationPositions);

    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index];
      const stationPos = stationPositions[index];
      this.buildStation(node, stationPos, index);
      this.buildWorker(node, stationPos, index);
    }

    this.buildFlowPods(stationPositions);
    const xValues = stationPositions.map((point) => point.x);
    const zValues = stationPositions.map((point) => point.z);
    const spanX = Math.max(...xValues) - Math.min(...xValues);
    const spanZ = Math.max(...zValues) - Math.min(...zValues);
    const span = Math.max(spanX, spanZ, 6);
    this.distance = Math.max(10, Math.min(16.5, 8.2 + span * 0.56));
  }

  private getWorkerStandPosition(stationPosition: THREE.Vector3): THREE.Vector3 {
    const sideSign = stationPosition.x >= 0 ? 1 : -1;
    return new THREE.Vector3(
      stationPosition.x + sideSign * 1.06,
      0,
      stationPosition.z + sideSign * 0.12,
    );
  }

  private buildConveyorLane(points: THREE.Vector3[]): void {
    if (points.length < 2) return;

    const path = new THREE.CurvePath<THREE.Vector3>();
    const laneY = 0.36;
    const epsilon = 0.04;
    let current = new THREE.Vector3(points[0].x, laneY, points[0].z);

    for (let index = 0; index < points.length - 1; index += 1) {
      const next = points[index + 1];
      const target = new THREE.Vector3(next.x, laneY, next.z);
      const dx = target.x - current.x;
      const dz = target.z - current.z;
      const absDx = Math.abs(dx);
      const absDz = Math.abs(dz);

      if (absDx <= epsilon && absDz <= epsilon) {
        current = target;
        continue;
      }

      if (absDx > epsilon && absDz > epsilon) {
        const corner = new THREE.Vector3(target.x, laneY, current.z);
        path.add(new THREE.LineCurve3(current.clone(), corner));
        path.add(new THREE.LineCurve3(corner.clone(), target.clone()));
        current = target;
        continue;
      }

      const primaryLength = Math.max(absDx, absDz);
      const elbowOffset = Math.min(0.46, Math.max(0.24, primaryLength * 0.1));
      const elbowSign = index % 2 === 0 ? 1 : -1;

      if (absDx > absDz) {
        const midX = (current.x + target.x) / 2;
        const detourZ = current.z + elbowOffset * elbowSign;
        const p1 = new THREE.Vector3(midX, laneY, current.z);
        const p2 = new THREE.Vector3(midX, laneY, detourZ);
        const p3 = new THREE.Vector3(target.x, laneY, detourZ);
        path.add(new THREE.LineCurve3(current.clone(), p1));
        path.add(new THREE.LineCurve3(p1.clone(), p2));
        path.add(new THREE.LineCurve3(p2.clone(), p3));
        path.add(new THREE.LineCurve3(p3.clone(), target.clone()));
      } else {
        const midZ = (current.z + target.z) / 2;
        const detourX = current.x + elbowOffset * elbowSign;
        const p1 = new THREE.Vector3(current.x, laneY, midZ);
        const p2 = new THREE.Vector3(detourX, laneY, midZ);
        const p3 = new THREE.Vector3(detourX, laneY, target.z);
        path.add(new THREE.LineCurve3(current.clone(), p1));
        path.add(new THREE.LineCurve3(p1.clone(), p2));
        path.add(new THREE.LineCurve3(p2.clone(), p3));
        path.add(new THREE.LineCurve3(p3.clone(), target.clone()));
      }

      current = target;
    }

    this.flowCurve = path;
    const tubeGeometry = new THREE.TubeGeometry(this.flowCurve, 300, 0.13, 16, false);
    this.laneMaterial = new THREE.MeshStandardMaterial({
      color: "#1e293b",
      roughness: 0.55,
      metalness: 0.42,
      emissive: "#0f172a",
      emissiveIntensity: 0.22,
    });
    const tube = new THREE.Mesh(tubeGeometry, this.laneMaterial);
    tube.receiveShadow = true;
    this.dynamicRoot.add(tube);

    const railGeometry = new THREE.TubeGeometry(this.flowCurve, 220, 0.034, 10, false);
    const railMaterial = new THREE.MeshStandardMaterial({
      color: "#64748b",
      roughness: 0.2,
      metalness: 0.72,
      emissive: "#0ea5e9",
      emissiveIntensity: 0.1,
    });
    const rail = new THREE.Mesh(railGeometry, railMaterial);
    rail.position.y = 0.16;
    this.dynamicRoot.add(rail);

    const markerMaterial = new THREE.MeshStandardMaterial({
      color: "#38bdf8",
      roughness: 0.28,
      metalness: 0.54,
      emissive: "#0ea5e9",
      emissiveIntensity: 0.2,
    });
    const markerCount = Math.max(4, Math.round(this.flowCurve.getLength() / 2.4));
    for (let i = 1; i <= markerCount; i += 1) {
      const t = i / (markerCount + 1);
      const start = this.flowCurve.getPointAt(t);
      const direction = this.flowCurve.getTangentAt(t).normalize();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.36, 12), markerMaterial);
      cone.position.set(start.x, 0.62, start.z);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().setY(0.22).normalize());
      this.dynamicRoot.add(cone);
    }
  }

  private buildStation(node: AgentTeam3DNode, position: THREE.Vector3, index: number): void {
    const palette = this.getStatePalette(node.state);
    const root = new THREE.Group();
    root.position.copy(position);

    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.02, 0.22, 26),
      new THREE.MeshStandardMaterial({
        color: "#334155",
        roughness: 0.5,
        metalness: 0.44,
      }),
    );
    plate.position.y = 0.12;
    plate.receiveShadow = true;
    root.add(plate);

    const module = new THREE.Mesh(
      new THREE.BoxGeometry(1.22, 0.62, 0.84),
      new THREE.MeshStandardMaterial({
        color: "#0f172a",
        roughness: 0.44,
        metalness: 0.38,
      }),
    );
    module.position.y = 0.56;
    module.castShadow = true;
    module.receiveShadow = true;
    root.add(module);

    const ringMaterial = new THREE.MeshStandardMaterial({
      color: palette.core,
      roughness: 0.28,
      metalness: 0.56,
      emissive: palette.emissive,
      emissiveIntensity: node.state === "running" ? 0.34 : node.state === "failed" ? 0.5 : 0.08,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.09, 16, 48), ringMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.66;
    root.add(ring);

    const pulseMaterial = new THREE.MeshStandardMaterial({
      color: palette.accent,
      transparent: true,
      opacity: node.state === "running" ? 0.2 : 0.08,
      roughness: 0.5,
      metalness: 0.2,
      emissive: palette.emissive,
      emissiveIntensity: node.state === "running" ? 0.2 : 0.06,
    });
    const pulse = new THREE.Mesh(new THREE.RingGeometry(0.88, 1.2, 48), pulseMaterial);
    pulse.rotation.x = -Math.PI / 2;
    pulse.position.y = 0.04;
    root.add(pulse);

    const beaconMaterial = new THREE.MeshStandardMaterial({
      color: palette.soft,
      roughness: 0.12,
      metalness: 0.64,
      emissive: palette.emissive,
      emissiveIntensity: node.state === "running" ? 0.55 : node.state === "failed" ? 0.8 : 0.12,
    });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 20), beaconMaterial);
    beacon.position.y = 1.06;
    beacon.castShadow = true;
    root.add(beacon);

    const prop = this.createStationProp(node.state, index);
    if (prop) {
      root.add(prop);
    }

    const label = this.createLabelSprite(`${index + 1}. ${node.agentId}`);
    label.position.set(0, 1.46, 0);
    root.add(label);

    this.dynamicRoot.add(root);
    this.stations.push({
      root,
      ringMaterial,
      beaconMaterial,
      pulseMaterial,
      phase: index * 0.68 + Math.random() * 0.2,
      state: node.state,
    });
  }

  private createStationProp(state: AgentTeam3DNode["state"], index: number): THREE.Object3D | null {
    const key = state === "failed"
      ? "WetFloorSign_01"
      : index % 2 === 0
        ? "Drill_01"
        : "Barrel_01";
    const prop = this.clonePropTemplate(key);
    if (!prop) return null;

    if (key === "Drill_01") {
      prop.position.set(0.46, 0.86, 0.12);
      prop.rotation.y = -Math.PI / 3;
    } else if (key === "Barrel_01") {
      prop.position.set(-0.52, 0.24, -0.08);
      prop.rotation.y = Math.PI / 7;
    } else {
      prop.position.set(0.5, 0.09, 0.2);
      prop.rotation.y = Math.PI / 8;
    }
    return prop;
  }

  private clonePropTemplate(key: string): THREE.Object3D | null {
    const template = this.propTemplates.get(key);
    if (!template) return null;
    const clone = template.clone(true);
    clone.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((material) => material.clone());
      } else if (mesh.material) {
        mesh.material = mesh.material.clone();
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    return clone;
  }

  private buildHumanoidWorker(
    node: AgentTeam3DNode,
    stationPosition: THREE.Vector3,
    index: number,
    variant: "engineer" | "analyst" | "mech",
    accent: THREE.Color,
  ): WorkerVisual {
    const palette = this.getStatePalette(node.state);
    const root = new THREE.Group();
    const standPosition = this.getWorkerStandPosition(stationPosition);
    root.position.copy(standPosition);
    root.lookAt(stationPosition.x, 0.6, stationPosition.z);

    const body = new THREE.Group();
    root.add(body);

    const suitBase = new THREE.Color(palette.core).lerp(accent, variant === "mech" ? 0.36 : 0.24);
    const trimBase = new THREE.Color(palette.soft).lerp(accent, 0.18);
    const bootMaterial = new THREE.MeshStandardMaterial({ color: "#0f172a", roughness: 0.62, metalness: 0.2 });
    const suitMaterial = new THREE.MeshStandardMaterial({ color: suitBase, roughness: 0.34, metalness: variant === "mech" ? 0.58 : 0.24 });
    const trimMaterial = new THREE.MeshStandardMaterial({ color: trimBase, roughness: 0.22, metalness: 0.36 });
    const visorMaterial = new THREE.MeshStandardMaterial({
      color: accent,
      roughness: 0.1,
      metalness: 0.72,
      emissive: accent.clone().multiplyScalar(0.35),
      emissiveIntensity: 0.26,
    });

    const legWidth = variant === "mech" ? 0.28 : 0.22;
    const legDepth = variant === "mech" ? 0.32 : 0.24;
    const torsoWidth = variant === "mech" ? 0.8 : variant === "analyst" ? 0.58 : 0.66;
    const torsoHeight = variant === "mech" ? 0.98 : variant === "analyst" ? 0.92 : 0.88;
    const shoulderX = variant === "mech" ? 0.48 : variant === "analyst" ? 0.38 : 0.43;

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(legWidth, 0.72, legDepth), suitMaterial);
    leftLeg.position.set(-0.16, 0.36, 0);
    leftLeg.castShadow = true;
    body.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(legWidth, 0.72, legDepth), suitMaterial);
    rightLeg.position.set(0.16, 0.36, 0);
    rightLeg.castShadow = true;
    body.add(rightLeg);

    const leftBoot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.3), bootMaterial);
    leftBoot.position.set(-0.16, 0.06, 0.04);
    leftBoot.castShadow = true;
    body.add(leftBoot);

    const rightBoot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.11, 0.3), bootMaterial);
    rightBoot.position.set(0.16, 0.06, 0.04);
    rightBoot.castShadow = true;
    body.add(rightBoot);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth, torsoHeight, 0.38), suitMaterial);
    torso.position.y = 1.03;
    torso.castShadow = true;
    body.add(torso);

    const chestPanel = new THREE.Mesh(new THREE.BoxGeometry(torsoWidth * 0.7, 0.32, 0.04), trimMaterial);
    chestPanel.position.set(0, 1.07, 0.21);
    chestPanel.castShadow = true;
    body.add(chestPanel);

    const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.44, 4, 10), suitMaterial);
    leftArm.position.set(-shoulderX, 1.01, 0);
    leftArm.castShadow = true;
    body.add(leftArm);

    const rightArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.44, 4, 10), suitMaterial);
    rightArm.position.set(shoulderX, 1.01, 0);
    rightArm.castShadow = true;
    body.add(rightArm);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 14), trimMaterial);
    neck.position.y = 1.53;
    body.add(neck);

    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.29, 24, 24), trimMaterial);
    helmet.position.y = 1.78;
    helmet.castShadow = true;
    body.add(helmet);

    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.14, 0.06), visorMaterial);
    visor.position.set(0, 1.78, 0.25);
    visor.castShadow = true;
    body.add(visor);

    if (variant === "engineer") {
      const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.44, 0.2), trimMaterial);
      backpack.position.set(0, 1.02, -0.28);
      backpack.castShadow = true;
      body.add(backpack);

      const tool = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 10), visorMaterial);
      tool.rotation.z = Math.PI / 5;
      tool.position.set(0.5, 0.95, 0.1);
      body.add(tool);
    } else if (variant === "analyst") {
      const coat = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.62, 0.3), trimMaterial);
      coat.position.set(0, 0.72, -0.02);
      coat.castShadow = true;
      body.add(coat);

      const tablet = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.16, 0.02),
        new THREE.MeshStandardMaterial({
          color: "#dbeafe",
          roughness: 0.22,
          metalness: 0.52,
          emissive: accent.clone().multiplyScalar(0.45),
          emissiveIntensity: 0.42,
        }),
      );
      tablet.position.set(0.28, 0.96, 0.2);
      tablet.rotation.y = -Math.PI / 7;
      tablet.rotation.x = -Math.PI / 12;
      tablet.castShadow = true;
      body.add(tablet);
    } else {
      const shoulderPlateL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.26), trimMaterial);
      shoulderPlateL.position.set(-0.44, 1.22, 0);
      shoulderPlateL.castShadow = true;
      body.add(shoulderPlateL);
      const shoulderPlateR = shoulderPlateL.clone();
      shoulderPlateR.position.x = 0.44;
      body.add(shoulderPlateR);

      const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.34, 10), visorMaterial);
      antenna.position.set(0.12, 2.02, -0.04);
      antenna.castShadow = true;
      body.add(antenna);
    }

    const badge = this.createWorkerBadgeSprite(
      `${this.getWorkerVariantCode(variant)} · ${this.shortAgentName(node.agentId)}`,
      accent,
    );
    badge.position.set(0, variant === "mech" ? 2.42 : 2.24, 0);
    root.add(badge);

    return {
      root,
      body,
      leftArm,
      rightArm,
      phase: index * 0.92 + Math.random() * 0.5,
      state: node.state,
      mode: "primitive",
      variant,
      mixer: null,
      spinnerParts: [],
    };
  }

  private buildDroneWorker(
    node: AgentTeam3DNode,
    stationPosition: THREE.Vector3,
    index: number,
    accent: THREE.Color,
  ): WorkerVisual {
    const palette = this.getStatePalette(node.state);
    const root = new THREE.Group();
    const standPosition = this.getWorkerStandPosition(stationPosition);
    root.position.set(standPosition.x, 0.64, standPosition.z);
    root.lookAt(stationPosition.x, 0.7, stationPosition.z);

    const body = new THREE.Group();
    root.add(body);

    const coreMaterial = new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.core).lerp(accent, 0.3),
      roughness: 0.24,
      metalness: 0.64,
      emissive: accent.clone().multiplyScalar(0.35),
      emissiveIntensity: node.state === "running" ? 0.5 : node.state === "failed" ? 0.32 : 0.2,
    });
    const frameMaterial = new THREE.MeshStandardMaterial({
      color: "#0f172a",
      roughness: 0.46,
      metalness: 0.58,
    });

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.22, 24, 24), coreMaterial);
    core.castShadow = true;
    body.add(core);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.05, 12, 42), frameMaterial);
    ring.rotation.x = Math.PI / 2;
    ring.castShadow = true;
    body.add(ring);

    const spinnerParts: THREE.Object3D[] = [];
    for (let rotorIndex = 0; rotorIndex < 3; rotorIndex += 1) {
      const angle = (Math.PI * 2 * rotorIndex) / 3;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.34), frameMaterial);
      arm.position.set(Math.cos(angle) * 0.22, 0.02, Math.sin(angle) * 0.22);
      arm.rotation.y = angle;
      arm.castShadow = true;
      body.add(arm);

      const rotor = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.02, 20),
        new THREE.MeshStandardMaterial({
          color: accent,
          roughness: 0.16,
          metalness: 0.68,
          emissive: accent.clone().multiplyScalar(0.4),
          emissiveIntensity: 0.24,
        }),
      );
      rotor.position.set(Math.cos(angle) * 0.42, 0.05, Math.sin(angle) * 0.42);
      rotor.castShadow = true;
      body.add(rotor);
      spinnerParts.push(rotor);
    }

    const leftArm = new THREE.Object3D();
    const rightArm = new THREE.Object3D();
    body.add(leftArm);
    body.add(rightArm);

    const badge = this.createWorkerBadgeSprite(
      `${this.getWorkerVariantCode("drone")} · ${this.shortAgentName(node.agentId)}`,
      accent,
    );
    badge.position.set(0, 1.26, 0);
    root.add(badge);

    return {
      root,
      body,
      leftArm,
      rightArm,
      phase: index * 0.92 + Math.random() * 0.5,
      state: node.state,
      mode: "primitive",
      variant: "drone",
      mixer: null,
      spinnerParts,
    };
  }

  private selectWorkerAnimationClip(state: AgentTeam3DNode["state"]): THREE.AnimationClip | null {
    if (this.workerAnimationClips.length === 0) return null;
    const byName = (name: string) => this.workerAnimationClips.find((clip) => clip.name.toLowerCase() === name.toLowerCase()) ?? null;
    const byContains = (tokens: string[]) => this.workerAnimationClips.find((clip) => {
      const key = clip.name.toLowerCase();
      return tokens.some((token) => key.includes(token));
    }) ?? null;

    if (state === "running") {
      return byName("Running") ?? byName("Walking") ?? byContains(["run", "walk"]) ?? this.workerAnimationClips[0];
    }
    if (state === "failed") {
      return byName("Sitting") ?? byName("Sad") ?? byContains(["sit", "sad", "death"]) ?? this.workerAnimationClips[0];
    }
    return byName("Idle") ?? byName("Standing") ?? byContains(["idle", "stand"]) ?? this.workerAnimationClips[0];
  }

  private buildRobotWorker(
    node: AgentTeam3DNode,
    stationPosition: THREE.Vector3,
    index: number,
    accent: THREE.Color,
    variant: WorkerVariant = "robot",
  ): WorkerVisual | null {
    if (!this.workerTemplate) return null;
    const root = new THREE.Group();
    const standPosition = this.getWorkerStandPosition(stationPosition);
    root.position.copy(standPosition);
    root.lookAt(stationPosition.x, 0.6, stationPosition.z);

    const cloned = SkeletonUtils.clone(this.workerTemplate);
    cloned.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((material) => material.clone());
      } else if (mesh.material) {
        mesh.material = mesh.material.clone();
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        material.color.lerp(accent, variant === "mech" ? 0.28 : 0.2);
        if (node.state === "running") {
          material.emissive = new THREE.Color("#0f172a");
          material.emissiveIntensity = 0.08;
        } else if (node.state === "failed") {
          material.emissive = new THREE.Color("#7f1d1d");
          material.emissiveIntensity = 0.16;
        } else {
          material.emissive = new THREE.Color("#111827");
          material.emissiveIntensity = 0.05;
        }
      }
    });
    root.add(cloned);

    const body = new THREE.Group();
    body.add(cloned);
    root.remove(cloned);
    root.add(body);

    const leftArm = new THREE.Object3D();
    const rightArm = new THREE.Object3D();
    body.add(leftArm);
    body.add(rightArm);

    this.addRobotRoleAccessory(body, variant, accent);

    const badge = this.createWorkerBadgeSprite(
      `${this.getWorkerVariantCode(variant)} · ${this.shortAgentName(node.agentId)}`,
      accent,
    );
    badge.position.set(0, 2.24, 0);
    root.add(badge);

    let mixer: THREE.AnimationMixer | null = null;
    const clip = this.selectWorkerAnimationClip(node.state);
    if (clip) {
      mixer = new THREE.AnimationMixer(cloned);
      const action = mixer.clipAction(clip);
      action.reset();
      action.fadeIn(0.25);
      action.time = Math.random() * Math.max(clip.duration, 0.1);
      action.play();
      if (node.state === "running") {
        action.timeScale = clip.name.toLowerCase().includes("run") ? 0.92 : 1.05;
      } else if (node.state === "failed") {
        action.timeScale = 0.62;
      } else {
        action.timeScale = 0.88;
      }
    }

    return {
      root,
      body,
      leftArm,
      rightArm,
      phase: index * 0.92 + Math.random() * 0.5,
      state: node.state,
      mode: "robot",
      variant,
      mixer,
      spinnerParts: [],
    };
  }

  private buildWorker(node: AgentTeam3DNode, stationPosition: THREE.Vector3, index: number): void {
    const accent = this.getWorkerAccent(node, index);
    const variant = this.resolveWorkerVariant(node, index);
    let worker: WorkerVisual | null = null;
    if (variant === "analyst") {
      worker = this.buildHumanoidWorker(node, stationPosition, index, "analyst", accent);
    } else if (variant === "mech") {
      worker = this.buildHumanoidWorker(node, stationPosition, index, "mech", accent);
    } else {
      worker = this.buildHumanoidWorker(node, stationPosition, index, "engineer", accent);
    }
    if (!worker) {
      worker = this.buildHumanoidWorker(node, stationPosition, index, "engineer", accent);
    }
    this.dynamicRoot.add(worker.root);
    this.workers.push(worker);
  }

  private buildFlowPods(stationPositions: THREE.Vector3[]): void {
    if (!this.flowCurve || stationPositions.length < 2) return;

    const totalLoad = this.nodes.reduce((sum, node) => sum + node.runningCount + Math.min(1, node.failedCount), 0);
    const podCount = Math.max(3, Math.min(12, Math.round(totalLoad + this.nodes.length * 0.8)));

    for (let index = 0; index < podCount; index += 1) {
      const pod = new THREE.Mesh(
        new THREE.SphereGeometry(0.14, 18, 18),
        new THREE.MeshStandardMaterial({
          color: "#67e8f9",
          roughness: 0.2,
          metalness: 0.56,
          emissive: "#06b6d4",
          emissiveIntensity: 0.28,
        }),
      );
      pod.castShadow = true;
      this.dynamicRoot.add(pod);
      this.flowPods.push({
        mesh: pod,
        offset: index / podCount,
        speed: 0.045 + Math.random() * 0.035,
      });
    }
  }

  private createWorkerBadgeSprite(text: string, accent: THREE.Color): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 132;
    const context = canvas.getContext("2d");
    if (!context) {
      const fallback = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#dbeafe" }));
      fallback.scale.set(1.2, 0.3, 1);
      return fallback;
    }

    const accentHex = `#${accent.getHexString()}`;
    context.clearRect(0, 0, canvas.width, canvas.height);
    this.drawRoundRect(context, 6, 20, canvas.width - 12, 88, 22);
    context.fillStyle = "rgba(8, 12, 18, 0.88)";
    context.fill();
    context.strokeStyle = accentHex;
    context.lineWidth = 3;
    context.stroke();

    context.fillStyle = "#dbeafe";
    context.font = "700 38px 'Inter', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2, 0.44, 1);
    sprite.renderOrder = 3;
    return sprite;
  }

  private createLabelSprite(text: string): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) {
      const fallback = new THREE.Sprite(new THREE.SpriteMaterial({ color: "#dbeafe" }));
      fallback.scale.set(1.6, 0.34, 1);
      return fallback;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);
    this.drawRoundRect(context, 0, 18, canvas.width, 90, 20);
    context.fillStyle = "rgba(8, 13, 20, 0.84)";
    context.fill();
    context.strokeStyle = "rgba(59, 130, 246, 0.48)";
    context.lineWidth = 2;
    context.stroke();

    context.fillStyle = "#dbeafe";
    context.font = "600 42px 'Inter', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, canvas.width / 2, 64);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(2.8, 0.56, 1);
    return sprite;
  }

  private drawRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  private async loadExternalAssets(): Promise<void> {
    if (!this.scene || !this.renderer) return;
    const version = ++this.assetLoadVersion;
    const scene = this.scene;
    const renderer = this.renderer;
    const textureLoader = new THREE.TextureLoader();
    const gltfLoader = new GLTFLoader();
    const hdrLoader = new HDRLoader();

    const loadTexture = (url: string): Promise<THREE.Texture> => new Promise((resolve, reject) => {
      textureLoader.load(url, resolve, undefined, reject);
    });
    const loadModel = (url: string): Promise<GLTF> => new Promise((resolve, reject) => {
      gltfLoader.load(
        url,
        (gltf) => resolve(gltf),
        undefined,
        reject,
      );
    });
    const loadHdri = (url: string): Promise<THREE.Texture> => new Promise((resolve, reject) => {
      hdrLoader.load(url, resolve, undefined, reject);
    });

    try {
      const [hdri, floorDiff, floorNor, floorRough, metalDiff, metalNor, metalRough] = await Promise.all([
        loadHdri("/3d/env/studio_small_09_1k.hdr"),
        loadTexture("/3d/textures/concrete_floor_damaged_01_diffuse_1k.jpg"),
        loadTexture("/3d/textures/concrete_floor_damaged_01_nor_gl_1k.jpg"),
        loadTexture("/3d/textures/concrete_floor_damaged_01_rough_1k.jpg"),
        loadTexture("/3d/textures/blue_metal_plate_diffuse_1k.jpg"),
        loadTexture("/3d/textures/blue_metal_plate_nor_gl_1k.jpg"),
        loadTexture("/3d/textures/blue_metal_plate_rough_1k.jpg"),
      ]);

      if (version !== this.assetLoadVersion || !this.scene || !this.renderer) {
        hdri.dispose();
        floorDiff.dispose();
        floorNor.dispose();
        floorRough.dispose();
        metalDiff.dispose();
        metalNor.dispose();
        metalRough.dispose();
        return;
      }

      this.disposeLoadedTextures();

      floorDiff.colorSpace = THREE.SRGBColorSpace;
      metalDiff.colorSpace = THREE.SRGBColorSpace;
      const maxAniso = renderer.capabilities.getMaxAnisotropy();
      for (const texture of [floorDiff, floorNor, floorRough, metalDiff, metalNor, metalRough]) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.anisotropy = Math.min(8, maxAniso);
        this.loadedTextures.push(texture);
      }
      floorDiff.repeat.set(8, 8);
      floorNor.repeat.set(8, 8);
      floorRough.repeat.set(8, 8);
      metalDiff.repeat.set(4, 1);
      metalNor.repeat.set(4, 1);
      metalRough.repeat.set(4, 1);

      if (this.floorMaterial) {
        this.floorMaterial.map = floorDiff;
        this.floorMaterial.normalMap = floorNor;
        this.floorMaterial.roughnessMap = floorRough;
        this.floorMaterial.roughness = 1;
        this.floorMaterial.needsUpdate = true;
      }
      if (this.laneMaterial) {
        this.laneMaterial.map = metalDiff;
        this.laneMaterial.normalMap = metalNor;
        this.laneMaterial.roughnessMap = metalRough;
        this.laneMaterial.roughness = 0.5;
        this.laneMaterial.metalness = 0.55;
        this.laneMaterial.needsUpdate = true;
      }

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();
      const envMap = pmremGenerator.fromEquirectangular(hdri).texture;
      hdri.dispose();
      pmremGenerator.dispose();

      if (this.environmentTexture) {
        this.environmentTexture.dispose();
      }
      this.environmentTexture = envMap;
      scene.environment = envMap;
    } catch {
      // ignore loading errors for optional visual assets
    }

    try {
      const modelResults = await Promise.allSettled([
        loadModel("/3d/models/Drill_01/Drill_01_1k.gltf"),
        loadModel("/3d/models/WetFloorSign_01/WetFloorSign_01_1k.gltf"),
        loadModel("/3d/models/Barrel_01/Barrel_01_1k.gltf"),
      ]);
      if (version !== this.assetLoadVersion) return;
      this.disposePropTemplates();

      const drill = modelResults[0];
      if (drill.status === "fulfilled") {
        this.propTemplates.set("Drill_01", this.normalizeModelRoot(drill.value.scene, 0.54));
      }
      const sign = modelResults[1];
      if (sign.status === "fulfilled") {
        this.propTemplates.set("WetFloorSign_01", this.normalizeModelRoot(sign.value.scene, 1.04));
      }
      const barrel = modelResults[2];
      if (barrel.status === "fulfilled") {
        this.propTemplates.set("Barrel_01", this.normalizeModelRoot(barrel.value.scene, 0.84));
      }
      this.workerTemplate = null;
      this.workerAnimationClips = [];
      this.rebuildSceneActors();
    } catch {
      // ignore loading errors for optional visual assets
    }
  }

  private normalizeModelRoot(model: THREE.Object3D, targetSize: number): THREE.Object3D {
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxEdge = Math.max(size.x, size.y, size.z, 0.001);
    const scale = targetSize / maxEdge;
    model.scale.setScalar(scale);

    const normalizedBox = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    normalizedBox.getCenter(center);
    model.position.sub(center);
    model.position.y -= normalizedBox.min.y;
    return model;
  }

  private resize(): void {
    if (!this.viewportEl || !this.renderer || !this.camera) return;
    const width = Math.max(1, this.viewportEl.clientWidth);
    const height = Math.max(1, this.viewportEl.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, true);
  }

  private tickFrame = (): void => {
    if (!this.scene || !this.camera || !this.renderer) return;
    const delta = this.clock.getDelta();
    this.elapsedTime += delta;
    const elapsed = this.elapsedTime;

    for (const station of this.stations) {
      const pulse = Math.sin(elapsed * 3 + station.phase) * 0.5 + 0.5;
      if (station.state === "running") {
        station.ringMaterial.emissiveIntensity = 0.2 + pulse * 0.5;
        station.beaconMaterial.emissiveIntensity = 0.45 + pulse * 0.55;
        station.pulseMaterial.opacity = 0.12 + pulse * 0.18;
      } else if (station.state === "failed") {
        station.ringMaterial.emissiveIntensity = 0.22 + pulse * 0.68;
        station.beaconMaterial.emissiveIntensity = 0.56 + pulse * 0.72;
        station.pulseMaterial.opacity = 0.08 + pulse * 0.2;
      } else {
        station.ringMaterial.emissiveIntensity = 0.08 + pulse * 0.08;
        station.beaconMaterial.emissiveIntensity = 0.12 + pulse * 0.12;
        station.pulseMaterial.opacity = 0.05 + pulse * 0.04;
      }
    }

    for (const worker of this.workers) {
      const pulse = Math.sin(elapsed * 2.4 + worker.phase);
      worker.mixer?.update(delta);
      if (worker.variant === "drone") {
        const hover = worker.state === "running" ? 0.12 : worker.state === "failed" ? 0.03 : 0.08;
        worker.root.position.y = 0.62 + hover + Math.sin(elapsed * 2.6 + worker.phase) * 0.05;
        worker.body.rotation.y += (worker.state === "running" ? 2.4 : 1.2) * delta;
        for (const spinner of worker.spinnerParts) {
          spinner.rotation.y += (worker.state === "failed" ? 8 : 18) * delta;
        }
        continue;
      }

      if (worker.state === "running") {
        worker.root.position.y = 0.06 + Math.max(0, pulse) * 0.08;
        if (worker.mode === "primitive") {
          worker.leftArm.rotation.x = 0.26 + pulse * 0.38;
          worker.rightArm.rotation.x = 0.26 - pulse * 0.38;
        }
        worker.body.rotation.y = Math.sin(elapsed * 0.8 + worker.phase) * (worker.variant === "mech" ? 0.05 : 0.07);
        worker.body.rotation.z = 0;
      } else if (worker.state === "failed") {
        worker.root.position.y = 0.02;
        if (worker.mode === "primitive") {
          worker.leftArm.rotation.x = 0.18 + Math.sin(elapsed * 8 + worker.phase) * 0.1;
          worker.rightArm.rotation.x = 0.18 + Math.cos(elapsed * 8 + worker.phase) * 0.1;
        }
        worker.body.rotation.y = Math.sin(elapsed * 4 + worker.phase) * 0.04;
        worker.body.rotation.z = -0.06;
      } else {
        worker.root.position.y = 0.01;
        if (worker.mode === "primitive") {
          worker.leftArm.rotation.x = 0.12 + pulse * 0.05;
          worker.rightArm.rotation.x = 0.12 - pulse * 0.05;
        }
        worker.body.rotation.y = Math.sin(elapsed * 0.6 + worker.phase) * 0.03;
        worker.body.rotation.z = 0;
      }
    }

    if (this.flowCurve) {
      for (const pod of this.flowPods) {
        const t = (elapsed * pod.speed + pod.offset) % 1;
        const position = this.flowCurve.getPointAt(t);
        const tangent = this.flowCurve.getTangentAt(t);
        pod.mesh.position.copy(position);
        pod.mesh.position.y += 0.14;
        const scale = 0.9 + Math.sin((elapsed + pod.offset * 10) * 4) * 0.1;
        pod.mesh.scale.setScalar(scale);
        const lookTarget = position.clone().add(tangent);
        pod.mesh.lookAt(lookTarget);
      }
    }

    const pitch = Math.max(0.12, Math.min(0.7, this.pitch));
    const camX = Math.cos(this.yaw) * Math.cos(pitch) * this.distance;
    const camY = Math.sin(pitch) * this.distance + 2.4;
    const camZ = Math.sin(this.yaw) * Math.cos(pitch) * this.distance;
    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.lookAtTarget);

    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this.tickFrame);
  };

  private onPointerDown = (ev: PointerEvent): void => {
    this.pointerDown = true;
    this.pointerX = ev.clientX;
    this.pointerY = ev.clientY;
  };

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.pointerDown) return;
    const deltaX = ev.clientX - this.pointerX;
    const deltaY = ev.clientY - this.pointerY;
    this.pointerX = ev.clientX;
    this.pointerY = ev.clientY;
    this.yaw -= deltaX * 0.0055;
    this.pitch = Math.max(0.1, Math.min(0.78, this.pitch + deltaY * 0.004));
  };

  private onPointerUp = (): void => {
    this.pointerDown = false;
  };

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    this.distance = Math.max(10, Math.min(30, this.distance + ev.deltaY * 0.008));
  };
}
