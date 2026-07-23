// 左侧文件树 — 多文件列表 + 双击编辑当前文件名
import { useState, useRef, useEffect } from 'react'
import { useFileStore } from '../store/fileStore'

type Props = {
  name: string
  updatedAt: number
  visible: boolean
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

function EditableFileName({ name }: { name: string }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const { updateFile } = useFileStore()

  useEffect(() => {
    setValue(name)
  }, [name])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = () => {
    setEditing(false)
    const trimmed = value.trim()
    if (trimmed && trimmed !== name) {
      updateFile({ name: trimmed })
    } else {
      setValue(name)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="file-name-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') {
            setValue(name)
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <span className="file-name" onDoubleClick={() => setEditing(true)} title="双击编辑文件名">
      {name}
    </span>
  )
}

export function Sidebar({ name, updatedAt, visible }: Props) {
  const { files, currentFileId, switchFile, deleteFile, closeTab, openTabs } = useFileStore()
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  if (!visible) return null

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (deleteConfirm === id) {
      // 确认删除
      closeTab(id)
      deleteFile(id)
      setDeleteConfirm(null)
    } else {
      setDeleteConfirm(id)
      setTimeout(() => setDeleteConfirm(null), 3000)
    }
  }

  const handleDownload = (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const f = files.find((x) => x.id === id)
    if (!f) return
    const blob = new Blob([f.mermaidSource], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = f.name
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">文件</span>
      </div>
      <div className="file-list">
        {files.map((f) => (
          <div
            key={f.id}
            className={`file-item ${f.id === currentFileId ? 'active' : ''}`}
            onClick={() => switchFile(f.id)}
          >
            {f.id === currentFileId ? (
              <EditableFileName name={f.name} />
            ) : (
              <span className="file-name">{f.name}</span>
            )}
            <span className="file-time">{formatRelativeTime(f.updatedAt)}</span>
            <div className="file-actions">
              <button
                className="file-action-btn"
                title="下载"
                onClick={(e) => handleDownload(e, f.id)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v8M4 7l4 4 4-4M2 13h12" />
                </svg>
              </button>
              <button
                className={`file-action-btn ${deleteConfirm === f.id ? 'danger' : ''}`}
                title={deleteConfirm === f.id ? '再次点击确认删除' : '删除文件'}
                onClick={(e) => handleDelete(e, f.id)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4h12M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v5M10 7v5M4 4l1 9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l1-9" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}