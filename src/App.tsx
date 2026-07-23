// 主入口组件 — 整体布局 + 状态管理
// 状态分层:
//   file (SourceOfTruth): 在 store 里
//   UI 临时态: selection / pickState / viewport / sourceVisible — 在 App 里
//   派生: error — 由 CanvasView 上抛
import { useCallback, useEffect, useRef, useState } from 'react'
import { Menubar } from './components/Menubar'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { SourceEditor } from './components/SourceEditor'
import { CanvasView } from './components/CanvasView'
import { StatusBar } from './components/StatusBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { useFileStore } from './store/fileStore'
import { exportSource } from './lib/sourceOps'
import { setMermaidTheme } from './lib/mermaid'
import type { Selection, ShapePickState, ParseError } from './types'
import './App.css'

// 撤销/重做历史栈
type HistoryEntry = { mermaidSource: string; layoutOverrides: Record<string, { x: number; y: number }> }
const MAX_HISTORY = 50

export default function App() {
  const { file, loaded, updateFile } = useFileStore()
  const [error, setError] = useState<ParseError>(null)
  const [sourceVisible, setSourceVisible] = useState(true)
  const [sidebarVisible, setSidebarVisible] = useState(false)
  const [saved, setSaved] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [selection, setSelection] = useState<Selection>({ kind: 'none' })
  const [pickState, setPickState] = useState<ShapePickState>({ mode: 'idle' })
  const [viewport, setViewport] = useState({ zoom: 1, panX: 0, panY: 0 })
  const [splitRatio, setSplitRatio] = useState(0.4)
  const splitDragRef = useRef<{ startX: number; startRatio: number; containerW: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  // 主题切换时强制 mermaid 重渲染(深度/浅色主题)
  const [renderVersion, setRenderVersion] = useState(0)

  // 撤销/重做
  const [undoStack, setUndoStack] = useState<HistoryEntry[]>([])
  const [redoStack, setRedoStack] = useState<HistoryEntry[]>([])
  const isUndoRedoRef = useRef(false)

  // 恢复视口(切换文件时)
  useEffect(() => {
    if (file.viewport) {
      setViewport(file.viewport)
    } else {
      setViewport({ zoom: 1, panX: 0, panY: 0 })
    }
  }, [file.id])

  // 简易 Toast
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2000)
  }, [])

  // 推入历史栈
  const pushHistory = useCallback(
    (source: string, layout: Record<string, { x: number; y: number }>) => {
      if (isUndoRedoRef.current) return
      setUndoStack((prev) => {
        const next = [...prev, { mermaidSource: source, layoutOverrides: { ...layout } }]
        if (next.length > MAX_HISTORY) next.shift()
        return next
      })
      setRedoStack([])
    },
    []
  )

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      setRedoStack((r) => [...r, { mermaidSource: file.mermaidSource, layoutOverrides: { ...file.layoutOverrides } }])
      isUndoRedoRef.current = true
      updateFile({ mermaidSource: last.mermaidSource, layoutOverrides: last.layoutOverrides })
      window.setTimeout(() => { isUndoRedoRef.current = false }, 0)
      showToast('已撤销')
      return prev.slice(0, -1)
    })
  }, [file, updateFile, showToast])

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      setUndoStack((u) => [...u, { mermaidSource: file.mermaidSource, layoutOverrides: { ...file.layoutOverrides } }])
      isUndoRedoRef.current = true
      updateFile({ mermaidSource: last.mermaidSource, layoutOverrides: last.layoutOverrides })
      window.setTimeout(() => { isUndoRedoRef.current = false }, 0)
      showToast('已重做')
      return prev.slice(0, -1)
    })
  }, [file, updateFile, showToast])

  const handleSourceChange = useCallback(
    (v: string) => {
      pushHistory(file.mermaidSource, file.layoutOverrides)
      updateFile({ mermaidSource: v })
      setSaved(false)
      window.setTimeout(() => setSaved(true), 850)
    },
    [updateFile, file.mermaidSource, file.layoutOverrides, pushHistory]
  )

  const handleLayoutChange = useCallback(
    (next: typeof file.layoutOverrides) => {
      pushHistory(file.mermaidSource, file.layoutOverrides)
      updateFile({ layoutOverrides: next })
      setSaved(false)
      window.setTimeout(() => setSaved(true), 850)
    },
    [updateFile, file.mermaidSource, file.layoutOverrides, pushHistory]
  )

  const handleViewportChange = useCallback(
    (v: { zoom: number; panX: number; panY: number }) => {
      setViewport(v)
      updateFile({ viewport: v })
    },
    [updateFile]
  )

  const handleCopySource = useCallback(async () => {
    try {
      const exported = exportSource(file)
      await navigator.clipboard.writeText(exported)
      showToast('已复制 Mermaid 源码(含布局坐标)到剪贴板')
    } catch (e) {
      console.warn('复制失败:', e)
      showToast('复制失败,请检查浏览器剪贴板权限')
    }
  }, [file, showToast])

  const handleToggleSource = useCallback(() => {
    setSourceVisible((v) => !v)
  }, [])

  const handleToggleSidebar = useCallback(() => {
    setSidebarVisible((v) => !v)
  }, [])

  const handleToggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light'
      document.documentElement.setAttribute('data-theme', next)
      setMermaidTheme(next)
      setRenderVersion((v) => v + 1)
      return next
    })
  }, [])

  // 分栏拖动
  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const container = (e.currentTarget as HTMLElement).parentElement
    if (!container) return
    const rect = container.getBoundingClientRect()
    splitDragRef.current = {
      startX: e.clientX,
      startRatio: splitRatio,
      containerW: rect.width,
    }
  }, [splitRatio])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = splitDragRef.current
      if (!d) return
      const dx = e.clientX - d.startX
      const newRatio = d.startRatio + dx / d.containerW
      setSplitRatio(Math.max(0.1, Math.min(0.9, newRatio)))
    }
    const onUp = () => { splitDragRef.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // 全局快捷键: Ctrl+Z / Ctrl+Y
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        handleUndo()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleUndo, handleRedo])

  if (!loaded) {
    return <div className="app-loading">加载中...</div>
  }

  return (
    <ErrorBoundary>
      <div
        className="app"
        style={{
          gridTemplateColumns: sidebarVisible ? '240px 1fr' : '0 1fr',
        }}
      >
        <Menubar
          onToggleSidebar={handleToggleSidebar}
          onToggleTheme={handleToggleTheme}
          theme={theme}
          sidebarVisible={sidebarVisible}
        />
        <Sidebar name={file.name} updatedAt={file.updatedAt} visible={sidebarVisible} />
        <TabBar
          dirty={!saved}
          sourceVisible={sourceVisible}
          onToggleSource={handleToggleSource}
          onCopySource={handleCopySource}
        />
        <div
          className="editor"
          style={{
            gridTemplateColumns: sourceVisible
              ? `${splitRatio * 100}% 6px 1fr`
              : '1fr',
          }}
        >
          {sourceVisible && (
            <div
              className="pane source-pane-wrap"
              style={{ minWidth: 0, overflow: 'hidden' }}
            >
              {error && (
                <div className="error-bar">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="8" r="7" />
                  </svg>
                  <span>Line {error.line || '?'}: {error.message}</span>
                </div>
              )}
              <div className="source-pane">
                <SourceEditor value={file.mermaidSource} onChange={handleSourceChange} theme={theme} />
              </div>
            </div>
          )}
          {sourceVisible && (
            <div
              className="divider"
              title="拖动调整分栏"
              onMouseDown={handleSplitMouseDown}
              style={{ cursor: 'col-resize' }}
            />
          )}
          <div className="pane canvas-pane" style={{ minWidth: 0, overflow: 'hidden' }}>
            <CanvasView
              file={file}
              selection={selection}
              pickState={pickState}
              viewport={viewport}
              renderVersion={renderVersion}
              onSourceChange={handleSourceChange}
              onLayoutChange={handleLayoutChange}
              onSelectionChange={setSelection}
              onPickStateChange={setPickState}
              onViewportChange={handleViewportChange}
              onError={setError}
              onToast={showToast}
            />
          </div>
        </div>
        <StatusBar saved={saved} source={file.mermaidSource} error={error?.message ?? null} />
        {toast && <div className="toast">{toast}</div>}
      </div>
    </ErrorBoundary>
  )
}