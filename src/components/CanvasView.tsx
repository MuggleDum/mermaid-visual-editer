// 画布区 — 实现需求 §4.2 全部交互
//
// 职责:
//   1. 渲染 Mermaid 输出的 SVG
//   2. 节点 / 边的选中 / 拖动 / 连线 / 改文本 / 增删
//   3. 形状选择态(进入"待落点"模式)
//   4. 视口缩放/平移
//
// 设计:
//   - 本组件"只读地"渲染 SVG,所有交互通过回调上抛给父组件
//   - 父组件用 mermaidSource 改回去完成"画布 → 源码"回路
//   - 拖动用 layoutOverrides — 通过 onLayoutChange 上抛

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { renderMermaid } from '../lib/mermaid'
import { parseSource, mergePositionsFromSvg, parsePositionsFromComments, addNode, addEdge, removeNode, removeEdge, setNodeText, setNodeShape, setEdgeLabel } from '../lib/sourceOps'
import type {
  FileState,
  CanvasNode,
  CanvasModel,
  CanvasEdge,
  Selection,
  NodeShape,
  ShapePickState,
  ParseError,
} from '../types'
import { SHAPE_DEFS, SHAPE_BY_KEY } from '../types'

type Props = {
  file: FileState
  selection: Selection
  pickState: ShapePickState
  viewport: { zoom: number; panX: number; panY: number }
  renderVersion: number
  onSourceChange: (next: string) => void
  onLayoutChange: (next: FileState['layoutOverrides']) => void
  onSelectionChange: (s: Selection) => void
  onPickStateChange: (p: ShapePickState) => void
  onViewportChange: (v: { zoom: number; panX: number; panY: number }) => void
  onError: (e: ParseError) => void
  onToast: (msg: string) => void
}

