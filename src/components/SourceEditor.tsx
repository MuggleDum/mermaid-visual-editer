// 源码区 — Monaco 编辑器,绑定 Mermaid 语法高亮
// P0-MVP: 编辑 → onChange;不做格式化、不做错误行高亮(下一轮)
import Editor from '@monaco-editor/react'

type Props = {
  value: string
  onChange: (v: string) => void
  theme: 'light' | 'dark'
}

export function SourceEditor({ value, onChange, theme }: Props) {
  return (
    <Editor
      height="100%"
      defaultLanguage="markdown"
      value={value}
      theme={theme === 'dark' ? 'vs-dark' : 'vs'}
      options={{
        fontSize: 12.5,
        fontFamily: 'var(--font-mono)',
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        tabSize: 2,
        renderLineHighlight: 'gutter',
        padding: { top: 12, bottom: 12 },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      }}
      onChange={(v) => onChange(v ?? '')}
    />
  )
}
