// 顶部 Tab Bar — 多标签 + 关闭 + 双击改名 + 源码/复制按钮
import { useState, useRef, useEffect } from 'react'
import { useFileStore } from '../store/fileStore'

type Props = {
  dirty: boolean
  sourceVisible: boolean
  onToggleSource: () => void
  onCopySource: () => void
}

function TabName({ id, name, isActive }: { id: string; name: string; isActive: boolean }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const { renameFile } = useFileStore()

  useEffect(() => { setValue(name) }, [name])

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
      renameFile(id, trimmed)
    } else {
      setValue(name)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="tab-name-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') { setValue(name); setEditing(false) }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <span
      className="tab-name"
      onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
      title="双击编辑文件名"
    >
      {name}{isActive && ' •'}
    </span>
  )
}

export function TabBar({ dirty, sourceVisible, onToggleSource, onCopySource }: Props) {
  const { createFile, switchFile, closeTab, openTabs, files, currentFileId } = useFileStore()

  return (
    <div className="tabbar">
      {openTabs.map((id) => {
        const f = files.find((x) => x.id === id)
        if (!f) return null
        const isActive = id === currentFileId
        return (
          <div
            key={id}
            className={`tab ${isActive ? 'active' : ''}`}
            onClick={() => switchFile(id)}
          >
            <TabName id={id} name={f.name} isActive={isActive && dirty} />
            <button
              className="tab-close"
              title="关闭标签"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(id)
              }}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        )
      })}
      <button
        className="tab-new"
        onClick={() => createFile()}
        title="新建文件"
        aria-label="新建文件"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M8 2v12M2 8h12" strokeLinecap="round" />
        </svg>
      </button>
      <div className="tabbar-spacer" />
      <div className="tabbar-actions">
        <button className="tabbar-btn" onClick={onCopySource} title="复制源码 (含布局坐标)" aria-label="复制源码">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="5" width="9" height="9" rx="1" />
            <path d="M3 11V3a1 1 0 0 1 1-1h7" strokeLinecap="round" />
          </svg>
        </button>
        <button className="tabbar-btn" onClick={onToggleSource} title={sourceVisible ? '隐藏源码' : '显示源码'} aria-label="切换源码面板">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="5 4 2 8 5 12" />
            <polyline points="11 4 14 8 11 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}