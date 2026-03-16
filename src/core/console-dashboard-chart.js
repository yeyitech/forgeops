function normalizeText(value) {
  return String(value ?? "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clampInt(value, min, max) {
  const n = Math.floor(toNumber(value, min));
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function clampPercent(value) {
  const n = toNumber(value, 0);
  return Math.max(0, Math.min(100, n));
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPercent(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(digits)}%`;
}

function formatInt(value) {
  const n = Math.floor(toNumber(value, 0));
  try {
    return n.toLocaleString("en-US");
  } catch {
    return String(n);
  }
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const digits = value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[idx]}`;
}

function getPressureLevel(percent) {
  const n = clampPercent(percent);
  if (n >= 80) return "high";
  if (n >= 55) return "mid";
  return "low";
}

function pressureClass(percent) {
  const level = getPressureLevel(percent);
  if (level === "high") return "pressure-high";
  if (level === "mid") return "pressure-mid";
  return "pressure-low";
}

function pressureLabel(percent) {
  const level = getPressureLevel(percent);
  if (level === "high") return "高压";
  if (level === "mid") return "中压";
  return "低压";
}

function calcCpuPressurePercent(loadAvg1, cores) {
  const load = Number(loadAvg1);
  const coreCount = Number(cores);
  if (!Number.isFinite(load) || !Number.isFinite(coreCount) || coreCount <= 0) return 0;
  return clampPercent((load / coreCount) * 100);
}

function calcHeapPressurePercent(usedBytes, totalBytes) {
  const used = Number(usedBytes);
  const total = Number(totalBytes);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return clampPercent((used / total) * 100);
}

function pickDiskPeak(machine) {
  const disks = Array.isArray(machine?.disks) ? machine.disks : [];
  if (disks.length === 0) return null;
  const sorted = disks.slice().sort((a, b) => toNumber(b?.usedPercent, 0) - toNumber(a?.usedPercent, 0));
  return sorted[0] ?? null;
}

function doctorPassText(doctor) {
  const checks = Array.isArray(doctor?.checks) ? doctor.checks : [];
  const total = checks.length;
  const passed = checks.filter((row) => row?.ok === true).length;
  if (total <= 0) return "-";
  return `${passed}/${total}`;
}

function renderGaugeTile(label, percent, detail) {
  const value = clampPercent(percent);
  const klass = pressureClass(value);
  const pill = pressureLabel(value);
  return [
    `<div class="tile">`,
    `<div class="tileHead">`,
    `<div>`,
    `<div class="tileTitle">${htmlEscape(label)}</div>`,
    `<div class="tileBig mono">${htmlEscape(formatPercent(value))}</div>`,
    `</div>`,
    `<div class="tileGauge ${klass}" style="--gauge:${value}"><span>${htmlEscape(String(Math.round(value)))}%</span></div>`,
    `</div>`,
    `<div class="tileSub mono">${htmlEscape(detail || "-")}</div>`,
    `<div class="tilePill ${klass}">${htmlEscape(pill)}</div>`,
    `</div>`,
  ].join("");
}

function buildBarsHtml(entries, options = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const maxRows = Math.max(1, Math.min(10, Math.floor(toNumber(options.maxRows, 7))));
  const labelMax = Math.max(8, Math.min(40, Math.floor(toNumber(options.labelMaxChars, 20))));
  const color = normalizeText(options.color) || "#60a5fa";
  const clipped = rows
    .map((row) => ({
      key: normalizeText(row?.key ?? row?.k ?? row?.name ?? ""),
      value: toNumber(row?.value ?? row?.v ?? row?.total ?? 0, 0),
    }))
    .filter((row) => row.key)
    .slice(0, maxRows);
  if (clipped.length === 0) {
    return `<div class="empty">No data</div>`;
  }
  const max = clipped.reduce((acc, row) => Math.max(acc, row.value), 0) || 1;
  const truncate = (text) => {
    const raw = normalizeText(text);
    if (raw.length <= labelMax) return raw;
    if (labelMax <= 3) return raw.slice(0, labelMax);
    return `${raw.slice(0, labelMax - 3)}...`;
  };

  return clipped.map((row) => {
    const pct = clampPercent((row.value / max) * 100);
    return [
      `<div class="barRow">`,
      `<div class="barLabel">${htmlEscape(truncate(row.key))}</div>`,
      `<div class="barTrack"><div class="barFill" style="width:${pct.toFixed(1)}%; background:${htmlEscape(color)}"></div></div>`,
      `<div class="barValue">${htmlEscape(formatInt(row.value))}</div>`,
      `</div>`,
    ].join("");
  }).join("");
}

function buildLangBarsHtml(codeLanguages) {
  const rows = Array.isArray(codeLanguages) ? codeLanguages : [];
  const sorted = rows.slice().sort((a, b) => toNumber(b?.lines, 0) - toNumber(a?.lines, 0));
  const top = sorted.slice(0, 6);
  const totalLines = Math.max(1, top.reduce((sum, row) => sum + toNumber(row?.lines, 0), 0));
  if (top.length === 0) {
    return `<div class="empty">No language data</div>`;
  }
  return top.map((row) => {
    const ratio = clampPercent((toNumber(row?.lines, 0) / totalLines) * 100);
    return [
      `<div class="langRow">`,
      `<div class="langName">${htmlEscape(normalizeText(row?.language) || "-")}</div>`,
      `<div class="langTrack"><div class="langFill" style="width:${ratio.toFixed(1)}%;"></div></div>`,
      `<div class="langMeta">${htmlEscape(formatInt(row?.lines))}L/${htmlEscape(formatInt(row?.files))}F</div>`,
      `</div>`,
    ].join("");
  }).join("");
}

function defaultRunQualityGates() {
  return {
    ci: { status: "not_configured" },
    platform: { status: "not_configured" },
    overall: "not_configured",
  };
}

function getRunQualityGates(run) {
  const gates = run?.quality_gates;
  if (!gates || typeof gates !== "object") {
    return defaultRunQualityGates();
  }
  return {
    ...defaultRunQualityGates(),
    ...gates,
    ci: { ...defaultRunQualityGates().ci, ...(gates.ci ?? {}) },
    platform: { ...defaultRunQualityGates().platform, ...(gates.platform ?? {}) },
  };
}

function countGateStatus(runs, selector) {
  const seed = {
    passed: 0,
    failed: 0,
    running: 0,
    pending: 0,
    not_configured: 0,
    skipped: 0,
  };
  return (Array.isArray(runs) ? runs : []).reduce((acc, run) => {
    const status = selector(getRunQualityGates(run));
    const key = normalizeText(status).toLowerCase() || "pending";
    if (key in acc) {
      acc[key] += 1;
    } else {
      acc.pending += 1;
    }
    return acc;
  }, { ...seed });
}

function gateSummaryText(counts) {
  const passed = toNumber(counts?.passed, 0);
  const failed = toNumber(counts?.failed, 0);
  const running = toNumber(counts?.running, 0);
  const pending = toNumber(counts?.pending, 0);
  const skipped = toNumber(counts?.skipped, 0);
  const notConfigured = toNumber(counts?.not_configured, 0);
  const configured = passed + failed + running + pending + skipped;
  const passRate = configured > 0 ? (passed / configured) * 100 : 0;
  if (configured <= 0) {
    return notConfigured > 0 ? "n/a" : "-";
  }
  return `${passed}/${configured} (${formatPercent(passRate)})`;
}

export function renderSystemSettingsDashboardHtml(input, options = {}) {
  const width = clampInt(options?.width ?? 1280, 960, 2000);
  const height = clampInt(options?.height ?? 900, 640, 2000);
  const title = normalizeText(options?.title) || "ForgeOps 系统设置（看板）";

  const systemConfig = input?.systemConfig && typeof input.systemConfig === "object" ? input.systemConfig : {};
  const engine = input?.engine && typeof input.engine === "object" ? input.engine : null;
  const tokenUsage = input?.globalTokenUsage && typeof input.globalTokenUsage === "object" ? input.globalTokenUsage : null;

  const doctor = systemConfig.doctor;
  const machine = systemConfig.machine;
  const diskPeak = pickDiskPeak(machine);

  const cpuLoad1 = toNumber(machine?.cpu?.loadAvg1, 0);
  const cpuPressure = calcCpuPressurePercent(cpuLoad1, toNumber(machine?.cpu?.cores, 0));
  const memoryPressure = clampPercent(toNumber(machine?.memory?.usedPercent, 0));
  const diskPressure = clampPercent(toNumber(diskPeak?.usedPercent, 0));
  const heapPressure = calcHeapPressurePercent(machine?.currentProcess?.heapUsedBytes, machine?.currentProcess?.heapTotalBytes);
  const engineSlots = Math.max(0, Math.floor(toNumber(engine?.concurrency, 0)));
  const activeSessions = Math.max(0, Math.floor(toNumber(engine?.activeSessions, 0)));
  const sessionPressure = engineSlots > 0 ? clampPercent((activeSessions / engineSlots) * 100) : 0;
  const gpuPressure = machine?.gpu?.available ? clampPercent(toNumber(machine?.gpu?.utilizationPercent, 0)) : 0;

  const gauges = [
    renderGaugeTile(
      "CPU 1m 负载",
      cpuPressure,
      `load=${cpuLoad1.toFixed(2)} · cores=${formatInt(machine?.cpu?.cores ?? 0)}`,
    ),
    renderGaugeTile(
      "内存占用",
      memoryPressure,
      `${formatBytes(machine?.memory?.usedBytes)} / ${formatBytes(machine?.memory?.totalBytes)}`,
    ),
    renderGaugeTile(
      "磁盘占用峰值",
      diskPressure,
      diskPeak
        ? `${normalizeText(diskPeak.mountPoint)} · used=${formatPercent(diskPeak.usedPercent)}`
        : "暂无磁盘采样",
    ),
    renderGaugeTile(
      "进程 Heap 压力",
      heapPressure,
      `${formatBytes(machine?.currentProcess?.heapUsedBytes)} / ${formatBytes(machine?.currentProcess?.heapTotalBytes)}`,
    ),
    renderGaugeTile(
      "会话并发占用",
      sessionPressure,
      engineSlots > 0
        ? `active=${formatInt(activeSessions)} / slots=${formatInt(engineSlots)}`
        : `active=${formatInt(activeSessions)} · slots=未上报`,
    ),
    renderGaugeTile(
      "GPU 占用",
      gpuPressure,
      machine?.gpu?.available
        ? `source=${normalizeText(machine?.gpu?.source)} · model=${normalizeText(machine?.gpu?.model) || "-"}`
        : (normalizeText(machine?.gpu?.warning) || "GPU telemetry unavailable"),
    ),
  ].join("");

  const tokenLine = tokenUsage
    ? `total=${formatInt(tokenUsage.total_tokens)} cacheHit=${formatPercent(tokenUsage.token_cache_hit_rate)} at=${normalizeText(tokenUsage.collected_at) || "-"}`
    : "(unavailable)";

  const machineRows = [
    { k: "设备", v: `${normalizeText(machine?.device?.hostname)} (${normalizeText(machine?.device?.platform)}/${normalizeText(machine?.device?.arch)})` },
    { k: "系统", v: `${normalizeText(machine?.device?.release)} · node ${normalizeText(machine?.device?.nodeVersion)}` },
    { k: "CPU", v: `${formatInt(machine?.cpu?.cores)} cores · load ${cpuLoad1.toFixed(2)} / ${toNumber(machine?.cpu?.loadAvg5, 0).toFixed(2)} / ${toNumber(machine?.cpu?.loadAvg15, 0).toFixed(2)}` },
    { k: "内存", v: `${formatBytes(machine?.memory?.usedBytes)} / ${formatBytes(machine?.memory?.totalBytes)} (${formatPercent(machine?.memory?.usedPercent)})` },
    { k: "进程", v: `pid=${formatInt(machine?.currentProcess?.pid)} rss=${formatBytes(machine?.currentProcess?.rssBytes)} cwd=${normalizeText(machine?.currentProcess?.cwd)}` },
    { k: "全局 Tokens", v: tokenLine },
  ].map((row) => {
    return `<div class="kv"><div class="k">${htmlEscape(row.k)}</div><div class="v">${htmlEscape(row.v)}</div></div>`;
  }).join("");

  const doctorRows = (() => {
    const checks = Array.isArray(doctor?.checks) ? doctor.checks : [];
    const failed = checks.filter((row) => row?.ok === false);
    const ok = checks.filter((row) => row?.ok === true);
    const picked = failed.concat(ok).slice(0, 10);
    if (picked.length === 0) return `<div class="empty">No doctor checks</div>`;
    return picked.map((row) => {
      const status = row?.ok === true ? "ok" : "bad";
      return [
        `<div class="doctorRow ${status}">`,
        `<span class="doctorDot"></span>`,
        `<span class="doctorTitle">${htmlEscape(normalizeText(row?.id) || normalizeText(row?.title) || "check")}</span>`,
        `<span class="doctorMeta mono">${htmlEscape(status)}</span>`,
        `</div>`,
      ].join("");
    }).join("");
  })();

  const tokenProjectBars = tokenUsage && Array.isArray(tokenUsage.project_totals)
    ? buildBarsHtml(
        tokenUsage.project_totals
          .map((row) => ({
            key: normalizeText(row?.project_name) || normalizeText(row?.project_id),
            value: toNumber(row?.total_tokens, 0),
          }))
          .filter((row) => row.key && row.value > 0)
          .sort((a, b) => b.value - a.value),
        { maxRows: 8, labelMaxChars: 22, color: "#22c55e" },
      )
    : `<div class="empty">No token usage data</div>`;

  const nowText = new Date().toISOString();
  const collectedAt = normalizeText(machine?.collectedAt) || "-";

  return [
    "<!doctype html>",
    `<html>`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`,
    `<title>${htmlEscape(title)}</title>`,
    `<style>`,
    `:root{--bg0:#0f1117;--bg1:#171a23;--panel:rgba(255,255,255,.045);--stroke:rgba(255,255,255,.11);--text:#f4f4f5;--muted:#a1a1aa;--mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--shadow:0 18px 40px rgba(0,0,0,.38);--green:#22c55e;--orange:#f59e0b;--red:#ef4444;}`,
    `*{box-sizing:border-box}`,
    `html,body{height:100%}`,
    `body{margin:0;background:linear-gradient(180deg,var(--bg1),var(--bg0));color:var(--text);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}`,
    `.frame{width:${width}px;height:${height}px;padding:44px;position:relative;overflow:hidden;}`,
    `.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px),linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px);background-size:44px 44px;opacity:.10;pointer-events:none;}`,
    `.header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;position:relative;z-index:1;}`,
    `.title{font-weight:750;font-size:24px;letter-spacing:.1px;line-height:1.1;}`,
    `.subtitle{margin-top:6px;font-size:12px;color:var(--muted);}`,
    `.mono{font-family:var(--mono);}`,
    `.meta{margin-top:10px;font-size:12px;color:var(--muted);font-family:var(--mono);}`,
    `.tag{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);font-size:12px;color:var(--muted);font-family:var(--mono);}`,
    `.kpis{display:grid;grid-template-columns: repeat(6, 1fr);gap:12px;margin-top:22px;position:relative;z-index:1;}`,
    `.tile{background:var(--panel);border:1px solid var(--stroke);border-radius:14px;box-shadow: var(--shadow);padding:14px 16px;min-height:92px;position:relative;}`,
    `.tileHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}`,
    `.tileTitle{font-weight:650;font-size:12px;color:rgba(244,244,245,.92);letter-spacing:.2px;}`,
    `.tileBig{margin-top:6px;font-weight:760;font-size:22px;}`,
    `.tileSub{margin-top:8px;font-size:12px;color:var(--muted);}`,
    `.tileGauge{width:54px;height:54px;border-radius:999px;display:grid;place-items:center;font-family:var(--mono);font-weight:760;font-size:12px;background:conic-gradient(var(--fill) calc(var(--gauge)*1%), rgba(255,255,255,.08) 0);}`,
    `.tileGauge span{background:rgba(0,0,0,.35);padding:4px 6px;border-radius:999px;border:1px solid rgba(255,255,255,.10);}`,
    `.tilePill{position:absolute;top:12px;right:12px;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);font-family:var(--mono);color:rgba(244,244,245,.92);background:rgba(255,255,255,.04);}`,
    `.pressure-low{--fill:var(--green);}`,
    `.pressure-mid{--fill:var(--orange);}`,
    `.pressure-high{--fill:var(--red);}`,
    `.panels{display:grid;grid-template-columns: repeat(3, 1fr);gap:12px;margin-top:12px;position:relative;z-index:1;}`,
    `.panel{background:var(--panel);border:1px solid var(--stroke);border-radius:14px;box-shadow: var(--shadow);padding:14px 14px 12px;min-height:250px;}`,
    `.panelHeader{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}`,
    `.panelTitle{font-weight:700;font-size:13px;color:rgba(244,244,245,.92);letter-spacing:.2px;}`,
    `.panelBody{margin-top:10px;}`,
    `.empty{color:var(--muted);font-size:12px;}`,
    `.kvs{display:grid;grid-template-columns: 1fr;gap:8px;}`,
    `.kv{display:grid;grid-template-columns: 140px 1fr;gap:10px;align-items:baseline;border-top:1px solid rgba(255,255,255,.08);padding-top:8px;}`,
    `.kv:first-child{border-top:none;padding-top:0;}`,
    `.k{color:rgba(244,244,245,.92);font-size:12px;}`,
    `.v{color:var(--muted);font-size:12px;font-family:var(--mono);word-break:break-word;}`,
    `.doctorRow{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid rgba(255,255,255,.08);}`,
    `.doctorRow:first-child{border-top:none;}`,
    `.doctorDot{width:8px;height:8px;border-radius:999px;background:rgba(161,161,170,.8);}`,
    `.doctorRow.ok .doctorDot{background:var(--green);}`,
    `.doctorRow.bad .doctorDot{background:var(--red);}`,
    `.doctorTitle{flex:1;min-width:0;font-size:12px;color:rgba(244,244,245,.92);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
    `.doctorMeta{font-size:12px;color:var(--muted);}`,
    `.barRow{display:grid;grid-template-columns: 140px 1fr 72px;gap:10px;align-items:center;padding:8px 0;border-top:1px solid rgba(255,255,255,.08);}`,
    `.barRow:first-child{border-top:none;}`,
    `.barLabel{font-size:12px;color:rgba(244,244,245,.92);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}`,
    `.barTrack{height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden;}`,
    `.barFill{height:100%;border-radius:999px;}`,
    `.barValue{text-align:right;font-size:12px;color:var(--muted);font-family:var(--mono);}`,
    `</style>`,
    `</head>`,
    `<body>`,
    `<div class="frame">`,
    `<div class="grid"></div>`,
    `<header class="header">`,
    `<div>`,
    `<div class="title">${htmlEscape(title)}</div>`,
    `<div class="subtitle mono">collectedAt=${htmlEscape(collectedAt)} · doctor=${htmlEscape(doctorPassText(doctor))}</div>`,
    `<div class="meta">now=${htmlEscape(nowText)} · tokens=${htmlEscape(tokenUsage ? "on" : "off")}</div>`,
    `</div>`,
    `<div class="tag">template=system-settings</div>`,
    `</header>`,
    `<section class="kpis">${gauges}</section>`,
    `<section class="panels">`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">机器观测</div><div class="tag">snapshot</div></div><div class="panelBody"><div class="kvs">${machineRows}</div></div></section>`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">Doctor Checks</div><div class="tag">top</div></div><div class="panelBody">${doctorRows}</div></section>`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">Token Projects (7d)</div><div class="tag">top</div></div><div class="panelBody">${tokenProjectBars}</div></section>`,
    `</section>`,
    `</div>`,
    `</body>`,
    `</html>`,
  ].join("");
}

export function renderProjectOverviewDashboardHtml(input, options = {}) {
  const width = clampInt(options?.width ?? 1280, 960, 2000);
  const height = clampInt(options?.height ?? 900, 640, 2000);

  const project = input?.project && typeof input.project === "object" ? input.project : null;
  const metrics = input?.metrics && typeof input.metrics === "object" ? input.metrics : null;
  const runs = Array.isArray(input?.runs) ? input.runs : [];

  const projectName = normalizeText(project?.name) || "Project";
  const title = normalizeText(options?.title) || `ForgeOps 项目概览（看板） · ${projectName}`;
  const nowText = new Date().toISOString();

  const issueAll = toNumber(metrics?.issue_count_all, 0);
  const issueOpen = toNumber(metrics?.issue_count_open, 0);
  const issueClosed = toNumber(metrics?.issue_count_closed, 0);
  const prAll = toNumber(metrics?.pr_count_all, 0);
  const prOpen = toNumber(metrics?.pr_count_open, 0);
  const prClosed = toNumber(metrics?.pr_count_closed, 0);

  const tokenTotal = toNumber(metrics?.token_total, 0);
  const tokenIn = toNumber(metrics?.token_input_total, 0);
  const tokenCached = toNumber(metrics?.token_cached_input_total, 0);
  const tokenOut = toNumber(metrics?.token_output_total, 0);
  const cacheHit = toNumber(metrics?.token_cache_hit_rate, 0);

  const runTotal = toNumber(metrics?.run_count, runs.length);
  const runRunning = toNumber(metrics?.run_running_count, runs.filter((row) => row?.status === "running").length);
  const runCompleted = toNumber(metrics?.run_completed_count, runs.filter((row) => row?.status === "completed").length);
  const runFailed = toNumber(metrics?.run_failed_count, runs.filter((row) => row?.status === "failed").length);
  const runSuccessRate = runTotal > 0 ? (runCompleted / runTotal) * 100 : 0;
  const runQueuePressure = runTotal > 0 ? (runRunning / runTotal) * 100 : 0;

  const ciCounts = countGateStatus(runs, (gates) => gates.ci.status);
  const platformCounts = countGateStatus(runs, (gates) => gates.platform.status);
  const ciSummary = gateSummaryText(ciCounts);
  const platformSummary = gateSummaryText(platformCounts);

  const codeLines = toNumber(metrics?.code_lines, 0);
  const codeFiles = toNumber(metrics?.code_files, 0);
  const docWords = toNumber(metrics?.doc_words, 0);
  const docFiles = toNumber(metrics?.doc_files, 0);
  const docsDocWords = toNumber(metrics?.docs_doc_words, 0);
  const docsDocFiles = toNumber(metrics?.docs_doc_files, 0);

  const trend = metrics?.code_trend_7d && typeof metrics.code_trend_7d === "object" ? metrics.code_trend_7d : null;
  const trendSummary = trend?.available
    ? `commits=${formatInt(trend.commit_count)} +${formatInt(trend.added_lines)} -${formatInt(trend.deleted_lines)} net=${formatInt(trend.net_lines)}`
    : `7d trend unavailable${normalizeText(trend?.warning) ? ` (${normalizeText(trend.warning)})` : ""}`;

  const langBarsHtml = buildLangBarsHtml(metrics?.code_languages);

  const tiles = [
    {
      title: "Issues",
      big: formatInt(issueOpen),
      sub1: `open=${formatInt(issueOpen)} closed=${formatInt(issueClosed)}`,
      sub2: `all=${formatInt(issueAll)}`,
    },
    {
      title: "PRs",
      big: formatInt(prOpen),
      sub1: `open=${formatInt(prOpen)} closed=${formatInt(prClosed)}`,
      sub2: `all=${formatInt(prAll)}`,
    },
    {
      title: "Runs",
      big: formatInt(runTotal),
      sub1: `running=${formatInt(runRunning)} failed=${formatInt(runFailed)}`,
      sub2: `success=${formatPercent(runSuccessRate)} queue=${formatPercent(runQueuePressure)}`,
    },
    {
      title: "Tokens",
      big: formatInt(tokenTotal),
      sub1: `cacheHit=${formatPercent(cacheHit)}`,
      sub2: `in=${formatInt(tokenIn)} out=${formatInt(tokenOut)}`,
    },
    {
      title: "CI Gate",
      big: ciSummary,
      sub1: `passed=${formatInt(ciCounts.passed)} failed=${formatInt(ciCounts.failed)}`,
      sub2: `not_cfg=${formatInt(ciCounts.not_configured)}`,
    },
    {
      title: "Platform Gate",
      big: platformSummary,
      sub1: `passed=${formatInt(platformCounts.passed)} failed=${formatInt(platformCounts.failed)}`,
      sub2: `not_cfg=${formatInt(platformCounts.not_configured)}`,
    },
  ];

  return [
    "<!doctype html>",
    `<html>`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width,initial-scale=1" />`,
    `<title>${htmlEscape(title)}</title>`,
    `<style>`,
    `:root{--bg0:#0f1117;--bg1:#171a23;--panel:rgba(255,255,255,.045);--stroke:rgba(255,255,255,.11);--text:#f4f4f5;--muted:#a1a1aa;--mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;--shadow:0 18px 40px rgba(0,0,0,.38);--blue:#60a5fa;}`,
    `*{box-sizing:border-box}`,
    `html,body{height:100%}`,
    `body{margin:0;background:linear-gradient(180deg,var(--bg1),var(--bg0));color:var(--text);font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;}`,
    `.frame{width:${width}px;height:${height}px;padding:44px;position:relative;overflow:hidden;}`,
    `.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px),linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px);background-size:44px 44px;opacity:.10;pointer-events:none;}`,
    `.header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;position:relative;z-index:1;}`,
    `.title{font-weight:750;font-size:24px;letter-spacing:.1px;line-height:1.1;}`,
    `.subtitle{margin-top:6px;font-size:12px;color:var(--muted);}`,
    `.mono{font-family:var(--mono);}`,
    `.meta{margin-top:10px;font-size:12px;color:var(--muted);font-family:var(--mono);}`,
    `.tag{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;border:1px solid var(--stroke);background:rgba(255,255,255,.04);font-size:12px;color:var(--muted);font-family:var(--mono);}`,
    `.kpis{display:grid;grid-template-columns: repeat(6, 1fr);gap:12px;margin-top:22px;position:relative;z-index:1;}`,
    `.tile{background:var(--panel);border:1px solid var(--stroke);border-radius:14px;box-shadow: var(--shadow);padding:14px 16px;min-height:92px;}`,
    `.tileTitle{font-weight:650;font-size:12px;color:rgba(244,244,245,.92);letter-spacing:.2px;}`,
    `.tileBig{margin-top:6px;font-family:var(--mono);font-weight:760;font-size:22px;}`,
    `.tileSub{margin-top:6px;font-family:var(--mono);font-size:12px;color:var(--muted);}`,
    `.panels{display:grid;grid-template-columns: repeat(3, 1fr);gap:12px;margin-top:12px;position:relative;z-index:1;}`,
    `.panel{background:var(--panel);border:1px solid var(--stroke);border-radius:14px;box-shadow: var(--shadow);padding:14px 14px 12px;min-height:250px;}`,
    `.panelHeader{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}`,
    `.panelTitle{font-weight:700;font-size:13px;color:rgba(244,244,245,.92);letter-spacing:.2px;}`,
    `.panelBody{margin-top:10px;}`,
    `.empty{color:var(--muted);font-size:12px;}`,
    `.kvs{display:grid;grid-template-columns: 1fr;gap:8px;}`,
    `.kv{display:grid;grid-template-columns: 140px 1fr;gap:10px;align-items:baseline;border-top:1px solid rgba(255,255,255,.08);padding-top:8px;}`,
    `.kv:first-child{border-top:none;padding-top:0;}`,
    `.k{color:rgba(244,244,245,.92);font-size:12px;}`,
    `.v{color:var(--muted);font-size:12px;font-family:var(--mono);word-break:break-word;}`,
    `.hint{margin-top:10px;color:var(--muted);font-size:12px;}`,
    `.langRow{display:grid;grid-template-columns: 120px 1fr 100px;gap:10px;align-items:center;margin-top:8px;}`,
    `.langTrack{height:10px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;}`,
    `.langFill{height:100%;background:linear-gradient(90deg,var(--blue),rgba(96,165,250,.35));border-radius:999px;}`,
    `.langName{font-size:12px;color:rgba(244,244,245,.92);}`,
    `.langMeta{font-size:12px;color:var(--muted);font-family:var(--mono);text-align:right;}`,
    `</style>`,
    `</head>`,
    `<body>`,
    `<div class="frame">`,
    `<div class="grid"></div>`,
    `<header class="header">`,
    `<div>`,
    `<div class="title">${htmlEscape(title)}</div>`,
    `<div class="subtitle mono">project=${htmlEscape(project?.id ?? metrics?.project_id ?? "-")} · type=${htmlEscape(normalizeText(project?.product_type) || "-")} · updated=${htmlEscape(normalizeText(metrics?.updated_at) || "-")}</div>`,
    `<div class="meta">now=${htmlEscape(nowText)} · repo=${htmlEscape(normalizeText(project?.github_repo || metrics?.github_repo) || "-")}</div>`,
    `</div>`,
    `<div class="tag">template=project-overview</div>`,
    `</header>`,
    `<section class="kpis">`,
    ...tiles.map((row) => [
      `<div class="tile">`,
      `<div class="tileTitle">${htmlEscape(row.title)}</div>`,
      `<div class="tileBig">${htmlEscape(row.big)}</div>`,
      `<div class="tileSub">${htmlEscape(row.sub1)}</div>`,
      `<div class="tileSub">${htmlEscape(row.sub2)}</div>`,
      `</div>`,
    ].join("")),
    `</section>`,
    `<section class="panels">`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">GitHub</div><div class="tag">available=${htmlEscape(String(Boolean(metrics?.github_available)))}</div></div><div class="panelBody"><div class="kvs"><div class="kv"><div class="k">Repo</div><div class="v">${htmlEscape(normalizeText(project?.github_repo || metrics?.github_repo) || "-")}</div></div><div class="kv"><div class="k">Fetched</div><div class="v">${htmlEscape(normalizeText(metrics?.github_fetched_at) || "-")}</div></div></div>${normalizeText(metrics?.github_warning) ? `<div class=\"hint\">warning: ${htmlEscape(metrics.github_warning)}</div>` : ""}</div></section>`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">Tokens</div><div class="tag">cacheHit=${htmlEscape(formatPercent(cacheHit))}</div></div><div class="panelBody"><div class="kvs"><div class="kv"><div class="k">Total</div><div class="v">${htmlEscape(formatInt(tokenTotal))}</div></div><div class="kv"><div class="k">Input</div><div class="v">${htmlEscape(formatInt(tokenIn))}</div></div><div class="kv"><div class="k">Cached</div><div class="v">${htmlEscape(formatInt(tokenCached))}</div></div><div class="kv"><div class="k">Output</div><div class="v">${htmlEscape(formatInt(tokenOut))}</div></div></div></div></section>`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">Runs & Rhythm</div><div class="tag">success=${htmlEscape(formatPercent(runSuccessRate))}</div></div><div class="panelBody"><div class="kvs"><div class="kv"><div class="k">Total</div><div class="v">${htmlEscape(formatInt(runTotal))}</div></div><div class="kv"><div class="k">running/completed</div><div class="v">${htmlEscape(formatInt(runRunning))}/${htmlEscape(formatInt(runCompleted))}</div></div><div class="kv"><div class="k">failed</div><div class="v">${htmlEscape(formatInt(runFailed))}</div></div><div class="kv"><div class="k">queue_pressure</div><div class="v">${htmlEscape(formatPercent(runQueuePressure))}</div></div></div><div class="hint">${htmlEscape(trendSummary)}</div></div></section>`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">CI Gate</div><div class="tag">${htmlEscape(ciSummary)}</div></div><div class="panelBody"><div class="kvs"><div class="kv"><div class="k">passed</div><div class="v">${htmlEscape(formatInt(ciCounts.passed))}</div></div><div class="kv"><div class="k">failed</div><div class="v">${htmlEscape(formatInt(ciCounts.failed))}</div></div><div class="kv"><div class="k">running/pending</div><div class="v">${htmlEscape(formatInt(ciCounts.running))}/${htmlEscape(formatInt(ciCounts.pending))}</div></div><div class="kv"><div class="k">not_configured</div><div class="v">${htmlEscape(formatInt(ciCounts.not_configured))}</div></div></div></div></section>`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">Platform Gate</div><div class="tag">${htmlEscape(platformSummary)}</div></div><div class="panelBody"><div class="kvs"><div class="kv"><div class="k">passed</div><div class="v">${htmlEscape(formatInt(platformCounts.passed))}</div></div><div class="kv"><div class="k">failed</div><div class="v">${htmlEscape(formatInt(platformCounts.failed))}</div></div><div class="kv"><div class="k">running/pending</div><div class="v">${htmlEscape(formatInt(platformCounts.running))}/${htmlEscape(formatInt(platformCounts.pending))}</div></div><div class="kv"><div class="k">not_configured</div><div class="v">${htmlEscape(formatInt(platformCounts.not_configured))}</div></div></div></div></section>`,
    `<section class="panel"><div class="panelHeader"><div class="panelTitle">Code & Docs</div><div class="tag">loc=${htmlEscape(normalizeText(metrics?.loc_source) || "-")}</div></div><div class="panelBody"><div class="kvs"><div class="kv"><div class="k">Code</div><div class="v">${htmlEscape(formatInt(codeLines))} lines · ${htmlEscape(formatInt(codeFiles))} files</div></div><div class="kv"><div class="k">Docs(all)</div><div class="v">${htmlEscape(formatInt(docWords))} words · ${htmlEscape(formatInt(docFiles))} files</div></div><div class="kv"><div class="k">Docs(docs/)</div><div class="v">${htmlEscape(formatInt(docsDocWords))} words · ${htmlEscape(formatInt(docsDocFiles))} files</div></div></div><div class="hint">Languages (Top 6)</div>${langBarsHtml}</div></section>`,
    `</section>`,
    `</div>`,
    `</body>`,
    `</html>`,
  ].join("");
}

