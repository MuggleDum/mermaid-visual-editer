import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FileStoreProvider } from './store/fileStore'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FileStoreProvider>
      <App />
    </FileStoreProvider>
  </StrictMode>,
)