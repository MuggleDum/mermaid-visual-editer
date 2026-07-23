# Mermaid Visual Editer

A visual flowchart editor powered by Mermaid — draw, edit, and style flowcharts directly on an interactive canvas, with real-time source code synchronization.

## Features

- **Visual Canvas Editing** — Click to add nodes, drag to connect edges, double-click to edit labels, all on an interactive SVG canvas
- **Real-time Source Sync** — Source code (Mermaid syntax) and visual canvas stay in sync; edit from either side
- **Multi-file Tabs** — Work on multiple flowchart files in tabs, with IndexedDB-based auto-save
- **Dark/Light Theme** — Toggle between dark and light themes; Mermaid rendering adapts automatically
- **Shape Palette** — Rectangle, rounded rectangle, ellipse, circle, diamond, parallelogram, hexagon, trapezoid
- **Export** — Export as SVG or PNG
- **Undo/Redo** — Full undo/redo history
- **Keyboard Shortcuts** — R/O/E/C/D/P/H/T for shapes, Delete to remove selected
- **Split View** — Resizable source/canvas split panel; toggle source visibility

## Tech Stack

- **React 19** + TypeScript
- **Vite** for build tooling
- **Mermaid 11** for diagram rendering
- **Monaco Editor** for source editing
- **IndexedDB** (via idb-keyval) for persistence

## Getting Started

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## Build

```bash
npm run build
npm run preview
```

## Project Structure

```
src/
  components/     # React components (CanvasView, Menubar, Sidebar, TabBar, etc.)
  lib/            # Core logic (mermaid rendering, source operations)
  store/          # File state management
  types.ts        # TypeScript type definitions
  App.tsx         # Main app component
  App.css         # App styles
  index.css       # Global styles & theme variables
```