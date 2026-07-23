// 核心数据类型 — 对应需求 §4.1.2 / §4.2
export type FileState = {
  id: string
  name: string
  mermaidSource: string
  /** 用户拖拽产生的位置覆盖 — 需求 §4.1.3:运行时不回写源码 */
  layoutOverrides: { [nodeId: string]: { x: number; y: number } }
  updatedAt: number
  /** 画布视口状态(缩放/平移) — 切换文件时恢复 */
  viewport?: { zoom: number; panX: number; panY: number }
}

// 节点形状 — §4.2.1 形状映射表
export type NodeShape = 'rect' | 'round' | 'ellipse' | 'circle' | 'diamond' | 'parallelogram' | 'hexagon' | 'trapezoid'

// 形状 ↔ Mermaid 包裹符 — §4.2.1
export const SHAPE_DEFS: { shape: NodeShape; key: string; label: string; open: string; close: string; cursor: string }[] = [
  { shape: 'rect',        key: 'R', label: '矩形',         open: '[',  close: ']',  cursor: 'rect' },
  { shape: 'round',       key: 'O', label: '圆角矩形',     open: '(',  close: ')',  cursor: 'round' },
  { shape: 'ellipse',     key: 'E', label: '椭圆',         open: '([', close: '])', cursor: 'ellipse' },
  { shape: 'circle',      key: 'C', label: '圆形',         open: '((', close: '))', cursor: 'circle' },
  { shape: 'diamond',     key: 'D', label: '菱形',         open: '{',  close: '}',  cursor: 'diamond' },
  { shape: 'parallelogram', key: 'P', label: '平行四边形', open: '[/', close: '/]', cursor: 'parallelogram' },
  { shape: 'hexagon',     key: 'H', label: '六边形',       open: '{{', close: '}}', cursor: 'hexagon' },
  { shape: 'trapezoid',   key: 'T', label: '梯形',         open: '[\\', close: '\\]', cursor: 'trapezoid' },
]

export const SHAPE_BY_KEY: Record<string, NodeShape> = Object.fromEntries(
  SHAPE_DEFS.map((d) => [d.key, d.shape])
)

/** 解析节点声明的形状 — 用于「改形状」前的状态识别 */
export function shapeFromBrackets(open: string, close: string): NodeShape | 'unknown' {
  const norm = (s: string) => s.replace(/\\/g, '\\')
  for (const d of SHAPE_DEFS) {
    if (norm(d.open) === norm(open) && norm(d.close) === norm(close)) {
      return d.shape
    }
  }
  return 'unknown'
}

// 画布内存模型(从 mermaidSource 解析得到)
// 节点 / 边都从源码解析,运行时在内存里加上临时 ID、坐标
export type CanvasNode = {
  /** 内存中的节点 ID,优先用源码显式声明,否则 n1/n2... */
  id: string
  /** 是否临时 ID(只内存用) */
  ephemeral: boolean
  text: string
  shape: NodeShape | 'unknown'
  /** 来自 layoutOverrides(已应用) 或 来自 SVG 读出的原始坐标 */
  x: number
  y: number
  /** 节点在源码里出现的行号,便于回写时定位 */
  sourceLine?: number
}

export type CanvasEdge = {
  from: string
  to: string
  label?: string
  /** 解析时检测到的形状(用于「两端形状不同弹窗」) */
  fromShape?: NodeShape | 'unknown'
  toShape?: NodeShape | 'unknown'
}

export type CanvasModel = {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

// 选中元素
export type Selection =
  | { kind: 'none' }
  | { kind: 'node'; ids: string[] }
  | { kind: 'edge'; from: string; to: string; label?: string }

// 解析错误
export type ParseError = { line: number; message: string } | null

/** 当前"形状选择"态 — §4.2.1「选形状」 */
export type ShapePickState =
  | { mode: 'idle' }
  | { mode: 'pick-shape'; target: 'new' | { ids: string[] }; shape: NodeShape }
