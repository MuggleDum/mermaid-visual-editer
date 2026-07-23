// 底部状态条
type Props = {
  saved: boolean
  source: string
  error: string | null
}

function countNodesAndEdges(src: string): { nodes: number; edges: number } {
  const lines = src.split('\n').filter((l) => {
    const t = l.trim()
    return t && !t.startsWith('%%') && !/^(?:flowchart|graph|subgraph|end)\b/i.test(t)
  })

  const nodeIds = new Set<string>()
  let edges = 0

  for (const line of lines) {
    const trimmed = line.trim()
    // 节点声明: X[...] / X{...} / X((...)) / X([...]) / X[\/...\/] 等
    const nodeMatches = trimmed.matchAll(
      /\b([A-Za-z0-9_]+)\s*(?:\[[^\]]*\]|\{[^}]*\}|\(\([^)]*\)\)|\(\[[^\]]*\]\)|\[[\\/][^\]]*[\\/]\])/g
    )
    for (const m of nodeMatches) nodeIds.add(m[1])
    // 边箭头:支持 -->  /  ---  /  ==>  /  -.->  /  -- 等
    const edgeMatches = trimmed.matchAll(/\b([A-Za-z0-9_]+)\s*(?:-->|=+>|---|\.->|--)\s*(?:\|[^|]*\|\s*)?/g)
    for (const m of edgeMatches) {
      edges++
      nodeIds.add(m[1])
    }
  }

  return { nodes: nodeIds.size, edges }
}

export function StatusBar({ saved, source, error }: Props) {
  const { nodes, edges } = countNodesAndEdges(source)
  return (
    <div className="statusbar">
      <span className={`seg ${saved ? 'ok' : 'warn'}`}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
          <circle cx="5" cy="5" r="4" />
        </svg>
        {saved ? '已自动保存' : '保存中...'}
      </span>
      {error ? (
        <span className="seg" style={{ color: 'var(--warn)' }}>
          解析错误:{error}
        </span>
      ) : (
        <>
          <span className="seg">节点 {nodes}</span>
          <span className="seg">边 {edges}</span>
        </>
      )}
      <span className="spacer" />
      <span className="seg">Mermaid 11.x</span>
    </div>
  )
}