export function CanvasView({
  file,
  selection,
  pickState,
  viewport,
  renderVersion,
  onSourceChange,
  onLayoutChange,
  onSelectionChange,
  onPickStateChange,
  onViewportChange,
  onError,
  onToast,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [rendering, setRendering] = useState(false)
  // 拖动中:哪个节点,起点,当前位置
  const dragRef = useRef<null | {
    type: 'node' | 'pan' | 'edge-endpoint' | 'edge-create'
    nodeId?: string
    startX: number
    startY: number
    originX: number
    originY: number
    fromNodeId?: string
    intent?: 'undecided' | 'move' | 'connect'
    hoverNodeId?: string
  }>(null)
  const [editingText, setEditingText] = useState<null | { id: string; value: string }>(null)
  const [editingEdgeLabel, setEditingEdgeLabel] = useState<null | { from: string; to: string; value: string; oldLabel?: string }>(null)
  const [dragLine, setDragLine] = useState<null | { x1: number; y1: number; x2: number; y2: number }>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<null | { kind: 'node'; ids: string[] } | { kind: 'edge'; from: string; to: string; label?: string }>(null)

  // 工具函数:数组比较
  const arraysEqual = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

  // ==================== 渲染:源码 → SVG ====================
  // svgReady:在 SVG 真正渲染到 DOM 后才设为 true,用于触发 model useMemo 重算(DOM 优先)
  const [svgReady, setSvgReady] = useState(false)
  useEffect(() => {
    if (!file.mermaidSource.trim()) {
      setSvg('')
      onError(null)
      return
    }
    const timer = window.setTimeout(async () => {
      setRendering(true)
      const result = await renderMermaid(file.mermaidSource)
      setRendering(false)
      if (result.ok) {
        setSvg(result.svg)
        onError(null)
      } else {
        onError({ line: result.line ?? 0, message: result.error })
      }
    }, 300)
    return () => window.clearTimeout(timer)
  }, [file.mermaidSource, onError, renderVersion])

  // ==================== 模型:源码 + 坐标 ====================
  const model = useMemo(() => {
    const base = parseSource(file.mermaidSource)
    if (!svg) return base
    // 注释优先 — 需求 §4.1.3
    const commentPositions = parsePositionsFromComments(file.mermaidSource)
    const withPositions = mergePositionsFromSvg(base, svg, file.layoutOverrides, commentPositions)
    // DOM 优先 — 重要:mermaid 给"裸节点"(无显式 ID)分配的字母 ID 与 parseSource 不一致,
    // 必须以 DOM 实际渲染的 g[id*="flowchart-X-N"] 的 X 为准。
    if (!wrapRef.current) return withPositions
    const domIds = new Set<string>()
    wrapRef.current.querySelectorAll<SVGGElement>('g[data-node-id]').forEach((g) => {
      const id = g.getAttribute('data-node-id')
      if (id) domIds.add(id)
    })
    if (domIds.size === 0) return withPositions
    // 重建 model:以 DOM 节点为骨架,信息优先顺序 DOM text > parseSource text
    const byId = new Map(withPositions.nodes.map((n) => [n.id, n]))
    const newNodes: typeof withPositions.nodes = []
    domIds.forEach((id) => {
      const existing = byId.get(id)
      if (existing) {
        newNodes.push(existing)
      } else {
        // DOM 里有,parseSource 没有 — 创建一个占位
        const domEl = wrapRef.current?.querySelector(`g[data-node-id="${id}"]`)
        const text = (domEl?.textContent || id).trim().slice(0, 50)
        newNodes.push({ id, ephemeral: false, text, shape: 'unknown', x: 0, y: 0, sourceLine: 0 })
      }
    })
    // 边不变
    return { ...withPositions, nodes: newNodes }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.mermaidSource, file.layoutOverrides, svg, svgReady])

  // 节点 ID → DOM 元素(用 mermaid 输出的 g 反查,11.x id 形如 mermaid-...-flowchart-X-N)
  const svgNodeMapRef = useRef<Map<string, SVGGElement>>(new Map())
  useEffect(() => {
    if (!wrapRef.current) return
    const map = new Map<string, SVGGElement>()
    wrapRef.current.querySelectorAll<SVGGElement>('g[data-node-id]').forEach((g) => {
      const id = g.getAttribute('data-node-id')
      if (id) map.set(id, g)
    })
    svgNodeMapRef.current = map
  }, [svg])

  // 注入 data-* 属性后的最终 SVG HTML — 缓存,避免每次 render 返回新字符串
  // 导致 dangerouslySetInnerHTML 销毁并重建整个 SVG 内部 DOM(dblclick 会丢)
  // 用 state 缓存,只在 svg 字符串变化时重算。使用 modelRef 确保始终拿到最新 model
  const modelRef = useRef(model)
  modelRef.current = model
  const [svgHtml, setSvgHtml] = useState('')
  useEffect(() => {
    if (!svg) { setSvgHtml(''); return }
    setSvgHtml(injectNodeDataAttrs(svg, modelRef.current.nodes, modelRef.current.edges))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg])

  // dangerouslySetInnerHTML 需要稳定对象引用,否则 React 每次都会重新设置 innerHTML
  const innerHtmlObj = useMemo(() => ({ __html: svgHtml }), [svgHtml])

  // SVG 真正写入 DOM 后(浏览器下一帧),通知 model 重新跑 DOM 优先逻辑
  useEffect(() => {
    if (!svgHtml) {
      setSvgReady(false)
      return
    }
    // 先置 false 强制 model 在新 DOM 提交后重算(否则 model 里 DOM 优先逻辑
    // 读到的是旧 DOM 的 data-node-id,会漏掉新节点)
    setSvgReady(false)
    const t = requestAnimationFrame(() => {
      setSvgReady(true)
    })
    return () => cancelAnimationFrame(t)
  }, [svgHtml])

  // ==================== 坐标换算(SVG 坐标系 ↔ 屏幕)— 当前未用,保留以备后续精确落点 ====================
  // const screenToSvg = useCallback(
  //   (clientX: number, clientY: number) => {
  //     const el = wrapRef.current
  //     if (!el) return { x: 0, y: 0 }
  //     const rect = el.getBoundingClientRect()
  //     const svgEl = el.querySelector('svg') as SVGSVGElement | null
  //     if (!svgEl) return { x: 0, y: 0 }
  //     const vb = svgEl.viewBox.baseVal
  //     const xRatio = vb.width / rect.width
  //     const yRatio = vb.height / rect.height
  //     const sx = (clientX - rect.left) / viewport.zoom
  //     const sy = (clientY - rect.top) / viewport.zoom
  //     return {
  //       x: sx * xRatio + vb.x - viewport.panX * xRatio,
  //       y: sy * yRatio + vb.y - viewport.panY * yRatio,
  //     }
  //   },
  //   [viewport]
  // )

  // ==================== 选中辅助 ====================
  const isNodeSelected = (id: string) =>
    selection.kind === 'node' && selection.ids.includes(id)
  // 上下游边高亮 — §4.2.1
  const isEdgeRelated = (from: string, to: string) => {
    if (selection.kind === 'node' && selection.ids.length > 0) {
      return selection.ids.includes(from) || selection.ids.includes(to)
    }
    if (selection.kind === 'edge' && selection.from === from && selection.to === to) {
      return true
    }
    return false
  }
  const isNodeFaded = (id: string) => {
    if (selection.kind !== 'node' || selection.ids.length === 0) return false
    return !selection.ids.includes(id)
  }
  const isEdgeFaded = (e: CanvasEdge) => {
    if (selection.kind === 'node' && selection.ids.length > 0) {
      return !selection.ids.includes(e.from) && !selection.ids.includes(e.to)
    }
    if (selection.kind === 'edge') {
      return !(selection.from === e.from && selection.to === e.to)
    }
    return false
  }

  // 选区样式注入到 SVG
  useEffect(() => {
    if (!wrapRef.current) return
    const root = wrapRef.current
    // 节点
    root.querySelectorAll<SVGGElement>('g.node').forEach((g) => {
      const id = g.getAttribute('data-node-id')
      if (!id) return
      if (isNodeSelected(id)) g.classList.add('cv-selected')
      else g.classList.remove('cv-selected')
      if (isNodeFaded(id)) g.classList.add('cv-faded')
      else g.classList.remove('cv-faded')
    })
    // 边 — mermaid 11.x 是 path,老版是 g
    // 只对可见边(非透明 hit-path)加高亮类
    root.querySelectorAll<SVGElement>('[data-edge-from]').forEach((g) => {
      const from = g.getAttribute('data-edge-from')
      const to = g.getAttribute('data-edge-to')
      const raw = g.getAttribute('data-edge-label')
      // 对 g.label 元素,用文本内容作为标签(因为 Mermaid 把标签文本放在 data-edge-label="" 的 g.label 中)
      const textContent = (g.textContent || '').trim()
      const label = raw === '' && textContent ? textContent : (raw || undefined)
      if (!from || !to) return
      // 跳过透明 hit-path(它的 stroke 是 transparent)
      if (g.getAttribute('stroke') === 'transparent') return
      const e = { from, to } as CanvasEdge
      // 精确匹配:如果 selection 有 label,必须 label 一致;否则按 from/to 匹配
      const matchFromTo = selection.kind === 'edge' && selection.from === from && selection.to === to
      const matchLabel = matchFromTo && (selection.label === undefined || selection.label === label)
      if (matchLabel) g.classList.add('cv-selected')
      else g.classList.remove('cv-selected')
      if (isEdgeRelated(from, to)) g.classList.add('cv-related')
      else g.classList.remove('cv-related')
      if (isEdgeFaded(e)) g.classList.add('cv-faded')
      else g.classList.remove('cv-faded')
    })
  }, [svg, selection, model])

  // ==================== 节点点击 / 拖动 ====================
  const findNodeIdAt = useCallback(
    (target: EventTarget | null): string | null => {
      // 用 closest 一次性找到最近的 data-node-id 元素
      const el = target as Element | null
      const found = el?.closest?.('[data-node-id]')
      if (found) return found.getAttribute('data-node-id')
      return null
    },
    []
  )

  const findEdgeAt = useCallback(
    (target: EventTarget | null): CanvasEdge | null => {
      // 类似地用 closest
      const el = target as Element | null
      const found = el?.closest?.('[data-edge-from]')
      if (found) {
        const from = found.getAttribute('data-edge-from')
        const to = found.getAttribute('data-edge-to')
        const raw = found.getAttribute('data-edge-label')
        // Mermaid 会把标签文本放在 data-edge-label="" 的 g.label 中,
        // 而 data-edge-label="直接" 的 g.label 反而是隐藏的(foreignObject width=0)。
        // 所以当 data-edge-label 是空字符串但有可见文本内容时,用文本内容作为标签。
        const textContent = (found.textContent || '').trim()
        const label = raw === null ? undefined : (raw === '' && textContent ? textContent : raw)
        if (from && to) return { from, to, label } as CanvasEdge
      }
      return null
    },
    []
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // 形状选择态:点空白就落点 — §4.2.1
      if (pickState.mode === 'pick-shape' && pickState.target === 'new') {
        const onEmpty = !findNodeIdAt(e.target) && !findEdgeAt(e.target)
        if (onEmpty) {
          const shape = pickState.shape
          const { source: next, id } = addNodeRaw(file.mermaidSource, shape, 'New Node')
          // 落点:在画布中心放一个占位坐标(估算节点宽 100 / 高 36 / 边距 40)
          // SVG viewBox 范围由 mermaid 自动决定,我们用 wrap 几何估算
          const wrap = wrapRef.current
          let cx = 200, cy = 200
          if (wrap) {
            const svgEl = wrap.querySelector('svg') as SVGSVGElement | null
            if (svgEl) {
              const vb = svgEl.viewBox.baseVal
              cx = vb.x + vb.width / 2 - 50
              cy = vb.y + vb.height / 2 - 18
            }
          }
          const nextOverrides = { ...file.layoutOverrides, [id]: { x: cx, y: cy } }
          onLayoutChange(nextOverrides)
          onSourceChange(next)
          onSelectionChange({ kind: 'node', ids: [id] })
          onPickStateChange({ mode: 'idle' })
          e.preventDefault()
          e.stopPropagation()
          return
        }
      }

      const nodeId = findNodeIdAt(e.target)
      if (nodeId) {
        const isSelected = selection.kind === 'node' && selection.ids.includes(nodeId)
        if (e.shiftKey && selection.kind === 'node') {
          const ids = selection.ids.includes(nodeId)
            ? selection.ids.filter((x) => x !== nodeId)
            : [...selection.ids, nodeId]
          onSelectionChange({ kind: 'node', ids })
        } else {
          onSelectionChange({ kind: 'node', ids: [nodeId] })
        }
        const n = model.nodes.find((x) => x.id === nodeId)
        if (n) {
          // 已选中节点:先不决定是移动还是连线,等 mousemove 超过阈值再判断
          // 未选中节点:直接开始移动
          dragRef.current = {
            type: 'node',
            nodeId,
            startX: e.clientX,
            startY: e.clientY,
            originX: n.x,
            originY: n.y,
            intent: isSelected ? 'undecided' : 'move',
          }
        }
        // 注意:不 preventDefault,让后续 click / dblclick 能正常触发
        return
      }

      const edge = findEdgeAt(e.target)
      if (edge) {
        onSelectionChange({ kind: 'edge', from: edge.from, to: edge.to, label: edge.label })
        return
      }

      // 空白处 / Space 按下:平移 + 取消选区
      onSelectionChange({ kind: 'none' })
      dragRef.current = {
        type: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        originX: viewport.panX,
        originY: viewport.panY,
      }
    },
    [pickState, file.mermaidSource, file.layoutOverrides, model, onSourceChange, onLayoutChange, onSelectionChange, onPickStateChange, findNodeIdAt, findEdgeAt, selection, viewport]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const d = dragRef.current
      if (!d) return
      if (d.type === 'node' && d.nodeId) {
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        const dist = Math.sqrt(dx * dx + dy * dy)

        // 犹豫期:移动距离 < 8px 时不做任何事
        if (d.intent === 'undecided') {
          if (dist < 8) return
          // 超过阈值:进入连线模式
          dragRef.current = {
            type: 'edge-create',
            fromNodeId: d.nodeId,
            startX: d.startX,
            startY: d.startY,
            originX: d.originX,
            originY: d.originY,
            hoverNodeId: undefined,
          }
          return
        }

        // 正常移动节点
        if (d.intent === 'move') {
          const node = model.nodes.find((n) => n.id === d.nodeId)
          if (!node) return
          // 添加拖拽视觉反馈
          const g = wrapRef.current?.querySelector(`g[data-node-id="${d.nodeId}"]`)
          if (g) g.classList.add('cv-dragging')
          const next = { ...file.layoutOverrides }
          next[d.nodeId] = { x: node.x + dx / viewport.zoom, y: node.y + dy / viewport.zoom }
          onLayoutChange(next)
        }
      } else if (d.type === 'edge-create' && d.fromNodeId) {
        const el = document.elementFromPoint(e.clientX, e.clientY)
        const wrap = wrapRef.current
        let hoverId: string | null = null
        if (wrap && el) {
          let cur: Element | null = el
          while (cur && cur !== wrap) {
            const id = cur.getAttribute?.('data-node-id')
            if (id && id !== d.fromNodeId) {
              hoverId = id
              break
            }
            cur = cur.parentElement
          }
        }
        dragRef.current = { ...d, hoverNodeId: hoverId ?? undefined }
        // 更新临时线位置
        const fromG = wrapRef.current?.querySelector(`g[data-node-id="${d.fromNodeId}"]`) as SVGGElement | null
        if (fromG && wrap) {
          const r = fromG.getBoundingClientRect()
          const wr = wrap.getBoundingClientRect()
          const x1 = r.x - wr.x + r.width / 2
          const y1 = r.y - wr.y + r.height / 2
          let x2 = e.clientX - wr.x
          let y2 = e.clientY - wr.y
          if (hoverId) {
            const toG = wrap.querySelector(`g[data-node-id="${hoverId}"]`) as SVGGElement | null
            if (toG) {
              const r2 = toG.getBoundingClientRect()
              x2 = r2.x - wr.x + r2.width / 2
              y2 = r2.y - wr.y + r2.height / 2
            }
          }
          setDragLine({ x1, y1, x2, y2 })
        }
      } else if (d.type === 'pan') {
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        onViewportChange({
          zoom: viewport.zoom,
          panX: d.originX + dx,
          panY: d.originY + dy,
        })
      }
    },
    [model, file.layoutOverrides, viewport, onLayoutChange, onViewportChange]
  )

  const handleMouseUp = useCallback(() => {
    const d = dragRef.current
    // 清理拖拽视觉反馈
    if (d?.nodeId) {
      const g = wrapRef.current?.querySelector(`g[data-node-id="${d.nodeId}"]`)
      if (g) g.classList.remove('cv-dragging')
    }
    if (d?.type === 'edge-create' && d.fromNodeId && d.hoverNodeId) {
      // 创建连线
      const next = addEdge(file.mermaidSource, d.fromNodeId, d.hoverNodeId)
      onSourceChange(next)
      onSelectionChange({ kind: 'edge', from: d.fromNodeId, to: d.hoverNodeId })
    }
    dragRef.current = null
    setDragLine(null)
  }, [model, file.mermaidSource, onSourceChange, onSelectionChange, onToast])

  // ==================== 双击节点/边 — React onDoubleClick(事件委托,不会被 DOM 重建影响)====================
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element | null
      if (!target) return
      const nodeEl = target.closest?.('[data-node-id]') as Element | null
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-node-id')
        if (id) {
          const n = model.nodes.find((x) => x.id === id)
          if (n) {
            setEditingText({ id: n.id, value: n.text.replace(/<br\s*\/?>/gi, '\n') })
            e.preventDefault()
            e.stopPropagation()
          }
        }
        return
      }
      const edgeEl = target.closest?.('[data-edge-from]') as Element | null
      if (edgeEl) {
        const from = edgeEl.getAttribute('data-edge-from')
        const to = edgeEl.getAttribute('data-edge-to')
        const raw = edgeEl.getAttribute('data-edge-label')
        const textContent = (edgeEl.textContent || '').trim()
        const label = raw === null ? undefined : (raw === '' && textContent ? textContent : raw)
        if (from && to) {
          setEditingEdgeLabel({ from, to, value: (label ?? '').replace(/<br\s*\/?>/gi, '\n'), oldLabel: label })
          e.preventDefault()
          e.stopPropagation()
        }
      }
    },
    [model]
  )

  // ==================== 视口:滚轮缩放 / 工具栏适应 ====================
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!wrapRef.current) return
      // 任意滚轮都缩放(需求 §4.2.3:滚轮 或 Ctrl+滚轮),范围 25%-400%
      e.preventDefault()
      const el = wrapRef.current
      const rect = el.getBoundingClientRect()
      // 鼠标在画布中的相对位置(0~1)
      const mx = (e.clientX - rect.left) / rect.width
      const my = (e.clientY - rect.top) / rect.height
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const oldZoom = viewport.zoom
      const newZoom = Math.max(0.25, Math.min(4, oldZoom * factor))
      // 保持鼠标位置对应的画布点不动
      // pan 改变: pan_new = pan_old + mouseOffset * (1 - newZoom/oldZoom)
      const ratio = 1 - newZoom / oldZoom
      const newPanX = viewport.panX + mx * rect.width * ratio
      const newPanY = viewport.panY + my * rect.height * ratio
      onViewportChange({ zoom: newZoom, panX: newPanX, panY: newPanY })
    },
    [viewport, onViewportChange]
  )

  const isNonFlowchart = useMemo(() => {
    const trimmed = file.mermaidSource.trim()
    if (!trimmed) return false
    // 检测是否为非 flowchart/graph 的图表类型
    return /^(?:stateDiagram|sequenceDiagram|classDiagram|erDiagram|gantt|pie|gitGraph|mindmap|timeline|flowchart-v2|graph-v2)\b/i.test(trimmed.split('\n')[0].trim())
  }, [file.mermaidSource])

  const fitToScreen = useCallback(() => {
    onViewportChange({ zoom: 1, panX: 0, panY: 0 })
  }, [onViewportChange])

  // ==================== 形状工具栏:选形状 ====================
  const handlePickShape = useCallback(
    (shape: NodeShape) => {
      if (selection.kind === 'node' && selection.ids.length > 0) {
        // 改选中节点形状 — §4.2.1「改形状」
        // 先检查是否有未识别形状
        const target = selection.ids[0]
        const n = model.nodes.find((x) => x.id === target)
        if (n && n.shape === 'unknown') {
          onToast('该节点使用了非标准形状,改形状将覆盖。')
        }
        const next = setNodeShapeMulti(file.mermaidSource, selection.ids, shape)
        onSourceChange(next)
      } else {
        // 进入「待落点」 — §4.2.1「选形状」+「新建」
        onPickStateChange({ mode: 'pick-shape', target: 'new', shape })
        onToast(`已选 [${shape}] 形状,在画布上单击落点,Esc 取消`)
      }
    },
    [selection, model, file.mermaidSource, onSourceChange, onPickStateChange, onToast]
  )

  // ==================== 快捷键 ====================
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Escape 取消
      if (e.key === 'Escape') {
        if (pickState.mode !== 'idle') {
          onPickStateChange({ mode: 'idle' })
          e.preventDefault()
          return
        }
        onSelectionChange({ kind: 'none' })
        return
      }
      // Delete / Backspace — 二次确认防止误删
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection.kind !== 'none') {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || editingText || editingEdgeLabel) return
        if (selection.kind === 'node') {
          // 二次确认:记录待删除状态,再次按 Delete 确认
          if (pendingDelete?.kind === 'node' && arraysEqual(pendingDelete.ids, selection.ids)) {
            let next = file.mermaidSource
            for (const id of selection.ids) {
              next = removeNode(next, id)
            }
            onSourceChange(next)
            onSelectionChange({ kind: 'none' })
            setPendingDelete(null)
            onToast(`已删除 ${selection.ids.length} 个节点`)
          } else {
            setPendingDelete({ kind: 'node', ids: [...selection.ids] })
            onToast('再按 Delete 确认删除节点')
          }
          e.preventDefault()
        } else if (selection.kind === 'edge') {
          if (pendingDelete?.kind === 'edge' && pendingDelete.from === selection.from && pendingDelete.to === selection.to) {
            const next = removeEdge(file.mermaidSource, selection.from, selection.to, selection.label)
            onSourceChange(next)
            onSelectionChange({ kind: 'none' })
            setPendingDelete(null)
            onToast('已删除连线')
          } else {
            setPendingDelete({ kind: 'edge', from: selection.from, to: selection.to, label: selection.label })
            onToast('再按 Delete 确认删除连线')
          }
          e.preventDefault()
        }
        return
      }
      // F2 改文本
      if (e.key === 'F2' && selection.kind === 'node' && selection.ids.length === 1) {
        const n = model.nodes.find((x) => x.id === selection.ids[0])
        if (n) {
          setEditingText({ id: n.id, value: n.text })
          e.preventDefault()
        }
        return
      }
      // E 改边标签
      if (e.key === 'e' && selection.kind === 'edge') {
        setEditingEdgeLabel({ from: selection.from, to: selection.to, value: selection.label ?? '', oldLabel: selection.label })
        e.preventDefault()
        return
      }
      // Ctrl/Cmd + D 复制
      if ((e.ctrlKey || e.metaKey) && e.key === 'd' && selection.kind === 'node') {
        e.preventDefault()
        let next = file.mermaidSource
        const newIds: string[] = []
        for (const id of selection.ids) {
          const n = model.nodes.find((x) => x.id === id)
          if (!n) continue
          if (n.ephemeral) continue
          const shape = n.shape === 'unknown' ? 'rect' : n.shape
          const result = addNode(next, shape, n.text)
          next = result.source
          newIds.push(result.id)
          if (file.layoutOverrides[id]) {
            const next2 = { ...file.layoutOverrides, [result.id]: { x: file.layoutOverrides[id].x + 24, y: file.layoutOverrides[id].y + 24 } }
            onLayoutChange(next2)
          }
        }
        onSourceChange(next)
        if (newIds.length) onSelectionChange({ kind: 'node', ids: newIds })
        return
      }
      // 形状快捷键 R/O/C/D/P/H/T
      const k = e.key.toLowerCase()
      if (SHAPE_BY_KEY[k] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        handlePickShape(SHAPE_BY_KEY[k])
        e.preventDefault()
        return
      }
      // Insert — 选中节点时创建新节点并连线
      if (e.key === 'Insert' && selection.kind === 'node' && selection.ids.length > 0) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || editingText || editingEdgeLabel) return
        e.preventDefault()
        const selId = selection.ids[0]
        const selNode = model.nodes.find((n) => n.id === selId)
        const shape = selNode?.shape === 'unknown' ? 'rect' : (selNode?.shape ?? 'rect')
        const result = addNode(file.mermaidSource, shape, 'New Node', { from: selId })
        onSourceChange(result.source)
        onSelectionChange({ kind: 'node', ids: [result.id] })
        onToast(`已插入新节点并连线 ${selId} → ${result.id}`)
        return
      }
      // Shift+形状 改选中节点形状
      if (e.shiftKey && SHAPE_BY_KEY[k] && selection.kind === 'node' && selection.ids.length > 0) {
        e.preventDefault()
        const next = setNodeShapeMulti(file.mermaidSource, selection.ids, SHAPE_BY_KEY[k])
        onSourceChange(next)
        return
      }
    },
    [pickState, selection, model, file, onSourceChange, onLayoutChange, onSelectionChange, onPickStateChange, handlePickShape, editingText, editingEdgeLabel, pendingDelete]
  )

  // Space 监听(全局) — §4.2.3 Space + 拖拽 = 平移
  useEffect(() => {
    const onKeyWin = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          // Monaco 编辑器内部也不拦截(Monaco 用 div 承载,textarea 是隐藏的)
          const el = e.target as HTMLElement | null
          if (el?.closest('.monaco-editor')) return
          setSpaceDown(true)
          e.preventDefault()
        }
      }
    }
    const onKeyUpWin = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceDown(false)
    }
    window.addEventListener('keydown', onKeyWin)
    window.addEventListener('keyup', onKeyUpWin)
    return () => {
      window.removeEventListener('keydown', onKeyWin)
      window.removeEventListener('keyup', onKeyUpWin)
    }
  }, [])

  // ==================== 文本编辑提交 ====================
  const commitText = useCallback(() => {
    if (!editingText) return
    const next = setNodeText(file.mermaidSource, editingText.id, editingText.value.replace(/\n/g, '<br>'))
    onSourceChange(next)
    setEditingText(null)
  }, [editingText, file.mermaidSource, onSourceChange])

  const commitEdgeLabel = useCallback(() => {
    if (!editingEdgeLabel) return
    const normalized = editingEdgeLabel.value.replace(/\n/g, '<br>')
    const oldNormalized = (editingEdgeLabel.oldLabel ?? '').replace(/<br\s*\/?>/gi, '\n')
    // 值没变则不写入,避免不必要修改
    if (editingEdgeLabel.value === oldNormalized) {
      setEditingEdgeLabel(null)
      return
    }
    const next = setEdgeLabel(file.mermaidSource, editingEdgeLabel.from, editingEdgeLabel.to, normalized, editingEdgeLabel.oldLabel)
    onSourceChange(next)
    setEditingEdgeLabel(null)
  }, [editingEdgeLabel, file.mermaidSource, onSourceChange])

  return (
    <div
      className={`canvas-wrap ${pickState.mode === 'pick-shape' ? 'cv-pick' : ''}`}
      ref={wrapRef}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
      style={{
        cursor: spaceDown ? (dragRef.current?.type === 'pan' ? 'grabbing' : 'grab') : (pickState.mode === 'pick-shape' ? 'crosshair' : 'default'),
        outline: 'none',
      }}
    >
      {/* 形状工具栏 — §4.2.1 */}
      <div className="shape-bar">
        {SHAPE_DEFS.map((d) => (
          <button
            key={d.shape}
            className={`shape-btn ${
              pickState.mode === 'pick-shape' && pickState.shape === d.shape ? 'active' : ''
            }`}
            title={`${d.label} (${d.key})`}
            onMouseDown={(ev) => ev.stopPropagation()}
            onClick={() => handlePickShape(d.shape)}
          >
            <ShapeIcon shape={d.shape} />
          </button>
        ))}
      </div>

      {/* 画布浮动工具栏 — 导出 */}
      <div className="canvas-toolbar">
        <button
          className="icon-btn"
          title="导出 SVG"
          onClick={(e) => {
            e.stopPropagation()
            exportSvg(svg, file.name)
          }}
        >SVG</button>
        <button
          className="icon-btn"
          title="导出 PNG"
          onClick={(e) => {
            e.stopPropagation()
            exportPng(svg, file.name)
          }}
        >PNG</button>
      </div>

      {/* 缩放 + 适应 — 左下角 */}
      <div className="zoom-ctrl">
        <button className="icon-btn" title="缩小" onClick={() => onViewportChange({ ...viewport, zoom: Math.max(0.25, viewport.zoom / 1.2) })}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 8h8" strokeLinecap="round" /></svg>
        </button>
        <span className="zoom-pct">{Math.round(viewport.zoom * 100)}%</span>
        <button className="icon-btn" title="放大" onClick={() => onViewportChange({ ...viewport, zoom: Math.min(4, viewport.zoom * 1.2) })}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 4v8M4 8h8" strokeLinecap="round" /></svg>
        </button>
        <button className="icon-btn" title="适应窗口" onClick={fitToScreen}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 10V3h7M13 6v7H6" />
          </svg>
        </button>
      </div>

      {/* 非 flowchart 图表类型警告 */}
      {isNonFlowchart && svg && (
        <div className="canvas-warning">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l7 13H1L8 1z" stroke="currentColor" strokeWidth="0.5"/><text x="8" y="12" textAnchor="middle" fontSize="8" fill="var(--bg)" fontWeight="bold">!</text></svg>
          <span>当前仅支持流程图 (flowchart) 编辑，其他图表类型仅可查看</span>
        </div>
      )}
      {/* 渲染区 */}
      {svg ? (
        <div
          className="canvas-svg-container"
          style={{
            transform: `scale(${viewport.zoom}) translate(${viewport.panX}px, ${viewport.panY}px)`,
            transformOrigin: '0 0',
          }}
          dangerouslySetInnerHTML={innerHtmlObj}
        />
      ) : (
        <div className="canvas-empty">
          {rendering ? (
            <span>渲染中...</span>
          ) : (
            <div className="canvas-empty-hint">
              <p>{file.mermaidSource.trim() ? '解析失败,请检查源码' : '在左侧写 Mermaid 源码'}</p>
              <p className="muted">或按 R / D / O 选形状后在画布上单击落点</p>
            </div>
          )}
        </div>
      )}

      {/* 拖动连线时的临时线 */}
      {dragLine && (
        <svg className="edge-drag-line" style={{ left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
          <line
            x1={dragLine.x1}
            y1={dragLine.y1}
            x2={dragLine.x2}
            y2={dragLine.y2}
            stroke="var(--accent)"
            strokeWidth={2}
            strokeDasharray="5 4"
          />
        </svg>
      )}

      {/* 节点边缘圆点 + 调端点圆点 + 增边连线 — §4.2.2 */}
      {svg && (
        <EdgeOverlay
          model={model}
          viewport={viewport}
          selection={selection}
          svgRef={wrapRef}
          onAddEdge={(from, to) => {
            const next = addEdge(file.mermaidSource, from, to)
            onSourceChange(next)
            onSelectionChange({ kind: 'edge', from, to })
          }}
          onChangeEdgeEndpoint={(from, to, newFrom, newTo) => {
            // 调端点:删旧边 + 加新边(按 label 精确匹配)
            let next = removeEdge(file.mermaidSource, from, to, selection.label)
            next = addEdge(next, newFrom, newTo)
            onSourceChange(next)
            onSelectionChange({ kind: 'edge', from: newFrom, to: newTo })
          }}
        />
      )}

      {/* 文本编辑浮层 — 位置在节点正中间 */}
      {editingText && (() => {
        const n = model.nodes.find((x) => x.id === editingText.id)
        if (!n) return null
        const g = wrapRef.current?.querySelector(`g[data-node-id="${n.id}"]`) as SVGGElement | null
        const wrap = wrapRef.current
        let left = 0, top = 0
        if (g && wrap) {
          const r = g.getBoundingClientRect()
          const wr = wrap.getBoundingClientRect()
          // textarea 放节点正中间,水平居中
          left = r.x - wr.x + r.width / 2
          top = r.y - wr.y + r.height / 2
        }
        return (
          <div
            className="text-overlay"
            style={{ left: left + 'px', top: top + 'px', transform: 'translate(-50%, -50%)' }}
          >
            <textarea
              autoFocus
              rows={Math.max(1, editingText.value.split('\n').length)}
              value={editingText.value}
              onChange={(e) => setEditingText({ ...editingText, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  commitText()
                  e.preventDefault()
                }
                if (e.key === 'Escape') setEditingText(null)
                e.stopPropagation()
              }}
              onBlur={commitText}
            />
          </div>
        )
      })()}

      {/* 边标签浮层 */}
      {editingEdgeLabel && (() => {
        const from = model.nodes.find((n) => n.id === editingEdgeLabel.from)
        const to = model.nodes.find((n) => n.id === editingEdgeLabel.to)
        if (!from || !to) return null
        const gFrom = wrapRef.current?.querySelector(`g[data-node-id="${from.id}"]`) as SVGGElement | null
        const gTo = wrapRef.current?.querySelector(`g[data-node-id="${to.id}"]`) as SVGGElement | null
        const wrap = wrapRef.current
        let mx = 0, my = 0
        if (gFrom && gTo && wrap) {
          const r1 = gFrom.getBoundingClientRect()
          const r2 = gTo.getBoundingClientRect()
          const wr = wrap.getBoundingClientRect()
          const srcBottom = r1.y + r1.height
          const tgtTop = r2.y
          mx = ((r1.x + r1.width / 2) + (r2.x + r2.width / 2)) / 2 - wr.x
          my = (srcBottom + tgtTop) / 2 - wr.y - 12
        }
        const isUnchanged = editingEdgeLabel.value === (editingEdgeLabel.oldLabel ?? '')
        return (
          <div className="text-overlay" style={{ left: mx + 'px', top: my + 'px' }}>
            <textarea
              autoFocus
              rows={Math.max(1, editingEdgeLabel.value.split('\n').length)}
              value={editingEdgeLabel.value}
              placeholder="(空 = 无标签)"
              onChange={(e) => setEditingEdgeLabel({ ...editingEdgeLabel, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  commitEdgeLabel()
                  e.preventDefault()
                }
                if (e.key === 'Escape') setEditingEdgeLabel(null)
                e.stopPropagation()
              }}
              onBlur={() => { if (!isUnchanged) commitEdgeLabel(); else setEditingEdgeLabel(null) }}
            />
          </div>
        )
      })()}
    </div>
  )
}

// ============================================================
// 工具
// ============================================================

/** 把节点 / 边的 ID 注入到 SVG,便于事件委托 */
function injectNodeDataAttrs(svg: string, nodes: CanvasNode[], edges: CanvasEdge[]): string {
  let out = svg
  // 节点 — mermaid 11 的 id 形如 `mermaid-<ts>-<rand>-flowchart-<ID>-<idx>`
  // 老版 mermaid 形如 `flowchart-<ID>-<idx>`,两种都要兼容
  // 注意:mermaid 11 的 <g> 上 class 在 id 前面,要允许任意属性顺序
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const nodeRe = /<g\b[^>]*\bid="(?:mermaid-[\w]+-[\w]+-)?flowchart-([A-Za-z0-9_]+)-\d+"[^>]*>/g
  out = out.replace(nodeRe, (full, id) => {
    if (full.includes('data-node-id=')) return full
    // 总是注入 data-node-id — 即使 parseSource 漏了某个 ID,DOM 实际存在也要注入
    // (后续 model useMemo 会从 DOM 重建节点列表,自动同步)
    return full.replace(/id="[^"]*"/, `id="flowchart-${id}-x" data-node-id="${id}"`)
  })
  // 先把 <path ...></path> 转为自闭合形式,便于正则处理
  out = out.replace(/<path\b([^>]*)><\/path>/g, '<path$1 />')

  // 构建 (from,to) → labels 映射,按 model 中顺序排列
  const edgeLabelMap = new Map<string, string[]>()
  for (const e of edges) {
    const key = `${e.from}|${e.to}`
    const list = edgeLabelMap.get(key) || []
    list.push(e.label ?? '')
    edgeLabelMap.set(key, list)
  }
  // 每对 (from,to) 的计数器,用于匹配 SVG 中第 N 条路径
  const edgeCounters = new Map<string, number>()

  // 边 — path 形式:追加透明粗线用于点击检测
  const edgePathRe = /<path\b([^>]*)\bid="(?:mermaid-[\w]+-[\w]+-)?L_([A-Za-z0-9_]+)_([A-Za-z0-9_]+)_\d+(_\d+)?"([^>]*)\/>/g
  out = out.replace(edgePathRe, (full, before, from, to, suffix, after) => {
    if (full.includes('data-edge-from=')) return full
    const key = `${from}|${to}`
    const idx = edgeCounters.get(key) ?? 0
    edgeCounters.set(key, idx + 1)
    const labels = edgeLabelMap.get(key) ?? []
    const label = labels[idx] ?? ''
    const baseId = `L_${from}_${to}`
    const injected = full.replace(/id="[^"]*"/, `id="${baseId}-x" data-edge-from="${from}" data-edge-to="${to}" data-edge-label="${label}"`)
    const dMatch = full.match(/d="([^"]*)"/)
    if (dMatch) {
      const hitPath = `<path d="${dMatch[1]}" fill="none" stroke="transparent" stroke-width="16" data-edge-from="${from}" data-edge-to="${to}" data-edge-label="${label}" style="pointer-events:stroke" />`
      return injected + hitPath
    }
    return injected
  })
  // 重置计数器,用于 g 形式边
  edgeCounters.clear()
  // 边 — g 形式:只注入 data 属性(靠 CSS pointer-events:all 扩大点击区)
  const edgeGRe = /<g\b([^>]*)\bid="(?:mermaid-[\w]+-[\w]+-)?L_([A-Za-z0-9_]+)_([A-Za-z0-9_]+)_\d+(_\d+)?"([^>]*)>/g
  out = out.replace(edgeGRe, (full, before, from, to, suffix, after) => {
    if (full.includes('data-edge-from=')) return full
    const key = `${from}|${to}`
    const idx = edgeCounters.get(key) ?? 0
    edgeCounters.set(key, idx + 1)
    const labels = edgeLabelMap.get(key) ?? []
    const label = labels[idx] ?? ''
    const baseId = `L_${from}_${to}`
    return full.replace(/id="[^"]*"/, `id="${baseId}-x" data-edge-from="${from}" data-edge-to="${to}" data-edge-label="${label}"`)
  })
  return out
}

