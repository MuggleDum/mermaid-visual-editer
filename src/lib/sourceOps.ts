// 源码解析 / 回写 — 需求 §4.1 / §4.2
//
// 关键不变量(从需求里直接提炼):
//   1. mermaidSource 是真相之源 — 任何"画布 → 源码"操作都改它
//   2. 拖动节点不改源码,只改 layoutOverrides — §4.1.3
//   3. 没有显式 ID 的节点,解析时补 n1/n2 临时 ID,只内存用 — §4.1.4
//   4. 导出/复制源码时才把 layoutOverrides 写成 %% @pos 注释 — §4.1.3
//
// 因为 mermaid 解析器对 flowchart 的解析结果不能直接拿 ID 列表(它只输出 SVG),
// 这里用一个**手写的小解析器**:识别 flowchart TD 块里的"节点声明"和"边声明"行,
// 满足画布所需即可,不求完整覆盖 mermaid 全部语法。

import type { CanvasModel, CanvasNode, CanvasEdge, NodeShape, FileState } from '../types'
import { SHAPE_DEFS, shapeFromBrackets } from '../types'

// ============================================================
// 解析: mermaidSource → CanvasModel
// ============================================================

type Decl =
  | { kind: 'node'; line: number; id?: string; shape: NodeShape | 'unknown'; text: string; edgeTo?: string; edgeLabel?: string }
  | { kind: 'edge'; line: number; from: string; to: string; label?: string }

const NODE_RE = /^\s*(?:(\w+))?\s*([(\[{]{1,2}|[(]\()\s*(.+?)\s*([)\]}]+|[\])]\))/;
const EDGE_RE = /^\s*(\w+)\s*(?:--+>|=+>|--+|-\.->)\s*(?:\|([^|]*)\|\s*)?(\w+)\s*$/;
// "A[开始] --> B" 这种行 — 显式声明 + 边的组合
// 注意:字符类里 [ 和 { 必须转义(否则 { 是量词的开始)
const NODE_AND_EDGE_RE = /^\s*(\w+)\s*([(\[{])\s*(.+?)\s*([)\]}])\s*(?:--+>|=+>|--+|-\.->)\s*(?:\|([^|]*)\|\s*)?(\w+)\s*(?:\s*-->\s*(?:\|([^|]*)\|\s*)?(\w+))?\s*$/;
// "B -->|是| C[处理 A]" 这种行 — 边(可能带标签) + 目标节点声明(无前置节点声明)
// 即:首个词没有括号,但末尾有节点声明
const EDGE_AND_NODE_RE = /^\s*(\w+)\s*(?:--+>|=+>|--+|-\.->)\s*(?:\|([^|]*)\|\s*)?(\w+)\s*([(\[{])\s*(.+?)\s*([)\]}])\s*$/;
// 单行节点声明(A[开始])
const NODE_ONLY_RE = /^\s*(?:(\w+))?\s*([(\[{])\s*(.+?)\s*([)\]}])\s*$/;

function parseLine(line: string, lineNo: number, allIds: Set<string>): Decl | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('%%')) return null
  if (/^(?:flowchart|graph)\s/i.test(trimmed)) return null
  if (/^(?:subgraph|end)\b/i.test(trimmed)) return null

  // "A[开始] --> B" 这种单行声明 + 边 — 拆成两个 decl
  const neMatch = trimmed.match(NODE_AND_EDGE_RE)
  if (neMatch) {
    const id = neMatch[1]
    const open = neMatch[2]
    const text = neMatch[3].trim()
    const close = neMatch[4]
    const shape = shapeFromBrackets(open, close)
    if (id) allIds.add(id)
    // 把节点 + 边分别推入 decls — 用一个 hack:返回第一个(节点),后续 parseLine 不会再处理这一行
    // 但 parseLine 一次只返回一个 Decl — 这里用 side-effect 不可行。
    // 简单:在 parseSource 主循环里检测 NODE_AND_EDGE_RE
    return { kind: 'node', line: lineNo, id, shape, text, edgeTo: neMatch[6], edgeLabel: neMatch[5] } as any
  }

  // "B -->|是| C[处理 A]" 这种行 — 边(可能带标签) + 目标节点声明
  const enMatch = trimmed.match(EDGE_AND_NODE_RE)
  if (enMatch) {
    const from = enMatch[1]
    const label = enMatch[2]
    const to = enMatch[3]
    const nodeOpen = enMatch[4]
    const nodeText = enMatch[5].trim()
    const nodeClose = enMatch[6]
    if (to) allIds.add(to)
    // 返回一个特殊 decl,同时包含边信息和节点信息
    return { kind: 'edge-and-node', line: lineNo, from, label, to, nodeId: to, nodeText, nodeShape: shapeFromBrackets(nodeOpen, nodeClose) } as any
  }

  // 边
  const edgeMatch = trimmed.match(EDGE_RE)
  if (edgeMatch) {
    return {
      kind: 'edge',
      line: lineNo,
      from: edgeMatch[1],
      to: edgeMatch[3],
      label: edgeMatch[2],
    }
  }

  // 节点声明
  const nodeMatch = trimmed.match(NODE_RE)
  if (nodeMatch) {
    const id = nodeMatch[1]
    const open = nodeMatch[2]
    const text = nodeMatch[3].trim()
    const close = nodeMatch[4]
    const shape = shapeFromBrackets(open, close)
    if (id) allIds.add(id)
    return { kind: 'node', line: lineNo, id, shape, text }
  }

  return null
}

