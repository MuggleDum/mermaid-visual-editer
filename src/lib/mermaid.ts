// Mermaid 渲染封装 — 需求 §4.1.1 同步规则:
//   源码区输入 → 防抖 300ms → Mermaid.parse → 渲染 SVG
//   解析失败 → 画布保留上次成功状态 + 返回错误信息
import mermaid from 'mermaid'

let initialized = false
let currentTheme: 'light' | 'dark' = 'light'

/** 随应用主题切换 Mermaid 渲染主题:light → default, dark → dark */
export function setMermaidTheme(theme: 'light' | 'dark') {
  if (currentTheme === theme && initialized) return
  currentTheme = theme
  initialized = false
  ensureInit()
}

function ensureInit() {
  if (initialized) return
  mermaid.initialize({
    startOnLoad: false,
    theme: currentTheme === 'dark' ? 'dark' : 'default',
    securityLevel: 'loose',
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
  })
  initialized = true
}

export type RenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string; line?: number }

// 解析 Mermaid 源码,返回 SVG 或错误
// 这里故意捕获所有异常,不让错误冒泡到 React
export async function renderMermaid(source: string): Promise<RenderResult> {
  ensureInit()
  if (!source.trim()) {
    return { ok: true, svg: '' }
  }
  try {
    // mermaid v11 推荐用 parse + render 分两步,parse 拿错误位置
    await mermaid.parse(source)
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { svg } = await mermaid.render(id, source)
    return { ok: true, svg }
  } catch (e: any) {
    // mermaid 错误形如 "syntax error at line 5: ..."
    const message = String(e?.message ?? e)
    const lineMatch = message.match(/line\s+(\d+)/i)
    return { ok: false, error: message, line: lineMatch ? Number(lineMatch[1]) : undefined }
  }
}

// 从 SVG 字符串里提取每个节点的 (x, y) 坐标
// 节点 group id 在 mermaid 输出里形如 "flowchart-A-1", 取最后一段作为节点 id
export function extractNodePositions(svg: string): Record<string, { x: number; y: number }> {
  const map: Record<string, { x: number; y: number }> = {}
  if (!svg) return map
  // 简单正则: <g class="nodes ..."> 里的 <g id="flowchart-{id}-{n}" transform="translate(x, y)">
  const gRe = /<g\s+id="flowchart-([A-Za-z0-9_]+)-\d+"\s+class="[^"]*"\s+transform="translate\(([^,)]+),\s*([^)]+)\)"/g
  let m: RegExpExecArray | null
  while ((m = gRe.exec(svg)) !== null) {
    const id = m[1]
    const x = parseFloat(m[2])
    const y = parseFloat(m[3])
    if (!Number.isNaN(x) && !Number.isNaN(y)) {
      map[id] = { x, y }
    }
  }
  return map
}