function ShapeIcon({ shape }: { shape: NodeShape }) {
  const stroke = 'currentColor'
  switch (shape) {
    case 'rect':
      return <svg width="22" height="14" viewBox="0 0 22 14"><rect x="1" y="1" width="20" height="12" rx="1" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
    case 'round':
      return <svg width="22" height="14" viewBox="0 0 22 14"><rect x="1" y="1" width="20" height="12" rx="6" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
    case 'ellipse':
      return <svg width="22" height="14" viewBox="0 0 22 14"><ellipse cx="11" cy="7" rx="10" ry="6" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
    case 'circle':
      return <svg width="18" height="14" viewBox="0 0 18 14"><circle cx="9" cy="7" r="6" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
    case 'diamond':
      return <svg width="20" height="14" viewBox="0 0 20 14"><polygon points="10,1 19,7 10,13 1,7" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
    case 'parallelogram':
      return <svg width="22" height="12" viewBox="0 0 22 12"><polygon points="4,1 21,1 18,11 1,11" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
    case 'hexagon':
      return <svg width="22" height="14" viewBox="0 0 22 14"><polygon points="6,1 16,1 21,7 16,13 6,13 1,7" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
    case 'trapezoid':
      return <svg width="22" height="12" viewBox="0 0 22 12"><polygon points="6,1 16,1 21,11 1,11" fill="none" stroke={stroke} strokeWidth="1.5" /></svg>
  }
}