export function parseSource(source: string): CanvasModel {
  const lines = source.split('\n')
  const allIds = new Set<string>()
  const decls: Decl[] = []
  for (let i = 0; i < lines.length; i++) {
    const d = parseLine(lines[i], i, allIds)
    if (d) decls.push(d)
  }

  // 收集所有出现的 ID(节点声明 + 边两端)
  const idsAppearing = new Set<string>()
  for (const d of decls) {
    if (d.kind === 'node' && d.id) {
      idsAppearing.add(d.id)
      if (d.edgeTo) idsAppearing.add(d.edgeTo)
    }
    if (d.kind === 'edge') {
      idsAppearing.add(d.from)
      idsAppearing.add(d.to)
    }
    if (d.kind === 'edge-and-node') {
      idsAppearing.add(d.from)
      idsAppearing.add(d.to)
    }
  }

  // 节点列表
  const nodeMap = new Map<string, CanvasNode>()
  // 旧的 n1/n2 临时 ID 分配 — 当前通过 DOM 优先(model useMemo)修正,这里保留 n 系列
  let tmpCounter = 0
  // 把节点声明里 edgeTo 用的 ID 加进 allIds,避免临时分配冲突
  for (const d of decls) {
    if (d.kind === 'node' && d.edgeTo) allIds.add(d.edgeTo)
  }
  for (const d of decls) {
    if (d.kind !== 'node') continue
    let id: string
    let ephemeral = false
    if (d.id) {
      id = d.id
    } else {
      // 没声明 ID:补 n1/n2... 临时 ID(CanvasView 会用 DOM 实际 ID 覆盖)
      do {
        tmpCounter++
        id = `n${tmpCounter}`
      } while (allIds.has(id) || nodeMap.has(id))
      ephemeral = true
    }
    if (!nodeMap.has(id)) {
      nodeMap.set(id, {
        id,
        ephemeral,
        text: d.text,
        shape: d.shape,
        x: 0,
        y: 0,
        sourceLine: d.line,
      })
    }
  }

  // 边列表 — 边两端的 ID 必然出现在某处
  const edges: CanvasEdge[] = []
  // 收集节点声明里携带的 edgeTo
  for (const d of decls) {
    if (d.kind === 'node' && d.id && d.edgeTo) {
      edges.push({
        from: d.id,
        to: d.edgeTo,
        label: d.edgeLabel,
      })
    }
  }
  // edge-and-node: 边 + 目标节点声明
  for (const d of decls) {
    if (d.kind !== 'edge-and-node') continue
    edges.push({
      from: d.from,
      to: d.to,
      label: d.label,
    })
    // 确保目标节点已创建
    if (!nodeMap.has(d.nodeId)) {
      nodeMap.set(d.nodeId, {
        id: d.nodeId,
        ephemeral: false,
        text: d.nodeText,
        shape: d.nodeShape as any,
        x: 0,
        y: 0,
        sourceLine: d.line,
      })
    }
  }
  for (const d of decls) {
    if (d.kind !== 'edge') continue
    const fromNode = nodeMap.get(d.from)
    const toNode = nodeMap.get(d.to)
    edges.push({
      from: d.from,
      to: d.to,
      label: d.label,
      fromShape: fromNode?.shape,
      toShape: toNode?.shape,
    })
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
  }
}

