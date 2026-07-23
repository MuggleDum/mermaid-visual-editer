// 文件 store — 支持多文件 Tab
//   - 内存中维护文件列表 + 当前文件 ID + 打开的标签
//   - 任何改动 → 800ms 防抖 → 写入 IndexedDB
//   - 启动时从 IndexedDB 恢复,若无则用默认示例源码
//   - 通过 React Context 共享状态
import { useEffect, useRef, useState, useCallback, createContext, useContext } from 'react'
import { get, set } from 'idb-keyval'
import type { FileState } from '../types'

const STORE_KEY = 'mermaid-visual-editer:files'
const CURRENT_KEY = 'mermaid-visual-editer:current-file-id'
const OPEN_TABS_KEY = 'mermaid-visual-editer:open-tabs'
const SAVE_DEBOUNCE = 800

let fileCounter = 1

const DEFAULT_FILE: FileState = {
  id: 'default',
  name: '未命名-1.mmd',
  mermaidSource: `flowchart TD
    A[开始] --> B{条件判断}
    A -->|直接| B{条件判断}
    B -->|是| C[处理 A]
    B -->|否| D[处理 B]
    C --> E[结束]
    D --> E
`,
  layoutOverrides: {},
  updatedAt: Date.now(),
}

export type FileStore = ReturnType<typeof useFileStoreInternal>

const FileStoreContext = createContext<FileStore | null>(null)