function addNodeRaw(source: string, shape: NodeShape, text: string) {
  return addNode(source, shape, text)
}
function setNodeShapeMulti(source: string, ids: string[], shape: NodeShape): string {
  let next = source
  for (const id of ids) {
    next = setNodeShape(next, id, shape)
  }
  return next
}
// ============================================================
// EdgeOverlay — 节点边缘圆点 / 调端点 / 拖出生成边 — §4.2.2
// ============================================================
type EdgeOverlayProps = {
  model: CanvasModel
  viewport: { zoom: number; panX: number; panY: number }
  selection: Selection
  svgRef: React.RefObject<HTMLDivElement | null>
  onAddEdge: (from: string, to: string) => void
  onChangeEdgeEndpoint: (from: string, to: string, newFrom: string, newTo: string) => void
}

function EdgeOverlay({ model, viewport, selection, svgRef, onAddEdge, onChangeEdgeEndpoint }: EdgeOverlayProps) {
  // 节点宽高(估算)— 实际从 SVG <g> 读 bounding box 更准,这里用估算
  const [drag, setDrag] = useState<null | {
    kind: 'create' | 'endpoint'
    from: string
    startX: number
    startY: number
    currentX: number
    currentY: number
    edgeFrom?: string
    edgeTo?: string
    endpoint?: 'from' | 'to'
  }>(null)
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null)

  // 从 SVG 中读节点真实 bounding box — 转成 wrap 内的 CSS 像素。
  // 用 getBoundingClientRect(屏幕) - wrapRect(屏幕) = wrap 内 CSS 像素,
  // wrap 内的 CSS 像素已经包含了 canvas-svg-container 的 flex center 偏移、
  // viewBox 缩放、外层 scale+translate,所以 handle 直接 left/top 即可。
  const [nodeBoxes, setNodeBoxes] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({})
  useEffect(() => {
    const wrap = svgRef.current
    if (!wrap) return
    // 用 rAF 确保 SVG 布局动画完成后再读取位置
    const raf = requestAnimationFrame(() => {
      const boxes: typeof nodeBoxes = {}
      const wrapRect = wrap.getBoundingClientRect()
      model.nodes.forEach((n) => {
        const g = wrap.querySelector(`g[data-node-id="${n.id}"]`) as SVGGElement | null
        if (!g) return
        const r = g.getBoundingClientRect()
        boxes[n.id] = {
          x: r.x - wrapRect.x,
          y: r.y - wrapRect.y,
          w: r.width,
          h: r.height,
        }
      })
      setNodeBoxes(boxes)
    })
    return () => cancelAnimationFrame(raf)
  }, [model.nodes, svgRef, viewport.zoom, viewport.panX, viewport.panY])

  // 端点位置:nodeBoxes 已经是 wrap 内的 CSS 像素,直接传
  const transform = (x: number, y: number) => ({ left: x, top: y })

  const isNodeHighlighted = (id: string) => {
    if (selection.kind === 'node' && selection.ids.includes(id)) return true
    if (hoverNodeId === id) return true
    return false
  }

  // 鼠标全局追踪(用于拖动过程中画线)
  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) => {
      setDrag((d) => d ? { ...d, currentX: e.clientX, currentY: e.clientY } : null)
      // 检测 hover 的节点
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const wrap = svgRef.current
      if (!wrap || !el) return
      let cur: Element | null = el
      while (cur && cur !== wrap) {
        const id = (cur as Element).getAttribute?.('data-node-id')
        if (id) {
          setHoverNodeId(id)
          return
        }
        cur = cur.parentElement
      }
      setHoverNodeId(null)
    }
    const onUp = (e: MouseEvent) => {
      // 检测松手时悬停的节点
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const wrap = svgRef.current
      let targetId: string | null = null
      if (wrap && el) {
        let cur: Element | null = el
        while (cur && cur !== wrap) {
          const id = (cur as Element).getAttribute?.('data-node-id')
          if (id) { targetId = id; break }
          cur = cur.parentElement
        }
      }
      if (drag) {
        if (targetId && targetId !== drag.from) {
          if (drag.kind === 'create') {
            onAddEdge(drag.from, targetId)
          } else if (drag.kind === 'endpoint' && drag.edgeFrom && drag.edgeTo) {
            // 调端点
            const newFrom = drag.endpoint === 'from' ? targetId : drag.edgeFrom
            const newTo = drag.endpoint === 'to' ? targetId : drag.edgeTo
            onChangeEdgeEndpoint(drag.edgeFrom, drag.edgeTo, newFrom, newTo)
          }
        }
      }
      setDrag(null)
      setHoverNodeId(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag, onAddEdge, onChangeEdgeEndpoint, svgRef])

  return (
    <div
      className="edge-overlay"
      style={{
        // 不套 scale/translate:子元素直接用 wrap 内的 CSS 像素定位,
        // 避免外层 transform 把 viewBox 数值二次缩放导致位置跑到画布左上角
      }}
    >
      {/* 选中边的两端圆点 — 调端点 */}
      {selection.kind === 'edge' && (() => {
        const e0 = model.edges.find((x) => x.from === selection.from && x.to === selection.to)
        if (!e0) return null
        const fromNode = model.nodes.find((n) => n.id === e0.from)
        const toNode = model.nodes.find((n) => n.id === e0.to)
        if (!fromNode || !toNode) return null
        const fromBox = nodeBoxes[e0.from] ?? { x: fromNode.x - 50, y: fromNode.y - 18, w: 100, h: 36 }
        const toBox = nodeBoxes[e0.to] ?? { x: toNode.x - 50, y: toNode.y - 18, w: 100, h: 36 }
        // TD 流程图:源节点底部出,目标节点顶部入
        const fromPt = transform(fromBox.x + fromBox.w / 2, fromBox.y + fromBox.h)
        const toPt = transform(toBox.x + toBox.w / 2, toBox.y)
        return (
          <>
            <div
              className="edge-handle ep"
              style={{ left: fromPt.left, top: fromPt.top }}
              onMouseDown={(ev) => {
                ev.stopPropagation()
                ev.preventDefault()
                setDrag({
                  kind: 'endpoint',
                  from: e0.from,
                  edgeFrom: e0.from,
                  edgeTo: e0.to,
                  endpoint: 'from',
                  startX: ev.clientX, startY: ev.clientY,
                  currentX: ev.clientX, currentY: ev.clientY,
                })
              }}
              title="拖动改起点"
            ><span /></div>
            <div
              className="edge-handle ep"
              style={{ left: toPt.left, top: toPt.top }}
              onMouseDown={(ev) => {
                ev.stopPropagation()
                ev.preventDefault()
                setDrag({
                  kind: 'endpoint',
                  from: e0.to,
                  edgeFrom: e0.from,
                  edgeTo: e0.to,
                  endpoint: 'to',
                  startX: ev.clientX, startY: ev.clientY,
                  currentX: ev.clientX, currentY: ev.clientY,
                })
              }}
              title="拖动改终点"
            ><span /></div>
          </>
        )
      })()}

      {/* 拖动过程中画一条临时线 */}
      {drag && (() => {
        const fromNode = model.nodes.find((n) => n.id === drag.from)
        if (!fromNode) return null
        const box = nodeBoxes[drag.from]
        if (!box) return null
        const startScreen = transform(box.x + box.w / 2, box.y + box.h)
        return (
          <svg
            className="edge-drag-line"
            style={{ left: 0, top: 0, width: '100%', height: '100%' }}
          >
            <line
              x1={startScreen.left}
              y1={startScreen.top}
              x2={drag.currentX - (svgRef.current?.getBoundingClientRect().left ?? 0)}
              y2={drag.currentY - (svgRef.current?.getBoundingClientRect().top ?? 0)}
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray="5 4"
            />
          </svg>
        )
      })()}
    </div>
  )
}


