function normalizeText(value) {
  return String(value ?? "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function formatInt(value) {
  const n = Math.floor(toNumber(value, 0));
  try {
    return n.toLocaleString("en-US");
  } catch {
    return String(n);
  }
}

function clamp(value, min, max) {
  const n = toNumber(value, min);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function truncateEnd(text, maxChars) {
  const raw = normalizeText(text);
  const limit = Math.max(1, Math.floor(toNumber(maxChars, 16)));
  if (raw.length <= limit) return raw;
  if (limit <= 3) return raw.slice(0, limit);
  return `${raw.slice(0, limit - 3)}...`;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function entriesFromCountMap(mapLike) {
  const obj = mapLike && typeof mapLike === "object" ? mapLike : {};
  const entries = Object.entries(obj).map(([k, v]) => ({ key: normalizeText(k) || "unknown", value: toNumber(v, 0) }));
  entries.sort((a, b) => b.value - a.value);
  return entries;
}

function clampInt(value, min, max) {
  const n = Math.floor(toNumber(value, min));
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function sumEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  return rows.reduce((acc, row) => acc + toNumber(row?.value, 0), 0);
}

function getCount(mapLike, key, fallback = 0) {
  const obj = mapLike && typeof mapLike === "object" ? mapLike : {};
  const v = obj[key];
  const n = toNumber(v, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function pickAccentColorForStatusKey(key) {
  const k = normalizeText(key).toLowerCase();
  if (k === "failed" || k === "error") return "#ff5c5c";
  if (k === "running") return "#60a5fa";
  if (k === "pending" || k === "paused") return "#f59e0b";
  if (k === "waiting") return "#a1a1aa";
  if (k === "done" || k === "completed" || k === "success") return "#22c55e";
  return "#a78bfa";
}

function renderBarChartSvg(params) {
  const title = normalizeText(params?.title);
  const x = toNumber(params?.x, 0);
  const y = toNumber(params?.y, 0);
  const width = toNumber(params?.width, 480);
  const rowHeight = toNumber(params?.rowHeight, 22);
  const barHeight = toNumber(params?.barHeight, 12);
  const labelWidth = toNumber(params?.labelWidth, 150);
  const valueWidth = toNumber(params?.valueWidth, 60);
  const maxRows = clampInt(params?.maxRows ?? 8, 1, 24);
  const fill = normalizeText(params?.fill) || "#ff5c5c";
  const labelMaxChars = clampInt(params?.labelMaxChars ?? 20, 8, 48);
  const formatValue = params?.formatValue === false
    ? (n) => String(n)
    : (n) => formatInt(n);
  const fillByKey = typeof params?.fillByKey === "function" ? params.fillByKey : null;
  const items = Array.isArray(params?.items) ? params.items : [];
  const rows = items.slice(0, maxRows);
  const maxValue = rows.reduce((acc, row) => Math.max(acc, toNumber(row.value, 0)), 0) || 1;

  const chartLeft = x + labelWidth;
  const chartRight = x + width - valueWidth;
  const chartWidth = Math.max(60, chartRight - chartLeft);

  const text = [];
  text.push(`<g transform="translate(${x},${y})">`);
  if (title) {
    text.push(`<text class="panelTitle" x="0" y="0">${xmlEscape(title)}</text>`);
  }

  const baseY = title ? 18 : 0;
  if (rows.length === 0) {
    const rowY = baseY + 20;
    text.push(`<text class="mono" x="0" y="${rowY}" dominant-baseline="middle">No data</text>`);
    text.push("</g>");
    return text.join("");
  }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? {};
    const key = normalizeText(row.key) || "unknown";
    const value = toNumber(row.value, 0);
    const keyLabel = truncateEnd(key, labelMaxChars) || "unknown";
    const w = Math.max(0, Math.round((value / maxValue) * chartWidth));
    const rowY = baseY + 12 + i * rowHeight;
    const rowFill = fillByKey ? String(fillByKey(key, value) || fill) : fill;

    // Labels
    text.push(`<text class="label" x="0" y="${rowY}" dominant-baseline="middle">${xmlEscape(keyLabel)}</text>`);

    // Background bar
    text.push(
      `<rect x="${chartLeft}" y="${rowY - Math.floor(barHeight / 2)}" width="${chartWidth}" height="${barHeight}" rx="6" fill="rgba(255,255,255,0.06)" />`
    );

    // Value bar
    if (w > 0) {
      text.push(
        `<rect x="${chartLeft}" y="${rowY - Math.floor(barHeight / 2)}" width="${w}" height="${barHeight}" rx="6" fill="${xmlEscape(rowFill)}" />`
      );
    }

    // Value number
    text.push(
      `<text class="value" x="${x + width}" y="${rowY}" text-anchor="end" dominant-baseline="middle">${xmlEscape(formatValue(value))}</text>`
    );
  }

  text.push("</g>");
  return text.join("");
}

export function renderSystemStatusSvg(status, options = {}) {
  const s = status && typeof status === "object" ? status : {};
  const width = clampInt(options?.width ?? 1100, 760, 1920);
  const height = clampInt(options?.height ?? 760, 560, 2000);
  const title = normalizeText(options?.title) || "ForgeOps Status";
  const subtitle = normalizeText(options?.subtitle) || `window=${normalizeText(s.windowMinutes)}m  since=${normalizeText(s.since)}`;
  const nowText = normalizeText(s.now) || new Date().toISOString();

  const runsByStatus = entriesFromCountMap(s.runsByStatus);
  const stepsByStatus = entriesFromCountMap(s.stepsByStatus);
  const sessionsByStatus = entriesFromCountMap(s.sessionsByStatus);
  const projectTypes = entriesFromCountMap(s?.projects?.byProductType);
  const eventsTop = entriesFromCountMap(s?.events?.byTypeTop);

  const tokenTotal = toNumber(s?.tokens?.total, 0);
  const tokenIn = toNumber(s?.tokens?.input, 0);
  const tokenCached = toNumber(s?.tokens?.cachedInput, 0);
  const tokenOut = toNumber(s?.tokens?.output, 0);
  const tokenSessions = toNumber(s?.tokens?.sessions, 0);

  const projectsTotal = toNumber(s?.projects?.total, 0);
  const projectsActive = toNumber(s?.projects?.active, 0);

  const queue = s?.queue && typeof s.queue === "object" ? s.queue : {};
  const queueWaiting = toNumber(queue.waiting, 0);
  const queuePending = toNumber(queue.pending, 0);
  const queueRunning = toNumber(queue.running, 0);
  const queueFailed = toNumber(queue.failed, 0);

  const eventsTotal = toNumber(s?.events?.total, 0);
  const windowMinutes = toNumber(s.windowMinutes, 0);

  const tokenPromptTotal = tokenIn + tokenCached;
  const cacheHit = tokenPromptTotal > 0 ? (tokenCached / tokenPromptTotal) * 100 : 0;

  const margin = 44;
  const gap = 16;

  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#171a23"/>
      <stop offset="1" stop-color="#12141a"/>
    </linearGradient>
    <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
      <path d="M44 0H0V44" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>
    </pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="rgba(0,0,0,0.35)"/>
    </filter>
  </defs>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="url(#bg)"/>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="url(#grid)" opacity="0.18"/>`);

  const projectMeta = s?.project && typeof s.project === "object" ? s.project : null;
  const headerTitle = projectMeta?.name ? `${title} · ${normalizeText(projectMeta.name)}` : title;

  // Header
  parts.push(`<text class="h1" x="${margin}" y="${margin + 22}">${xmlEscape(headerTitle)}</text>`);
  parts.push(`<text class="sub" x="${margin}" y="${margin + 40}">${xmlEscape(subtitle)}</text>`);
  parts.push(`<text class="sub" x="${width - margin}" y="${margin + 22}" text-anchor="end">${xmlEscape(nowText)}</text>`);

  if (projectMeta?.id || projectMeta?.productType || projectMeta?.rootPath) {
    const metaBits = [
      projectMeta?.id ? `id=${normalizeText(projectMeta.id)}` : "",
      projectMeta?.productType ? `type=${normalizeText(projectMeta.productType)}` : "",
      projectMeta?.rootPath ? `root=${truncateEnd(normalizeText(projectMeta.rootPath), 54)}` : "",
    ].filter(Boolean);
    parts.push(`<text class="mono" x="${margin}" y="${margin + 58}">${xmlEscape(metaBits.join("  "))}</text>`);
  } else {
    parts.push(`<text class="mono" x="${margin}" y="${margin + 58}">${xmlEscape(`events=${formatInt(eventsTotal)}  window=${formatInt(windowMinutes)}m`)}</text>`);
  }

  const headerH = projectMeta ? 74 : 70;
  const kpiY = margin + headerH + 14;
  const kpiH = 92;
  const kpiW = Math.floor((width - margin * 2 - gap * 3) / 4);

  const panelRect = (x, y, w, h) => {
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="rgba(255,255,255,0.035)" stroke="rgba(255,255,255,0.10)" filter="url(#shadow)"/>`);
  };

  const kpiTile = (x, y, w, h, opts) => {
    const tileTitle = normalizeText(opts?.title);
    const big = normalizeText(opts?.big);
    const lines = Array.isArray(opts?.lines) ? opts.lines : [];
    const accent = normalizeText(opts?.accent) || "#60a5fa";
    panelRect(x, y, w, h);
    parts.push(`<rect x="${x + 12}" y="${y + 14}" width="4" height="${h - 28}" rx="2" fill="${xmlEscape(accent)}" opacity="0.95"/>`);
    parts.push(`<text class="tileTitle" x="${x + 22}" y="${y + 30}">${xmlEscape(tileTitle)}</text>`);
    parts.push(`<text class="kpiBig" x="${x + 22}" y="${y + 56}">${xmlEscape(big)}</text>`);
    for (let i = 0; i < Math.min(2, lines.length); i += 1) {
      parts.push(`<text class="mono" x="${x + 22}" y="${y + 76 + i * 16}">${xmlEscape(String(lines[i] ?? ""))}</text>`);
    }
  };

  const typesInlineRaw = projectTypes.slice(0, 3).map((row) => `${row.key}:${formatInt(row.value)}`).join("  ");
  const typesInline = truncateEnd(typesInlineRaw, 34);

  const totalRuns = sumEntries(runsByStatus);
  const totalSteps = sumEntries(stepsByStatus);
  const totalSessions = sumEntries(sessionsByStatus);

  kpiTile(margin + 0 * (kpiW + gap), kpiY, kpiW, kpiH, {
    title: "Projects",
    big: `${formatInt(projectsTotal)}`,
    lines: [
      `active=${formatInt(projectsActive)}`,
      typesInline ? `types ${typesInline}` : "types n/a",
    ],
    accent: "#a78bfa",
  });

  kpiTile(margin + 1 * (kpiW + gap), kpiY, kpiW, kpiH, {
    title: "Runs",
    big: `${formatInt(totalRuns)}`,
    lines: [
      `running=${formatInt(getCount(s.runsByStatus, "running", 0))}  failed=${formatInt(getCount(s.runsByStatus, "failed", 0))}`,
      `completed=${formatInt(getCount(s.runsByStatus, "completed", 0))}`,
    ],
    accent: "#ff5c5c",
  });

  kpiTile(margin + 2 * (kpiW + gap), kpiY, kpiW, kpiH, {
    title: "Queue",
    big: `${formatInt(queueWaiting)}`,
    lines: [
      `pending=${formatInt(queuePending)}  running=${formatInt(queueRunning)}`,
      `failed=${formatInt(queueFailed)}  steps=${formatInt(totalSteps)}`,
    ],
    accent: "#60a5fa",
  });

  kpiTile(margin + 3 * (kpiW + gap), kpiY, kpiW, kpiH, {
    title: "Tokens (window)",
    big: `${formatInt(tokenTotal)}`,
    lines: [
      `sessions=${formatInt(tokenSessions)}  cacheHit=${cacheHit.toFixed(1)}%`,
      `in=${formatInt(tokenIn)} cached=${formatInt(tokenCached)} out=${formatInt(tokenOut)}`,
    ],
    accent: "#22c55e",
  });

  // Charts: 2x2 grid below KPI row.
  const chartsTop = kpiY + kpiH + gap;
  const panelW = Math.floor((width - margin * 2 - gap) / 2);
  const remainingH = height - chartsTop - margin;
  const panelH = Math.floor((remainingH - gap) / 2);
  const leftColX = margin;
  const rightColX = margin + panelW + gap;
  const row1Y = chartsTop;
  const row2Y = chartsTop + panelH + gap;
  const pad = 18;

  panelRect(leftColX, row1Y, panelW, panelH);
  panelRect(rightColX, row1Y, panelW, panelH);
  panelRect(leftColX, row2Y, panelW, panelH);
  panelRect(rightColX, row2Y, panelW, panelH);

  parts.push(
    renderBarChartSvg({
      title: `Runs By Status (total ${formatInt(totalRuns)})`,
      x: leftColX + pad,
      y: row1Y + pad + 8,
      width: panelW - pad * 2,
      items: runsByStatus,
      maxRows: 7,
      labelWidth: 170,
      labelMaxChars: 22,
      fill: "#ff5c5c",
      fillByKey: (key) => pickAccentColorForStatusKey(key),
    })
  );

  parts.push(
    renderBarChartSvg({
      title: `Steps By Status (total ${formatInt(totalSteps)})`,
      x: rightColX + pad,
      y: row1Y + pad + 8,
      width: panelW - pad * 2,
      items: stepsByStatus,
      maxRows: 7,
      labelWidth: 170,
      labelMaxChars: 22,
      fill: "#22c55e",
      fillByKey: (key) => pickAccentColorForStatusKey(key),
    })
  );

  parts.push(
    renderBarChartSvg({
      title: `Sessions By Status (total ${formatInt(totalSessions)})`,
      x: leftColX + pad,
      y: row2Y + pad + 8,
      width: panelW - pad * 2,
      items: sessionsByStatus,
      maxRows: 7,
      labelWidth: 170,
      labelMaxChars: 22,
      fill: "#f59e0b",
      fillByKey: (key) => pickAccentColorForStatusKey(key),
    })
  );

  parts.push(
    renderBarChartSvg({
      title: `Top Event Types (total ${formatInt(eventsTotal)})`,
      x: rightColX + pad,
      y: row2Y + pad + 8,
      width: panelW - pad * 2,
      items: eventsTop,
      maxRows: 7,
      labelWidth: 220,
      labelMaxChars: 28,
      fill: "#60a5fa",
    })
  );

  parts.push(`<style>
    .h1 { font: 750 24px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; fill: rgba(244,244,245,0.98); letter-spacing: 0.1px; }
    .sub { font: 500 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; fill: rgba(161,161,170,0.92); }
    .tileTitle { font: 650 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; fill: rgba(244,244,245,0.92); letter-spacing: 0.2px; }
    .kpiBig { font: 760 22px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; fill: rgba(244,244,245,0.98); }
    .panelTitle { font: 700 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; fill: rgba(244,244,245,0.92); letter-spacing: 0.2px; }
    .mono { font: 520 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; fill: rgba(161,161,170,0.92); }
    .label { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; fill: rgba(244,244,245,0.88); }
    .value { font: 720 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; fill: rgba(244,244,245,0.92); }
  </style>`);

  parts.push(`</svg>`);
  return parts.join("");
}

export function renderProjectStatusSvg(projectStatus, options = {}) {
  const title = normalizeText(options?.title) || "ForgeOps Project Status";
  const subtitle = normalizeText(options?.subtitle)
    || `window=${normalizeText(projectStatus?.windowMinutes)}m  since=${normalizeText(projectStatus?.since)}`;
  return renderSystemStatusSvg(projectStatus, { ...options, title, subtitle });
}

export function renderRunStatusSvg(runSnapshot, options = {}) {
  const runId = normalizeText(options?.runId);
  const task = normalizeText(options?.task);
  const title = task
    ? `ForgeOps Run: ${runId} · ${task.slice(0, 54)}`
    : (runId ? `ForgeOps Run: ${runId}` : "ForgeOps Run");
  const subtitle = normalizeText(options?.subtitle) || `now=${normalizeText(runSnapshot?.now)}`;

  // Shape it to the same input contract as renderSystemStatusSvg for reuse.
  const shaped = {
    now: runSnapshot?.now,
    windowMinutes: runSnapshot?.windowMinutes ?? 0,
    since: runSnapshot?.since ?? "",
    projects: {
      total: 0,
      active: 0,
      byProductType: {},
    },
    runsByStatus: runSnapshot?.runsByStatus ?? {},
    stepsByStatus: runSnapshot?.stepsByStatus ?? {},
    sessionsByStatus: runSnapshot?.sessionsByStatus ?? {},
    queue: runSnapshot?.queue ?? {},
    events: runSnapshot?.events ?? { windowMinutes: 0, since: "", total: 0, byTypeTop: {} },
    tokens: runSnapshot?.tokens ?? { windowMinutes: 0, since: "", sessions: 0, input: 0, cachedInput: 0, output: 0, reasoningOutput: 0, total: 0 },
  };

  return renderSystemStatusSvg(shaped, { ...options, title, subtitle });
}

export function renderSessionStatusSvg(sessionSnapshot, options = {}) {
  const sessionId = normalizeText(options?.sessionId);
  const stepKey = normalizeText(options?.stepKey);
  const agentId = normalizeText(options?.agentId);
  const title = `ForgeOps Session: ${sessionId}`;
  const subtitle = `${stepKey || "-"} (${agentId || "-"}) · status=${normalizeText(sessionSnapshot?.status) || "-"}`;

  const tokens = sessionSnapshot?.tokens && typeof sessionSnapshot.tokens === "object"
    ? sessionSnapshot.tokens
    : {};

  const shaped = {
    now: sessionSnapshot?.now,
    windowMinutes: sessionSnapshot?.windowMinutes ?? 0,
    since: sessionSnapshot?.since ?? "",
    projects: {
      total: 0,
      active: 0,
      byProductType: {},
    },
    runsByStatus: { current: 1 },
    stepsByStatus: { [stepKey || "step"]: 1 },
    sessionsByStatus: { [normalizeText(sessionSnapshot?.status) || "unknown"]: 1 },
    queue: {},
    events: { windowMinutes: 0, since: "", total: 0, byTypeTop: {} },
    tokens: {
      windowMinutes: 0,
      since: "",
      sessions: 1,
      input: toNumber(tokens.input, 0),
      cachedInput: toNumber(tokens.cachedInput, 0),
      output: toNumber(tokens.output, 0),
      reasoningOutput: toNumber(tokens.reasoningOutput, 0),
      total: toNumber(tokens.total, 0),
    },
  };

  return renderSystemStatusSvg(shaped, { ...options, title, subtitle });
}
