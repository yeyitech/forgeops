function normalizeText(value) {
  return String(value ?? "").trim();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
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
  const items = Array.isArray(params?.items) ? params.items : [];
  const rows = items.slice(0, maxRows);
  const maxValue = rows.reduce((acc, row) => Math.max(acc, toNumber(row.value, 0)), 0) || 1;

  const chartLeft = x + labelWidth;
  const chartRight = x + width - valueWidth;
  const chartWidth = Math.max(60, chartRight - chartLeft);

  const text = [];
  text.push(`<g transform="translate(${x},${y})">`);
  if (title) {
    text.push(`<text class="h2" x="0" y="0">${xmlEscape(title)}</text>`);
  }

  const baseY = title ? 18 : 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? {};
    const key = normalizeText(row.key) || "unknown";
    const value = toNumber(row.value, 0);
    const w = Math.max(0, Math.round((value / maxValue) * chartWidth));
    const rowY = baseY + 12 + i * rowHeight;

    // Labels
    text.push(`<text class="label" x="0" y="${rowY}" dominant-baseline="middle">${xmlEscape(key)}</text>`);

    // Background bar
    text.push(
      `<rect x="${chartLeft}" y="${rowY - Math.floor(barHeight / 2)}" width="${chartWidth}" height="${barHeight}" rx="6" fill="rgba(255,255,255,0.06)" />`
    );

    // Value bar
    if (w > 0) {
      text.push(
        `<rect x="${chartLeft}" y="${rowY - Math.floor(barHeight / 2)}" width="${w}" height="${barHeight}" rx="6" fill="${xmlEscape(fill)}" />`
      );
    }

    // Value number
    text.push(
      `<text class="value" x="${x + width}" y="${rowY}" text-anchor="end" dominant-baseline="middle">${xmlEscape(String(value))}</text>`
    );
  }

  text.push("</g>");
  return text.join("");
}

export function renderSystemStatusSvg(status, options = {}) {
  const s = status && typeof status === "object" ? status : {};
  const width = clampInt(options?.width ?? 1100, 760, 1920);
  const height = clampInt(options?.height ?? 760, 520, 2000);
  const title = normalizeText(options?.title) || "ForgeOps Status";
  const subtitle = normalizeText(options?.subtitle) || `window=${normalizeText(s.windowMinutes)}m  since=${normalizeText(s.since)}`;

  const runsByStatus = entriesFromCountMap(s.runsByStatus);
  const stepsByStatus = entriesFromCountMap(s.stepsByStatus);
  const sessionsByStatus = entriesFromCountMap(s.sessionsByStatus);
  const projectTypes = entriesFromCountMap(s?.projects?.byProductType);
  const eventsTop = entriesFromCountMap(s?.events?.byTypeTop);

  const tokenTotal = toNumber(s?.tokens?.total, 0);
  const tokenIn = toNumber(s?.tokens?.input, 0);
  const tokenCached = toNumber(s?.tokens?.cachedInput, 0);
  const tokenOut = toNumber(s?.tokens?.output, 0);
  const tokenReason = toNumber(s?.tokens?.reasoningOutput, 0);
  const tokenSessions = toNumber(s?.tokens?.sessions, 0);

  const queue = s?.queue && typeof s.queue === "object" ? s.queue : {};
  const queueLine = `queue: waiting=${toNumber(queue.waiting, 0)} pending=${toNumber(queue.pending, 0)} running=${toNumber(queue.running, 0)} failed=${toNumber(queue.failed, 0)}`;

  const colGap = 26;
  const rowGap = 22;
  const margin = 28;

  const colW = Math.floor((width - margin * 2 - colGap) / 2);
  const leftX = margin;
  const rightX = margin + colW + colGap;
  const topY = margin + 52;

  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  );
  parts.push(`<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#171a23"/>
      <stop offset="1" stop-color="#12141a"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="rgba(0,0,0,0.35)"/>
    </filter>
  </defs>`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="url(#bg)"/>`);

  // Header
  parts.push(`<text class="h1" x="${margin}" y="${margin + 10}">${xmlEscape(title)}</text>`);
  parts.push(`<text class="sub" x="${margin}" y="${margin + 32}">${xmlEscape(subtitle)}</text>`);
  parts.push(`<text class="mono" x="${margin}" y="${margin + 50}">${xmlEscape(queueLine)}</text>`);

  // Panels
  const panelH = 210;
  const panel2H = 250;

  const panel = (x, y, w, h) => {
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.08)" filter="url(#shadow)"/>`);
  };

  panel(leftX, topY, colW, panelH);
  panel(rightX, topY, colW, panelH);
  panel(leftX, topY + panelH + rowGap, colW, panel2H);
  panel(rightX, topY + panelH + rowGap, colW, panel2H);

  const chartPad = 18;
  parts.push(
    renderBarChartSvg({
      title: "Runs By Status",
      x: leftX + chartPad,
      y: topY + chartPad + 8,
      width: colW - chartPad * 2,
      items: runsByStatus,
      maxRows: 8,
      fill: "#ff5c5c",
    })
  );
  parts.push(
    renderBarChartSvg({
      title: "Steps By Status",
      x: rightX + chartPad,
      y: topY + chartPad + 8,
      width: colW - chartPad * 2,
      items: stepsByStatus,
      maxRows: 8,
      fill: "#22c55e",
    })
  );
  parts.push(
    renderBarChartSvg({
      title: "Sessions By Status",
      x: leftX + chartPad,
      y: topY + panelH + rowGap + chartPad + 8,
      width: colW - chartPad * 2,
      items: sessionsByStatus,
      maxRows: 8,
      fill: "#f59e0b",
    })
  );
  parts.push(
    renderBarChartSvg({
      title: "Top Event Types",
      x: rightX + chartPad,
      y: topY + panelH + rowGap + chartPad + 8,
      width: colW - chartPad * 2,
      items: eventsTop,
      maxRows: 8,
      fill: "#60a5fa",
    })
  );

  // Footer (project types + tokens summary)
  const footerY = topY + panelH + rowGap + panel2H + rowGap + 10;
  parts.push(`<text class="h2" x="${margin}" y="${footerY}">Projects By Type (Top)</text>`);
  const typesLine = projectTypes.slice(0, 6).map((row) => `${row.key}:${row.value}`).join("  ");
  parts.push(`<text class="mono" x="${margin}" y="${footerY + 18}">${xmlEscape(typesLine || "n/a")}</text>`);

  parts.push(`<text class="h2" x="${margin}" y="${footerY + 44}">Tokens (window)</text>`);
  parts.push(
    `<text class="mono" x="${margin}" y="${footerY + 62}">${xmlEscape(
      `total=${tokenTotal}  in=${tokenIn}  cached=${tokenCached}  out=${tokenOut}  reasoning=${tokenReason}  sessions=${tokenSessions}`
    )}</text>`
  );

  parts.push(`<style>
    .h1 { font: 700 26px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; fill: rgba(244,244,245,0.98); letter-spacing: 0.2px; }
    .h2 { font: 700 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; fill: rgba(244,244,245,0.92); letter-spacing: 0.2px; }
    .sub { font: 500 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; fill: rgba(161,161,170,0.92); }
    .mono { font: 500 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; fill: rgba(161,161,170,0.92); }
    .label { font: 600 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; fill: rgba(244,244,245,0.88); }
    .value { font: 700 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace; fill: rgba(244,244,245,0.92); }
  </style>`);

  parts.push(`</svg>`);
  return parts.join("");
}