// ============================================================
// 回写:画布操作 → mermaidSource
// ============================================================

/** 找一个未占用的字母 ID(A..Z, AA..ZZ) */
function allocId(allIds: Set<string>, start: number = 0): string {
  for (let n = start; n < 26 * 27; n++) {
    let id: string
    if (n < 26) {
      id = String.fromCharCode(65 + n) // A..Z
    } else {
      const a = Math.floor(n / 26) - 1
      const b = n % 26
      id = String.fromCharCode(65 + a) + String.fromCharCode(65 + b) // AA..
    }
    if (!allIds.has(id)) return id
  }
  return `N${Date.now()}`
}

/** 当前源码中所有显式 ID */
function collectIds(source: string): Set<string> {
  const ids = new Set<string>()
  for (const line of source.split('\n')) {
    // 节点 ID:行首 word
    const m1 = line.match(/^\s*(\w+)\s*[(\[{]/)
    if (m1) ids.add(m1[1])
    // 边两端
    const m2 = line.match(/^\s*(\w+)\s*(?:--+>|=+>|--+|-\.->)\s*(?:\|[^|]*\|\s*)?(\w+)/)
    if (m2) {
      ids.add(m2[1])
      ids.add(m2[2])
    }
  }
  return ids
}

function shapeWrap(shape: NodeShape, text: string): string {
  const def = SHAPE_DEFS.find((d) => d.shape === shape)
  if (!def) return `[${text}]`
  // Mermaid 节点文本里换行用 <br/>
  const safe = text.replace(/\n/g, '<br/>')
  return `${def.open}${safe}${def.close}`
}

/** 把临时 ID 提升为显式 ID:在源码里把孤立的 [text] 节点声明前面加上 id=... */
function ensureIdDeclared(source: string, id: string, shape: NodeShape, text: string): string {
  // 简化:如果该 ID 已经出现,跳过;否则在文件末尾追加一个独立声明
  const ids = collectIds(source)
  if (ids.has(id)) return source
  const decl = `${id}${shapeWrap(shape, text)}`
  // 加在 flowchart 头之后的第一行
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) => /^(?:flowchart|graph)\s/i.test(l.trim()))
  if (headerIdx >= 0) {
    lines.splice(headerIdx + 1, 0, `    ${decl}`)
  } else {
    lines.unshift(`flowchart TD`, `    ${decl}`)
  }
  return lines.join('\n')
}

/** 节点增/改/删 后的新源码 — 直接覆盖为 "flowchart 头 + 所有显式节点声明 + 所有边" 的形式,简单可靠 */
function rebuildSource(model: CanvasModel): string {
  const ids = new Set<string>()
  const nodeLines: string[] = []
  for (const n of model.nodes) {
    if (n.ephemeral) continue // 临时 ID 不回写
    ids.add(n.id)
    nodeLines.push(`    ${n.id}${shapeWrap(n.shape === 'unknown' ? 'rect' : n.shape, n.text)}`)
  }
  const edgeLines: string[] = []
  for (const e of model.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    let line = `    ${e.from} --> ${e.to}`
    if (e.label) line = `    ${e.from} -->|${e.label}| ${e.to}`
    edgeLines.push(line)
  }
  return ['flowchart TD', ...nodeLines, ...edgeLines].join('\n') + '\n'
}

/** 在源码末尾追加新节点 + 可选边 */
export function addNode(
  source: string,
  shape: NodeShape,
  text: string,
  connectTo?: { from?: string; to?: string }
): { source: string; id: string } {
  const ids = collectIds(source)
  const id = allocId(ids, 0)
  const decl = `${id}${shapeWrap(shape, text)}`
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) => /^(?:flowchart|graph)\s/i.test(l.trim()))
  // 找到最后一个 flowchart 块的最后一行(以 end / subgraph 边界简化:直接追加到末尾)
  const insertIdx = headerIdx >= 0 ? headerIdx + 1 : 0
  lines.splice(insertIdx, 0, `    ${decl}`)
  // 加边
  if (connectTo?.from) {
    lines.splice(insertIdx + 1, 0, `    ${connectTo.from} --> ${id}`)
  }
  if (connectTo?.to) {
    lines.splice(insertIdx + 1, 0, `    ${id} --> ${connectTo.to}`)
  }
  return { source: lines.join('\n'), id }
}

