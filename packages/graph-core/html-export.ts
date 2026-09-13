/**
 * 交互式 HTML 图谱快照（v2.0.0 M4/D5）
 *
 * 产出单个自包含 .html：内嵌 SVG 径向图 + 悬停详情 + 滚轮缩放 + 拖拽平移，
 * 零外部依赖（无 CDN、无字体请求），可直接发给同事或放进报告。
 *
 * 安全：所有动态文本（文件名/路径）都经 HTML 转义后才注入，防文件名携带标签。
 */

import { layoutGraph, type LayoutInputEdge, type LayoutInputNode } from './layout'
import type { GraphModel, SoftwareItem } from '../shared/types'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const RADIUS: Record<number, number> = { 0: 22, 1: 11, 2: 9, 3: 7 }
const COLOR: Record<string, string> = {
  software: '#22d3ee',
  group: '#64748b',
  file: '#38bdf8'
}

export function graphInteractiveHtml(sw: SoftwareItem, model: GraphModel): string {
  // 1) 布局（主进程同步计算；>3000 节点自动走近似布局）
  const nodes: LayoutInputNode[] = model.nodes.map((n) => ({
    id: n.id,
    tier: n.tier,
    radius: n.type === 'software' ? 22 : n.type === 'group' ? 16 : RADIUS[n.tier] ?? 9,
    sector: n.label.slice(0, 2)
  }))
  const edges: LayoutInputEdge[] = model.edges.map((e) => ({ source: e.source, target: e.target }))
  const layout = layoutGraph(nodes, edges, 'radial')

  // 2) 包围盒
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of Object.values(layout.positions)) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  if (!Number.isFinite(minX)) {
    minX = minY = 0
    maxX = maxY = 100
  }
  const pad = 60
  minX -= pad
  minY -= pad
  maxX += pad
  maxY += pad
  const width = Math.round(maxX - minX)
  const height = Math.round(maxY - minY)

  // 3) SVG 内容
  const posById = new Map(model.nodes.map((n) => [n.id, layout.positions[n.id] ?? { x: 0, y: 0 }]))
  const lines = model.edges
    .map((e) => {
      const a = posById.get(e.source)
      const b = posById.get(e.target)
      if (!a || !b) return ''
      const missing = model.nodes.find((n) => n.id === e.target)?.file?.missing
      return `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(
        1
      )}" stroke="${missing ? '#f87171' : '#334155'}" stroke-opacity="${(0.35 + e.confidence * 0.5).toFixed(
        2
      )}" stroke-width="${(0.6 + e.confidence * 1.6).toFixed(2)}"${missing ? ' stroke-dasharray="4 3"' : ''} data-s="${esc(
        e.source
      )}" data-t="${esc(e.target)}"/>`
    })
    .join('\n')

  const circles = model.nodes
    .map((n) => {
      const p = layout.positions[n.id]
      if (!p) return ''
      const detail = n.file
        ? `路径：${n.file.fullPath}&#10;大小：${(n.file.sizeBytes / 1024).toFixed(1)} KB&#10;${
            n.file.missing ? '⚠️ 文件缺失' : '置信度：' + String(model.edges.find((e) => e.target === n.id)?.confidence ?? 0)
          }`
        : n.label
      return `<g class="nd" data-id="${esc(n.id)}" data-name="${esc(n.label)}" data-detail="${esc(detail)}">
  <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${n.radius}" fill="${
        n.type === 'software' ? COLOR.software : n.file?.missing ? '#f87171' : COLOR[n.type] ?? COLOR.file
      }" fill-opacity="0.9"/>
  <title>${esc(detail)}</title>
</g>`
    })
    .join('\n')

  const labels = model.nodes
    .filter((n) => n.type === 'software' || n.radius >= 14)
    .map((n) => {
      const p = layout.positions[n.id]
      if (!p) return ''
      return `<text x="${p.x.toFixed(1)}" y="${(p.y + n.radius + 12).toFixed(1)}" text-anchor="middle">${esc(
        n.label.slice(0, 24)
      )}</text>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>SoftGraph 依赖图谱 — ${esc(sw.name)}</title>
<style>
  body { margin:0; background:#0b1220; color:#e2e8f0; font-family: 'Segoe UI', system-ui, sans-serif; overflow:hidden; }
  header { position:fixed; top:0; left:0; right:0; padding:10px 16px; background:rgba(11,18,32,.85);
           border-bottom:1px solid #1e293b; z-index:10; }
  header h1 { margin:0; font-size:15px; font-weight:600; }
  header .meta { font-size:11px; color:#94a3b8; margin-top:2px; }
  svg { display:block; cursor:grab; }
  svg:active { cursor:grabbing; }
  .nd { cursor:pointer; }
  .nd:hover circle { stroke:#f1f5f9; stroke-width:2; }
  text { fill:#94a3b8; font-size:10px; pointer-events:none; }
  #tip { position:fixed; display:none; max-width:420px; background:#111a2c; border:1px solid #334155;
         border-radius:8px; padding:8px 10px; font-size:11px; line-height:1.6; z-index:20;
         white-space:pre-wrap; word-break:break-all; pointer-events:none; }
  #legend { position:fixed; bottom:12px; left:16px; font-size:11px; color:#94a3b8; }
  .k { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; }
</style>
</head>
<body>
<header>
  <h1>${esc(sw.name)} ${esc(sw.version)} — 依赖图谱</h1>
  <div class="meta">${model.stats.nodeCount} 节点 · ${model.stats.edgeCount} 边 · 缺失 ${model.stats.missingCount} · 滚轮缩放 / 拖拽平移 / 悬停查看详情</div>
</header>
<svg id="g" viewBox="${minX} ${minY} ${width} ${height}">
${lines}
${circles}
${labels}
</svg>
<div id="tip"></div>
<div id="legend">
  <span class="k" style="background:#22d3ee"></span>软件
  <span class="k" style="background:#38bdf8"></span>依赖文件
  <span class="k" style="background:#f87171"></span>缺失
</div>
<script>
(function () {
  var svg = document.getElementById('g');
  var vb = svg.viewBox.baseVal;
  var tip = document.getElementById('tip');
  // 滚轮缩放（以鼠标位置为锚点）
  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var k = e.deltaY < 0 ? 0.85 : 1.18;
    var pt = cursorPoint(e);
    vb.x = pt.x - (pt.x - vb.x) * k;
    vb.y = pt.y - (pt.y - vb.y) * k;
    vb.width *= k; vb.height *= k;
  }, { passive: false });
  // 拖拽平移
  var drag = null;
  svg.addEventListener('mousedown', function (e) { drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    var s = vb.width / svg.clientWidth;
    vb.x = drag.vx - (e.clientX - drag.x) * s;
    vb.y = drag.vy - (e.clientY - drag.y) * s;
  });
  window.addEventListener('mouseup', function () { drag = null; });
  function cursorPoint(e) {
    var r = svg.getBoundingClientRect();
    return { x: vb.x + (e.clientX - r.left) / r.width * vb.width,
             y: vb.y + (e.clientY - r.top) / r.height * vb.height };
  }
  // 悬停详情
  svg.addEventListener('mousemove', function (e) {
    var g = e.target.closest ? e.target.closest('.nd') : null;
    if (!g) { tip.style.display = 'none'; return; }
    tip.textContent = g.getAttribute('data-name') + '\\n' + g.getAttribute('data-detail');
    tip.style.display = 'block';
    tip.style.left = Math.min(e.clientX + 14, innerWidth - 440) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  });
  svg.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
})();
</script>
</body>
</html>`
}