// ============================================================
// 导出
// ============================================================

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function exportSvg(svg: string, baseName: string) {
  if (!svg) return
  const cleaned = svg
    .replace(/\s*data-node-id="[^"]*"/g, '')
    .replace(/\s*data-edge-from="[^"]*"/g, '')
    .replace(/\s*data-edge-to="[^"]*"/g, '')
    .replace(/\s*data-edge-label="[^"]*"/g, '')
    .replace(/\s*class="[^"]*cv-selected[^"]*"/g, '')
    .replace(/\s*class="[^"]*cv-faded[^"]*"/g, '')
    .replace(/\s*class="[^"]*cv-related[^"]*"/g, '')
  const blob = new Blob([cleaned], { type: 'image/svg+xml' })
  downloadBlob(blob, `${baseName.replace(/\.mmd$/, '')}.svg`)
}

function exportPng(svg: string, baseName: string) {
  if (!svg) return
  const cleaned = svg
    .replace(/\s*data-node-id="[^"]*"/g, '')
    .replace(/\s*data-edge-from="[^"]*"/g, '')
    .replace(/\s*data-edge-to="[^"]*"/g, '')
    .replace(/\s*data-edge-label="[^"]*"/g, '')
    .replace(/\s*class="[^"]*cv-selected[^"]*"/g, '')
    .replace(/\s*class="[^"]*cv-faded[^"]*"/g, '')
    .replace(/\s*class="[^"]*cv-related[^"]*"/g, '')
  const blob = new Blob([cleaned], { type: 'image/svg+xml' })
  const url = URL.createObjectURL(blob)
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = img.width * 2
    canvas.height = img.height * 2
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((b) => {
      if (b) downloadBlob(b, `${baseName.replace(/\.mmd$/, '')}.png`)
      URL.revokeObjectURL(url)
    }, 'image/png')
  }
  img.src = url
}