/** 加边(节点 ID 必须已存在) */
export function addEdge(
  source: string,
  from: string,
  to: string,
  label?: string
): string {
  const decl = label ? `    ${from} -->|${label}| ${to}` : `    ${from} --> ${to}`
  return source.trimEnd() + '\n' + decl + '\n'
}

/** 删节点 + 相连的边 */
export function removeNode(source: string, id: string): string {
  const lines = source.split('\n')
  const next = lines.filter((l) => {
    const t = l.trim()
    if (!t || t.startsWith('%%')) return true
    // 跳过纯节点声明行
    const m = t.match(/^(\w+)\s*[(\[{]/)
    if (m && m[1] === id) return false
    // 跳过引用了 id 的边
    const em = t.match(/^(\w+)\s*(?:--+>|=+>|--+|-\.->)\s*(?:\|[^|]*\|\s*)?(\w+)/)
    if (em && (em[1] === id || em[2] === id)) return false
    return true
  })
  return next.join('\n')
}

/** 删边 — 支持按 label 精确匹配,解决多条边时删错行的问题 */
export function removeEdge(source: string, from: string, to: string, label?: string): string {
  const lines = source.split('\n')
  const next = lines.filter((l) => {
    const t = l.trim()
    if (!t || t.startsWith('%%')) return true
    const m = t.match(/^(\w+)\s*(-->|=+>|---|\.->)\s*(?:\|([^|]*)\|\s*)?(\w+)/)
    if (!m) return true
    if (m[1] === from && m[4] === to) {
      if (label === undefined) return false
      // label='' 时匹配无标签边(m[3]为undefined); label有值时精确匹配
      if (m[3] === label || (label === '' && m[3] === undefined)) return false
    }
    return true
  })
  return next.join('\n')
}

/** 改节点文本 — 保留 ID 和形状,支持行内节点声明(如 A[开始] --> B{条件判断} 中的 B) */
export function setNodeText(source: string, id: string, text: string): string {
  const lines = source.split('\n')
  // 匹配: 指定ID + 开括号 + 文本 + 闭括号,不限于行首
  const nodeDeclRe = new RegExp(
    `(${id})\\s*([(\\[{]{1,2}|[(]\\()\\s*(.*?)\\s*([)\\]}]+|[\\])]\\))`
  )
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]
    if (!t.trim() || t.trim().startsWith('%%')) continue
    const m = t.match(nodeDeclRe)
    if (m && m[1] === id) {
      lines[i] = t.replace(m[0], `${id}${m[2]}${text}${m[4]}`)
      return lines.join('\n')
    }
  }
  return source
}

/** 改节点形状 — 保留 ID 和文本,支持行内节点声明,不动 %% @pos */
export function setNodeShape(source: string, id: string, shape: NodeShape): string {
  const lines = source.split('\n')
  const nodeDeclRe = new RegExp(
    `(${id})\\s*([(\\[{]{1,2}|[(]\\()\\s*(.*?)\\s*([)\\]}]+|[\\])]\\))`
  )
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]
    if (!t.trim() || t.trim().startsWith('%%')) continue
    const m = t.match(nodeDeclRe)
    if (m && m[1] === id) {
      lines[i] = t.replace(m[0], `${id}${shapeWrap(shape, m[3])}`)
      return lines.join('\n')
    }
  }
  return source
}

/** 改边标签 — 支持按旧标签匹配,解决多条边时改错行的问题
 *  同时保留节点声明(如 A[开始] --> B{条件判断} 中的 [开始] 和 {条件判断}) */
export function setEdgeLabel(source: string, from: string, to: string, label: string, oldLabel?: string): string {
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('%%')) continue
    // 匹配: from [可选声明] --> [可选|label|] to [可选声明]
    // 使用 (.*?) 非贪婪匹配 from 后的声明, (.*) 贪婪匹配 to 后的声明
    const m = t.match(/^(\w+)(.*?)\s*-->\s*(?:\|([^|]*)\|\s*)?(\w+)(.*)$/)
    if (m && m[1] === from && m[4] === to) {
      // 如果指定了旧标签,跳过不匹配的行
      if (oldLabel !== undefined && (m[3] ?? '') !== oldLabel) continue
      const indent = ' '.repeat(lines[i].length - lines[i].trimStart().length)
      const fromDecl = m[2] || ''
      const toDecl = m[5] || ''
      if (label) {
        lines[i] = `${indent}${from}${fromDecl} -->|${label}| ${to}${toDecl}`
      } else {
        lines[i] = `${indent}${from}${fromDecl} --> ${to}${toDecl}`
      }
      return lines.join('\n')
    }
  }
  return source
}

