# Canvas Floating Editor

Adds a **floating editor** for Obsidian Canvas text nodes — edit node content in a large, native, WYSIWYG editor instead of the tiny inline box.

![Demo](https://img.shields.io/badge/Obsidian-Canvas%20Floating%20Editor-7c3aed)

## Features

- **Floating Edit** on the node toolbar (pencil-ruler icon) and in the node context menu
- Embeds Obsidian's **native Markdown editor** (CodeMirror) inside a modal — full live-preview, WYSIWYG, all native keybindings
- **Autosave** while typing (debounced), so closing the modal never loses changes
- **Resizable modal** — drag the bottom-right handle; your preferred size is remembered in settings
- Preserves the node's raw Markdown source (headings, lists, code blocks, …)
- Configurable editor width & height in settings

## How it works

The floating editor reads the node's raw markdown from the canvas runtime (falling back to the `.canvas` JSON on disk) and saves through the canvas API (`node.setData()` + `requestSave()`), with a file-level write as last resort. The menu item and toolbar button are injected via lightweight DOM observation; everything is cleaned up on plugin unload.

## Notes & limitations

- Only **text nodes** are editable; file/link/group nodes are ignored
- English UI text (per Obsidian community-plugin guidelines); the editor itself is the native one and follows your app language
- Requires Obsidian **1.9.0+**

## Manual installation

1. Download `main.js`, `manifest.json`, `styles.css` from the latest release
2. Put them in `<vault>/.obsidian/plugins/canvas-floating-editor/`
3. Enable **Canvas Floating Editor** in Settings → Community plugins

## Development

```bash
npm install
npm run dev          # esbuild watch → main.js at repo root
npm run open:vault   # open the bundled test vault (hot-reload wired up)
```

The bundled `vault/` symlinks the built plugin into `.obsidian/plugins/canvas-floating-editor/`; the Hot Reload plugin picks up rebuilds automatically.

## License

MIT