function useFileStoreInternal() {
  const [files, setFiles] = useState<FileState[]>([DEFAULT_FILE])
  const [currentFileId, setCurrentFileId] = useState<string>('default')
  const [openTabs, setOpenTabs] = useState<string[]>(['default'])
  const [loaded, setLoaded] = useState(false)
  const saveTimerRef = useRef<number | null>(null)

  const file = files.find((f) => f.id === currentFileId) ?? files[0]

  // 启动时从 IndexedDB 恢复
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) setLoaded(true)
    }, 2000)
    Promise.all([
      get<FileState[]>(STORE_KEY).catch(() => undefined),
      get<string>(CURRENT_KEY).catch(() => undefined),
      get<string[]>(OPEN_TABS_KEY).catch(() => undefined),
    ]).then(([savedFiles, savedCurrentId, savedOpenTabs]) => {
      if (cancelled) return
      window.clearTimeout(timer)
      if (savedFiles && savedFiles.length > 0) {
        setFiles(savedFiles)
        setCurrentFileId(savedCurrentId && savedFiles.find((f) => f.id === savedCurrentId) ? savedCurrentId : savedFiles[0].id)
        if (savedOpenTabs && savedOpenTabs.length > 0) {
          setOpenTabs(savedOpenTabs.filter((id) => savedFiles.some((f) => f.id === id)))
        }
        fileCounter = savedFiles.filter((f) => f.name.startsWith('未命名-')).length + 1
      }
      setLoaded(true)
    })
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])

  const persistOpenTabs = useCallback((tabs: string[]) => {
    set(OPEN_TABS_KEY, tabs).catch((e) => console.warn('[fileStore] 持久化 openTabs 失败:', e))
  }, [])

  // 持久化
  const persist = useCallback((nextFiles: FileState[], nextCurrentId?: string) => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
    }
    saveTimerRef.current = window.setTimeout(() => {
      set(STORE_KEY, nextFiles).catch((e) => console.warn('[fileStore] 持久化失败:', e))
      if (nextCurrentId) {
        set(CURRENT_KEY, nextCurrentId).catch((e) => console.warn('[fileStore] 持久化 currentId 失败:', e))
      }
    }, SAVE_DEBOUNCE)
  }, [])

  // 修改当前文件
  const updateFile = useCallback((patch: Partial<FileState>) => {
    setFiles((prev) => {
      const next = prev.map((f) =>
        f.id === currentFileId ? { ...f, ...patch, updatedAt: Date.now() } : f
      )
      persist(next)
      return next
    })
  }, [currentFileId, persist])

  // 切换当前文件
  const switchFile = useCallback((id: string) => {
    setCurrentFileId(id)
    setOpenTabs((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      persistOpenTabs(next)
      return next
    })
    set(CURRENT_KEY, id).catch((e) => console.warn('[fileStore] 持久化 currentId 失败:', e))
  }, [persistOpenTabs])

  // 关闭标签(不删除文件)
  const closeTab = useCallback((id: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((t) => t !== id)
      persistOpenTabs(next)
      if (next.length === 0) {
        // 如果关了所有标签,打开第一个文件
        setFiles((fs) => {
          if (fs.length > 0) {
            setCurrentFileId(fs[0].id)
            setOpenTabs([fs[0].id])
            persistOpenTabs([fs[0].id])
          }
          return fs
        })
        return next
      }
      if (currentFileId === id) {
        const idx = prev.indexOf(id)
        const newId = next[Math.min(idx, next.length - 1)]
        setCurrentFileId(newId)
        set(CURRENT_KEY, newId).catch(() => {})
      }
      return next
    })
  }, [currentFileId, persistOpenTabs])

  // 重命名文件
  const renameFile = useCallback((id: string, name: string) => {
    setFiles((prev) => {
      const next = prev.map((f) => f.id === id ? { ...f, name, updatedAt: Date.now() } : f)
      persist(next)
      return next
    })
  }, [persist])

  // 新建文件
  const createFile = useCallback(() => {
    const id = `file-${Date.now()}`
    const name = `未命名-${fileCounter}.mmd`
    fileCounter++
    const newFile: FileState = {
      id,
      name,
      mermaidSource: 'flowchart TD\n',
      layoutOverrides: {},
      updatedAt: Date.now(),
    }
    setFiles((prev) => {
      const next = [...prev, newFile]
      persist(next, id)
      return next
    })
    setCurrentFileId(id)
    setOpenTabs((prev) => {
      const next = [...prev, id]
      persistOpenTabs(next)
      return next
    })
  }, [persist, persistOpenTabs])

  // 删除文件
  const deleteFile = useCallback((id: string) => {
    setFiles((prev) => {
      const next = prev.filter((f) => f.id !== id)
      if (next.length === 0) {
        const fallback: FileState = {
          id: `file-${Date.now()}`,
          name: '未命名-1.mmd',
          mermaidSource: 'flowchart TD\n',
          layoutOverrides: {},
          updatedAt: Date.now(),
        }
        next.push(fallback)
        setCurrentFileId(fallback.id)
        setOpenTabs([fallback.id])
        persistOpenTabs([fallback.id])
        persist(next, fallback.id)
      } else {
        if (currentFileId === id) {
          setCurrentFileId(next[0].id)
          persist(next, next[0].id)
        } else {
          persist(next)
        }
        setOpenTabs((prev) => {
          const nt = prev.filter((t) => t !== id)
          persistOpenTabs(nt)
          return nt
        })
      }
      return next
    })
  }, [currentFileId, persist, persistOpenTabs])

  // 立即落盘(供 Ctrl+S)
  const flush = useCallback(async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    try {
      await set(STORE_KEY, files)
      await set(CURRENT_KEY, currentFileId)
      await set(OPEN_TABS_KEY, openTabs)
    } catch (e) {
      console.warn('[fileStore] flush 失败:', e)
    }
  }, [files, currentFileId, openTabs])

  // 卸载前强制 flush
  useEffect(() => {
    const handler = () => void flush()
    window.addEventListener('beforeunload', handler)
    return () => {
      window.removeEventListener('beforeunload', handler)
      void flush()
    }
  }, [flush])

  return { file, files, currentFileId, openTabs, loaded, updateFile, switchFile, createFile, closeTab, renameFile, deleteFile, flush }
}

export function FileStoreProvider({ children }: { children: React.ReactNode }) {
  const store = useFileStoreInternal()
  return (
    <FileStoreContext.Provider value={store}>
      {children}
    </FileStoreContext.Provider>
  )
}

export function useFileStore(): FileStore {
  const ctx = useContext(FileStoreContext)
  if (!ctx) throw new Error('useFileStore must be used within FileStoreProvider')
  return ctx
}