/** 用整个 model 重建源码(用于「画图取源码」导出的内部中间步骤) */
export function serializeFromModel(model: CanvasModel): string {
  return rebuildSource(model)
}

// ============================================================
// %% @pos 注入 / 提取 — §4.1.3
// ============================================================

/** 从已渲染的 SVG 中读取每个节点的 (x, y),与 layoutOverrides 叠加
 *  优先级:%% @pos 注释 > layoutOverrides > SVG 读出的位置
 *  对应需求 §4.1.3 — 注释优先,无注释时用 Mermaid 自带布局
 */
export function mergePositionsFromSvg(
  model: CanvasModel,
  svg: string,
  overrides: FileState['layoutOverrides'],
  commentPositions?: Record<string, { x: number; y: number }>
): CanvasModel {
  const re = /<g\s+id="flowchart-([A-Za-z0-9_]+)-\d+"\s+class="[^"]*"\s+transform="translate\(([^,)]+),\s*([^)]+)\)"/g
  const svgPos = new Map<string, { x: number; y: number }>()
  let m: RegExpExecArray | null
  while ((m = re.exec(svg)) !== null) {
    svgPos.set(m[1], { x: parseFloat(m[2]), y: parseFloat(m[3]) })
  }
  return {
    nodes: model.nodes.map((n) => {
      const cp = commentPositions?.[n.id]
      if (cp) return { ...n, x: cp.x, y: cp.y }
      const override = overrides[n.id]
      if (override) return { ...n, x: override.x, y: override.y }
      const sp = svgPos.get(n.id)
      if (sp) return { ...n, x: sp.x, y: sp.y }
      return n
    }),
    edges: model.edges,
  }
}

/** 把 layoutOverrides 写成 %% @pos 注释,插在节点声明上方 */
export function injectPositions(source: string, positions: Record<string, { x: number; y: number }>): string {
  if (Object.keys(positions).length === 0) return source
  const lines = source.split('\n')
  const out: string[] = []
  for (const line of lines) {
    const t = line.trim()
    if (t && !t.startsWith('%%')) {
      const m = t.match(/^(\w+)\s*[(\[{]/)
      if (m && positions[m[1]]) {
        const p = positions[m[1]]
        out.push(`    %% @pos ${JSON.stringify(p)}`)
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * 从源码中解析 %% @pos 注释 — 需求 §4.1.3
 * 注释格式:%% @pos {"x":120,"y":80}
 * 注释必须紧贴其下方的节点声明
 */
export function parsePositionsFromComments(source: string): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  const lines = source.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    const t = lines[i].trim()
    const next = lines[i + 1].trim()
    if (!t.startsWith('%%')) continue
    const m = t.match(/%%\s*@pos\s+(\{[^}]+\})/)
    if (!m) continue
    try {
      const p = JSON.parse(m[1])
      if (typeof p.x === 'number' && typeof p.y === 'number') {
        // 紧跟的下一行必须是节点声明,取其 ID
        const nm = next.match(/^(\w+)\s*[(\[{]/)
        if (nm) out[nm[1]] = { x: p.x, y: p.y }
      }
    } catch {
      // 忽略格式错误的注释
    }
  }
  return out
}

/** 导出/复制源码 = 当前源码 + layoutOverrides 写为 %% @pos */
export function exportSource(file: FileState): string {
  return injectPositions(file.mermaidSource, file.layoutOverrides)
}

/** 给临时 ID 节点提升为显式 ID(让 layoutOverrides 能稳定绑定) */
export function promoteEphemeralId(
  source: string,
  _ephemeralId: string,
  realId: string,
  shape: NodeShape,
  text: string
): { source: string; promotedId: string } {
  // 在源码末尾追加一个显式声明,然后从 model 里把这个临时节点换掉
  // 这里只在源码层面追加声明,CanvasModel 那边由调用者同步
  const ids = collectIds(source)
  if (ids.has(realId)) return { source, promotedId: realId }
  const decl = `${realId}${shapeWrap(shape, text)}`
  return {
    source: source.trimEnd() + '\n' + `    ${decl}` + '\n',
    promotedId: realId,
  }
}

export { ensureIdDeclared }
