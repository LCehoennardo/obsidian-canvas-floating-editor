# Canvas Floating Editor

Adds a **floating editor** for Obsidian Canvas text nodes — edit node content in a large, native, WYSIWYG editor instead of the tiny inline box.

## Why Canvas Floating Editor?

Obsidian Canvas already supports inline editing, but small cards can be uncomfortable for longer Markdown content. Canvas Floating Editor opens the selected text node in a larger, resizable floating editor while keeping the Canvas context visible.

Unlike a side-panel editor, the editor follows the selected Canvas node and can be opened directly from the node toolbar or context menu. It does not replace Canvas's native inline editor; it provides a larger editing surface for long or complex text nodes.

## Features

- **Floating Edit** on the node toolbar (pencil-ruler icon) and in the node context menu
- Embeds Obsidian's **native Markdown editor** (CodeMirror) inside a modal — full live-preview, WYSIWYG, all native keybindings
- **Autosave** while typing (debounced); changes are flushed when the modal closes
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

For a standalone clone of this plugin repository:

```bash
npm install
npm run dev          # esbuild watch → main.js in this repository
npm run build        # production build
npm run lint
```

When used inside the author's private `obsidian-plugins` workspace, the shared test vault is located at `../../dev-vault/`. The `open:vault` command is a macOS-only workspace convenience command; it is not required for building or installing the plugin.

## License

MIT
