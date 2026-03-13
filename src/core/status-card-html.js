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

function formatInt(value) {
  const n = Math.floor(toNumber(value, 0));
  try {
    return n.toLocaleString("en-US");
  } catch {
    return String(n);
  }
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function entriesFromCountMap(mapLike) {
  const obj = mapLike && typeof mapLike === "object" ? mapLike : {};
  const entries = Object.entries(obj).map(([k, v]) => ({ key: normalizeText(k) || "unknown", value: toNumber(v, 0) }));
  entries.sort((a, b) => b.value - a.value);
  return entries;
}

function truncateEnd(text, maxChars) {
  const raw = normalizeText(text);
  const limit = Math.max(1, Math.floor(toNumber(maxChars, 16)));
  if (raw.length <= limit) return raw;
  if (limit <= 3) return raw.slice(0, limit);
  return `${raw.slice(0, limit - 3)}...`;
}

function sumEntries(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  return rows.reduce((acc, row) => acc + toNumber(row?.value, 0), 0);
}

function getCount(mapLike, key) {
  const obj = mapLike && typeof mapLike === "object" ? mapLike : {};
  return toNumber(obj[key], 0);
}

function colorForStatusKey(key) {
  const k = normalizeText(key).toLowerCase();
  if (k === "failed" || k === "error") return "#ff5c5c";
  if (k === "running") return "#60a5fa";
  if (k === "pending" || k === "paused") return "#f59e0b";
  if (k === "waiting") return "#a1a1aa";
  if (k === "done" || k === "completed" || k === "success") return "#22c55e";
  return "#a78bfa";
}

function buildBarsHtml(entries, options = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const maxRows = Math.max(1, Math.min(10, Math.floor(toNumber(options.maxRows, 7))));
  const labelMax = Math.max(8, Math.min(40, Math.floor(toNumber(options.labelMaxChars, 22))));
  const colorByKey = options.colorByKey === true;
  const clipped = rows.slice(0, maxRows);
  const max = clipped.reduce((acc, row) => Math.max(acc, toNumber(row.value, 0)), 0) || 1;
  if (clipped.length === 0) {
    return `<div class="empty">No data</div>`;
  }
  return clipped.map((row) => {
    const key = truncateEnd(row.key, labelMax);
    const value = toNumber(row.value, 0);
    const pct = Math.max(0, Math.min(100, Math.round((value / max) * 100)));
    const fillColor = colorByKey ? colorForStatusKey(row.key) : null;
    return [
      `<div class="barRow">`,
      `<div class="barLabel">${htmlEscape(key)}</div>`,
      `<div class="barTrack"><div class="barFill" style="width:${pct}%;${fillColor ? `background:${htmlEscape(fillColor)};` : ""}"></div></div>`,
      `<div class="barValue">${htmlEscape(formatInt(value))}</div>`,
      `</div>`,
    ].join("");
  }).join("");
}

function renderStatusCardHtml(status, options = {}) {
  const s = status && typeof status === "object" ? status : {};
  const width = clampInt(options?.width ?? 1280, 960, 2000);
  const height = clampInt(options?.height ?? 900, 640, 2000);

  const title = normalizeText(options.title) || "ForgeOps Status";
  const subtitle = normalizeText(options.subtitle) || `window=${normalizeText(s.windowMinutes)}m  since=${normalizeText(s.since)}`;
  const nowText = normalizeText(s.now) || new Date().toISOString();
  const meta = options.meta && typeof options.meta === "object" ? options.meta : null;

  const runsByStatus = entriesFromCountMap(s.runsByStatus);
  const stepsByStatus = entriesFromCountMap(s.stepsByStatus);
  const sessionsByStatus = entriesFromCountMap(s.sessionsByStatus);
  const runsByStatusWindow = entriesFromCountMap(s.runsByStatusWindow);
  const stepsByStatusWindow = entriesFromCountMap(s.stepsByStatusWindow);
  const sessionsByStatusWindow = entriesFromCountMap(s.sessionsByStatusWindow);

  const topFailedStepsByKey = entriesFromCountMap(s.topFailedStepsByKey);
  const tokensByStepKey = entriesFromCountMap(s.tokensByStepKey);
  const sessionsByAgent = entriesFromCountMap(s.sessionsByAgent);

  const projectTypes = entriesFromCountMap(s?.projects?.byProductType);

  const projectsTotal = toNumber(s?.projects?.total, 0);
  const projectsActive = toNumber(s?.projects?.active, 0);

  const totalRuns = sumEntries(runsByStatus);
  const totalSteps = sumEntries(stepsByStatus);
  const totalSessions = sumEntries(sessionsByStatus);

  const windowRunsTotal = sumEntries(runsByStatusWindow);
  const windowStepsTotal = sumEntries(stepsByStatusWindow);
  const windowSessionsTotal = sumEntries(sessionsByStatusWindow);
  const windowStepsDone = getCount(s.stepsByStatusWindow, "done") + getCount(s.stepsByStatusWindow, "completed");
  const windowStepsFailed = getCount(s.stepsByStatusWindow, "failed");
  const windowFailureRate = (windowStepsDone + windowStepsFailed) > 0
    ? (windowStepsFailed / (windowStepsDone + windowStepsFailed)) * 100
    : 0;

  const queue = s?.queue && typeof s.queue === "object" ? s.queue : {};
  const queueWaiting = toNumber(queue.waiting, 0);
  const queuePending = toNumber(queue.pending, 0);
  const queueRunning = toNumber(queue.running, 0);
  const queueFailed = toNumber(queue.failed, 0);

  const tokens = s?.tokens && typeof s.tokens === "object" ? s.tokens : {};
  const tokenTotal = toNumber(tokens.total, 0);
  const tokenIn = toNumber(tokens.input, 0);
  const tokenCached = toNumber(tokens.cachedInput, 0);
  const tokenOut = toNumber(tokens.output, 0);
  const tokenSessions = toNumber(tokens.sessions, 0);
  const tokenPrompt = tokenIn + tokenCached;
  const cacheHit = tokenPrompt > 0 ? (tokenCached / tokenPrompt) * 100 : 0;

  const eventsTotal = toNumber(s?.events?.total, 0);
  const windowMinutes = toNumber(s.windowMinutes, 0);

  const typesInline = projectTypes.slice(0, 3).map((row) => `${row.key}:${formatInt(row.value)}`).join("  ");
  const topFailInline = topFailedStepsByKey.slice(0, 2).map((row) => `${row.key}:${formatInt(row.value)}`).join("  ");

  const metaLine = meta
    ? [
      meta.id ? `id=${normalizeText(meta.id)}` : "",
      meta.type ? `type=${normalizeText(meta.type)}` : "",
      meta.root ? `root=${truncateEnd(normalizeText(meta.root), 64)}` : "",
    ].filter(Boolean).join("  ")
    : `events=${formatInt(eventsTotal)}  window=${formatInt(windowMinutes)}m  topFail ${truncateEnd(topFailInline || "n/a", 40)}`;

  const kpi = [
    {
      title: "Projects",
      big: formatInt(projectsTotal),
      sub1: `active=${formatInt(projectsActive)}`,
      sub2: typesInline ? `types ${truncateEnd(typesInline, 34)}` : "types n/a",
    },
    {
      title: `Runs (${formatInt(windowMinutes)}m)`,
      big: formatInt(windowRunsTotal),
      sub1: `running=${formatInt(getCount(s.runsByStatusWindow, "running"))} failed=${formatInt(getCount(s.runsByStatusWindow, "failed"))}`,
      sub2: `total=${formatInt(totalRuns)}`,
    },
    {
      title: `Steps (${formatInt(windowMinutes)}m)`,
      big: formatInt(windowStepsTotal),
      sub1: `done=${formatInt(windowStepsDone)} failed=${formatInt(windowStepsFailed)}`,
      sub2: `failRate=${windowFailureRate.toFixed(1)}%`,
    },
    {
      title: `Sessions (${formatInt(windowMinutes)}m)`,
      big: formatInt(windowSessionsTotal),
      sub1: `running=${formatInt(getCount(s.sessionsByStatusWindow, "running"))} failed=${formatInt(getCount(s.sessionsByStatusWindow, "failed"))}`,
      sub2: `total=${formatInt(totalSessions)}`,
    },
    {
      title: "Queue (now)",
      big: formatInt(queueWaiting),
      sub1: `pending=${formatInt(queuePending)} running=${formatInt(queueRunning)}`,
      sub2: `failed=${formatInt(queueFailed)}`,
    },
    {
      title: `Tokens (${formatInt(windowMinutes)}m)`,
      big: formatInt(tokenTotal),
      sub1: `sessions=${formatInt(tokenSessions)} cacheHit=${cacheHit.toFixed(1)}%`,
      sub2: `in=${formatInt(tokenIn)} cached=${formatInt(tokenCached)} out=${formatInt(tokenOut)}`,
    },
  ];

  const panel = (panelTitle, bodyHtml, hint = "") => {
    const hintHtml = hint ? `<div class="panelHint">${htmlEscape(hint)}</div>` : "";
    return [
      `<section class="panel">`,
      `<div class="panelHeader">`,
      `<div class="panelTitle">${htmlEscape(panelTitle)}</div>`,
      hintHtml,
      `</div>`,
      `<div class="panelBody">`,
      bodyHtml,
      `</div>`,
      `</section>`,
    ].join("");
  };

  const html = [
    "<!doctype html>",
    `<html>`,
    `<head>`,
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<title>${htmlEscape(title)}</title>`,
    `<style>`,
    `:root{`,
    `  --bg0:#0b0c10;`,
    `  --bg1:#10131a;`,
    `  --panel:rgba(255,255,255,.045);`,
    `  --stroke:rgba(255,255,255,.11);`,
    `  --text:rgba(244,244,245,.98);`,
    `  --muted:rgba(161,161,170,.92);`,
    `  --shadow:0 18px 40px rgba(0,0,0,.38);`,
    `  --barTrack:rgba(255,255,255,.07);`,
    `  --barFill:#60a5fa;`,
    `}`,
    `*{box-sizing:border-box}`,
    `html,body{height:100%}`,
    `body{margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; color:var(--text);}`,
    `.frame{width:${width}px; height:${height}px; padding:44px; background: radial-gradient(980px 560px at 12% 0%, rgba(167,139,250,.22), transparent 55%), radial-gradient(940px 560px at 78% 10%, rgba(96,165,250,.20), transparent 58%), linear-gradient(180deg,#171a23,#0f1117); position:relative; overflow:hidden;}`,
    `.grid{position:absolute; inset:0; background-image: linear-gradient(rgba(255,255,255,.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.06) 1px, transparent 1px); background-size: 44px 44px; opacity:.10; pointer-events:none;}`,
    `.header{display:flex; align-items:flex-start; justify-content:space-between; gap:16px; position:relative; z-index:1;}`,
    `.title{font-weight:750; font-size:24px; letter-spacing:.1px; line-height:1.1;}`,
    `.subtitle{margin-top:6px; font-size:12px; color:var(--muted);}`,
    `.meta{margin-top:10px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; color:var(--muted);}`,
    `.now{font-size:12px; color:var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; text-align:right; white-space:nowrap;}`,
    `.kpis{display:grid; grid-template-columns: repeat(6, 1fr); gap:12px; margin-top:22px; position:relative; z-index:1;}`,
    `.tile{background:var(--panel); border:1px solid var(--stroke); border-radius:14px; box-shadow: var(--shadow); padding:14px 16px; min-height:92px;}`,
    `.tileTitle{font-weight:650; font-size:12px; color:rgba(244,244,245,.92); letter-spacing:.2px;}`,
    `.tileBig{margin-top:6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-weight:760; font-size:22px;}`,
    `.tileSub{margin-top:6px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; color:var(--muted);}`,
    `.panels{display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-top:12px; position:relative; z-index:1;}`,
    `.panel{background:var(--panel); border:1px solid var(--stroke); border-radius:14px; box-shadow: var(--shadow); padding:14px 14px 12px; min-height:250px;}`,
    `.panelHeader{display:flex; align-items:baseline; justify-content:space-between; gap:12px;}`,
    `.panelTitle{font-weight:700; font-size:13px; color:rgba(244,244,245,.92); letter-spacing:.2px;}`,
    `.panelHint{font-size:12px; color:var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}`,
    `.barRow{display:grid; grid-template-columns: 160px 1fr 64px; gap:10px; align-items:center; margin-top:10px;}`,
    `.barLabel{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; color:rgba(244,244,245,.88); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}`,
    `.barTrack{height:12px; background:var(--barTrack); border-radius:8px; overflow:hidden;}`,
    `.barFill{height:100%; background:var(--barFill); border-radius:8px;}`,
    `.barValue{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-weight:720; font-size:12px; text-align:right;}`,
    `.empty{margin-top:14px; font-size:12px; color:var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;}`,
    `</style>`,
    `</head>`,
    `<body>`,
    `<div class="frame">`,
    `<div class="grid"></div>`,
    `<header class="header">`,
    `<div>`,
    `<div class="title">${htmlEscape(title)}</div>`,
    `<div class="subtitle">${htmlEscape(subtitle)}</div>`,
    `<div class="meta">${htmlEscape(metaLine)}</div>`,
    `</div>`,
    `<div class="now">${htmlEscape(nowText)}</div>`,
    `</header>`,
    `<section class="kpis">`,
    ...kpi.map((row) => [
      `<div class="tile">`,
      `<div class="tileTitle">${htmlEscape(row.title)}</div>`,
      `<div class="tileBig">${htmlEscape(row.big)}</div>`,
      `<div class="tileSub">${htmlEscape(row.sub1)}</div>`,
      `<div class="tileSub">${htmlEscape(row.sub2)}</div>`,
      `</div>`,
    ].join("")),
    `</section>`,
    `<section class="panels">`,
    panel(
      `Runs By Status (${formatInt(windowMinutes)}m)`,
      `<div>${buildBarsHtml(runsByStatusWindow, { maxRows: 7, labelMaxChars: 22, colorByKey: true })}</div>`,
      `total=${formatInt(totalRuns)}`
    ),
    panel(
      `Steps By Status (${formatInt(windowMinutes)}m)`,
      `<div>${buildBarsHtml(stepsByStatusWindow, { maxRows: 7, labelMaxChars: 22, colorByKey: true })}</div>`,
      `total=${formatInt(totalSteps)}`
    ),
    panel(
      `Sessions By Status (${formatInt(windowMinutes)}m)`,
      `<div>${buildBarsHtml(sessionsByStatusWindow, { maxRows: 7, labelMaxChars: 22, colorByKey: true })}</div>`,
      `total=${formatInt(totalSessions)}`
    ),
    panel(
      `Top Failing Steps (${formatInt(windowMinutes)}m)`,
      `<div style="--barFill:#ff5c5c">${buildBarsHtml(topFailedStepsByKey, { maxRows: 7, labelMaxChars: 28 })}</div>`,
      `failed=${formatInt(windowStepsFailed)}`
    ),
    panel(
      `Tokens By Step (${formatInt(windowMinutes)}m)`,
      `<div style="--barFill:#22c55e">${buildBarsHtml(tokensByStepKey, { maxRows: 7, labelMaxChars: 28 })}</div>`,
      `total=${formatInt(tokenTotal)}`
    ),
    panel(
      `Sessions By Agent (${formatInt(windowMinutes)}m)`,
      `<div style="--barFill:#60a5fa">${buildBarsHtml(sessionsByAgent, { maxRows: 7, labelMaxChars: 18 })}</div>`,
      `sessions=${formatInt(windowSessionsTotal)}`
    ),
    `</section>`,
    `</div>`,
    `</body>`,
    `</html>`,
  ].join("");

  return html;
}

export function renderSystemStatusHtml(status, options = {}) {
  const title = normalizeText(options?.title) || "ForgeOps System Status";
  return renderStatusCardHtml(status, {
    title,
    subtitle: normalizeText(options?.subtitle) || "",
    width: options?.width,
    height: options?.height,
  });
}

export function renderProjectStatusHtml(projectStatus, options = {}) {
  const project = projectStatus?.project && typeof projectStatus.project === "object"
    ? projectStatus.project
    : null;
  const projectName = normalizeText(project?.name) || normalizeText(options?.projectName);
  const title = projectName ? `ForgeOps Project Status · ${projectName}` : "ForgeOps Project Status";
  return renderStatusCardHtml(projectStatus, {
    title,
    subtitle: normalizeText(options?.subtitle) || "",
    meta: project
      ? {
          id: project?.id,
          type: project?.productType,
          root: project?.rootPath,
        }
      : null,
    width: options?.width,
    height: options?.height,
  });
}
