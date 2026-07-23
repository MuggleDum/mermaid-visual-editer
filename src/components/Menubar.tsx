// 顶部菜单栏
type Props = {
  onToggleSidebar: () => void
  onToggleTheme: () => void
  theme: 'light' | 'dark'
  sidebarVisible: boolean
}

export function Menubar({ onToggleSidebar, onToggleTheme, theme, sidebarVisible }: Props) {
  return (
    <div className="menubar">
      <div className="brand">
        <div className="logo" />
        <span>Mermaid Visual Editer</span>
      </div>
      <div className="spacer" />
      <div className="menubar-actions">
        <button
          className="menubar-btn"
          title={sidebarVisible ? '隐藏文件列表' : '显示文件列表'}
          onClick={onToggleSidebar}
          aria-label="切换文件列表"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <line x1="9" y1="3" x2="9" y2="21" />
            <line x1="5" y1="9" x2="7" y2="9" strokeWidth="1.8" />
            <line x1="5" y1="15" x2="7" y2="15" strokeWidth="1.8" />
          </svg>
        </button>
        <button className="menubar-btn" title={theme === 'light' ? '切换到暗色主题' : '切换到亮色主题'} onClick={onToggleTheme} aria-label="主题">
          {theme === 'light' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5d4037" strokeWidth="2" strokeLinecap="round">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="2.5" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="21.5" />
              <line x1="2.5" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="21.5" y2="12" />
              <line x1="5.3" y1="5.3" x2="7" y2="7" />
              <line x1="17" y1="17" x2="18.7" y2="18.7" />
              <line x1="5.3" y1="18.7" x2="7" y2="17" />
              <line x1="17" y1="7" x2="18.7" y2="5.3" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5d4037" strokeWidth="2" strokeLinejoin="round">
              <path d="M20,14 A8,8 0 1,1 14,4 A6,6 0 0,0 20,14 Z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}