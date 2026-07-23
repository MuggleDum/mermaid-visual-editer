// 错误边界 — 捕获组件树中未处理异常,防止白屏
import { Component } from 'react'

type Props = { children: React.ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-loading" style={{ flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 24, fontWeight: 700 }}>出错了</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 400, textAlign: 'center' }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => {
              this.setState({ error: null })
              window.location.reload()
            }}
            style={{
              padding: '6px 16px',
              borderRadius: 'var(--radius)',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            重新加载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}