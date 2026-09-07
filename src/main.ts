import {
	Plugin,
	PluginSettingTab,
	Setting,
	App,
	Modal,
	Notice,
	TFile,
	WorkspaceLeaf,
	MarkdownView,
	EventRef,
	setIcon,
	SettingDefinitionItem,
} from 'obsidian';

// ─── Settings ──────────────────────────────────────────────────────────────

interface CanvasFloatingEditorSettings {
	modalWidth: number;
	modalHeight: number;
}

const DEFAULT_SETTINGS: CanvasFloatingEditorSettings = {
	modalWidth: 760,
	modalHeight: 560,
};

// ─── Canvas runtime typings ─────────────────────────────────────────────────
// The Canvas API is not part of the official public API yet; these are the
// minimal shapes we rely on. All access is defensive (optional calls + try).

interface CanvasNodeDataLike {
	id?: string;
	type?: string;
	text?: string;
	[key: string]: unknown;
}

interface CanvasNodeLike {
	getData?: () => CanvasNodeDataLike | null;
	setData?: (data: CanvasNodeDataLike) => void;
	x?: number;
	y?: number;
}

interface CanvasLike {
	nodes?: Map<string, CanvasNodeLike>;
	selection?: Set<CanvasNodeLike>;
	requestSave?: () => void;
}

interface CanvasViewLike {
	canvas?: CanvasLike;
	file?: TFile | null;
	containerEl?: HTMLElement;
}

interface CanvasContext {
	canvas: CanvasLike | null;
	canvasFile: TFile | null;
	canvasNode: CanvasNodeLike | null;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class CanvasFloatingEditorPlugin extends Plugin {
	settings: CanvasFloatingEditorSettings = DEFAULT_SETTINGS;
	domObserver: MutationObserver | null = null;
	clickHandler: ((e: MouseEvent) => void) | null = null;
	contextMenuHandler: ((e: MouseEvent) => void) | null = null;
	lastInteractedNodeEl: HTMLElement | null = null;
	lastToolbarEl: HTMLElement | null = null;
	toolbarEnsureScheduled = false;
	activeModal: FloatingEditorModal | null = null;

	async onload() {
		await this.loadSettings();

		// 1. DOM observer: inject context-menu items and re-attach the
		//    toolbar button the moment Obsidian rebuilds the toolbar
		this.injectDomObserver();

		// 2. Click fast-path for the toolbar button + poll safety net
		this.injectToolbarButton();

		this.addSettingTab(new CanvasFloatingEditorSettingTab(this.app, this));
	}

	onunload() {
		this.activeModal?.close();
		this.activeModal = null;
		this.domObserver?.disconnect();
		if (this.clickHandler) {
			document.removeEventListener('click', this.clickHandler);
		}
		if (this.contextMenuHandler) {
			document.removeEventListener('contextmenu', this.contextMenuHandler);
		}
		this.lastInteractedNodeEl = null;
		// Remove buttons injected into toolbars (hot-reload / disable cleanup)
		const injected = document.querySelectorAll('.cfe-float-btn');
		for (let i = 0; i < injected.length; i++) {
			injected[i]?.remove();
		}
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<CanvasFloatingEditorSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ─── 1. Context menu injection ───────────────────────────────────────────

	injectDomObserver() {
		this.domObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (let i = 0; i < mutation.addedNodes.length; i++) {
					const node = mutation.addedNodes[i];
					if (!(node instanceof HTMLElement)) continue;

					const isMenu = node.classList?.contains('menu') ||
						node.querySelector<HTMLElement>('.menu-item') !== null;

					if (isMenu) {
						this.tryInjectMenuItem(node);
					}
				}
			}

			// The node toolbar gets rebuilt on resize/move/render with no
			// click event, wiping our injected button. Re-attach on the next
			// frame so it reappears as instantly as the native icons.
			this.scheduleToolbarEnsure();
		});

		this.domObserver.observe(document.body, { childList: true, subtree: true });
	}

	/**
	 * rAF-debounced ensureToolbarButton: coalesces mutation bursts (e.g.
	 * during a resize drag) into at most one check per frame.
	 */
	scheduleToolbarEnsure() {
		if (this.toolbarEnsureScheduled) return;
		this.toolbarEnsureScheduled = true;
		window.requestAnimationFrame(() => {
			this.toolbarEnsureScheduled = false;
			this.ensureToolbarButton();
		});
	}

	/**
	 * Only treat the open menu as a canvas node menu when the currently
	 * selected canvas node (canvas selects a node on right-click) belongs to
	 * an active canvas view. This avoids injecting into unrelated menus.
	 */
	isActiveCanvasNodeMenu(): HTMLElement | null {
		const node = this.findActiveCanvasNode();
		if (!node) return null;
		return this.isSingleTextNode(node) ? node : null;
	}

	tryInjectMenuItem(menuEl: HTMLElement) {
		if (menuEl.dataset.cfeInjected) return;
		// Mark first: every Menu instance builds a fresh DOM, so this only
		// guards against our own MutationObserver firing twice per menu.
		menuEl.dataset.cfeInjected = 'true';

		const canvasNode = this.isActiveCanvasNodeMenu();
		if (!canvasNode) return;

		const newItem = menuEl.createDiv('menu-item');
		newItem.setAttribute('data-section', 'canvas-floating-editor');
		const iconEl = newItem.createDiv('menu-item-icon');
		setIcon(iconEl, 'pencil-ruler');
		newItem.createDiv({ cls: 'menu-item-title', text: 'Floating edit' });

		newItem.addEventListener('click', () => {
			menuEl.dispatchEvent(new Event('close-menu', { bubbles: true }));
			this.openFloatingEditor(canvasNode);
		});
	}

	// ─── 2. Floating toolbar button injection ────────────────────────────────

	injectToolbarButton() {
		// Fast path: inject while the user interacts with a node
		this.clickHandler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			if (!target) return;

			const canvasNode = target.closest<HTMLElement>('.canvas-node');
			if (!canvasNode) return;
			this.lastInteractedNodeEl = canvasNode;

			window.requestAnimationFrame(() => {
				if (!this.isSingleTextNode(canvasNode)) {
					this.removeToolbarButton();
					return;
				}
				this.injectButtonIntoToolbar(canvasNode);
			});
		};

		this.contextMenuHandler = (e: MouseEvent) => {
			const target = e.target as HTMLElement;
			const canvasNode = target?.closest<HTMLElement>('.canvas-node');
			if (canvasNode) this.lastInteractedNodeEl = canvasNode;
		};

		document.addEventListener('click', this.clickHandler);
		document.addEventListener('contextmenu', this.contextMenuHandler);

		// Backup safety net (the DOM observer above is the primary trigger):
		// periodic re-check while a node is selected. Cheap: remembered
		// element or early exit when nothing is selected.
		this.registerInterval(
			window.setInterval(() => {
				this.ensureToolbarButton();
			}, 400),
		);
	}

	/**
	 * Poll safety net: make sure the selected node's toolbar carries our
	 * button. Avoids the full-document toolbar search whenever possible.
	 */
	ensureToolbarButton() {
		const node = this.findActiveCanvasNode();
		if (!node || !this.isSingleTextNode(node)) {
			this.removeToolbarButton();
			return;
		}

		// Toolbar element from a previous injection is still in the DOM?
		if (this.lastToolbarEl?.isConnected) {
			if (!this.lastToolbarEl.querySelector('.cfe-float-btn')) {
				// Rebuilt/wiped toolbar: re-attach our button
				this.appendToolbarButton(this.lastToolbarEl, node);
			}
			return;
		}
		this.lastToolbarEl = null;
		this.injectButtonIntoToolbar(node);
	}

	/**
	 * The node toolbar is a floating element shown above the selected node.
	 * We locate it by geometry (a row of buttons right above the node) and
	 * append one more button.
	 */
	injectButtonIntoToolbar(nodeEl: HTMLElement) {
		const nodeRect = nodeEl.getBoundingClientRect();

		const candidates = document.querySelectorAll<HTMLElement>('div');
		let toolbar: HTMLElement | null = null;

		for (let i = 0; i < candidates.length; i++) {
			const div = candidates[i];
			if (!div) continue;
			if (nodeEl.contains(div) || div === nodeEl) continue;

			const buttons = div.querySelectorAll(':scope > button, :scope > .clickable-icon');
			if (buttons.length < 2 || buttons.length > 8) continue;

			const divRect = div.getBoundingClientRect();
			if (divRect.width === 0 && divRect.height === 0) continue;

			const verticalDist = nodeRect.top - divRect.bottom;
			const horizontalAlign = Math.abs(
				divRect.left + divRect.width / 2 - nodeRect.left - nodeRect.width / 2,
			);

			if (verticalDist >= -5 && verticalDist <= 100 && horizontalAlign < 150) {
				toolbar = div;
				break;
			}
		}

		if (!toolbar) return;
		this.lastToolbarEl = toolbar;
		this.appendToolbarButton(toolbar, nodeEl);
	}

	/**
	 * Append the "Floating edit" button to a toolbar (idempotent).
	 */
	appendToolbarButton(toolbar: HTMLElement, nodeEl: HTMLElement) {
		if (toolbar.querySelector('.cfe-float-btn')) return;

		// clickable-icon: same styling as the native toolbar icons
		const btn = toolbar.createEl('button', {
			cls: 'clickable-icon cfe-float-btn',
			attr: { 'aria-label': 'Floating edit' },
		});
		setIcon(btn, 'pencil-ruler');

		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			const currentNode = this.findActiveCanvasNode() ?? nodeEl;
			if (!this.isSingleTextNode(currentNode)) return;
			this.openFloatingEditor(currentNode);
		});
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	findActiveCanvasNode(): HTMLElement | null {
		const recent = this.lastInteractedNodeEl;
		if (recent?.isConnected && (
			recent.classList.contains('is-focused') ||
			recent.classList.contains('is-selected') ||
			recent.classList.contains('is-editing')
		)) {
			return recent;
		}

		// Never pick the first match across several Canvas tabs. A unique
		// match is safe; otherwise wait for an interaction to identify the tab.
		const nodes = document.querySelectorAll<HTMLElement>(
			'.canvas-node.is-focused, .canvas-node.is-selected, .canvas-node.is-editing',
		);
		return nodes.length === 1 ? nodes[0] ?? null : null;
	}

	removeToolbarButton() {
		this.lastToolbarEl?.querySelector('.cfe-float-btn')?.remove();
		this.lastToolbarEl = null;
	}

	isSingleTextNode(nodeEl: HTMLElement): boolean {
		const context = this.findCanvasContext(nodeEl);
		if (!context.canvas || context.canvas.selection?.size !== 1) return false;
		return context.canvasNode?.getData?.()?.type === 'text';
	}

	/** Find the Canvas runtime belonging to this DOM node, not another tab. */
	findCanvasForNode(nodeEl: HTMLElement): CanvasLike | null {
		const nodeRoot = nodeEl.closest<HTMLElement>('.canvas-node') ?? nodeEl;
		const leaves = this.app.workspace.getLeavesOfType('canvas');
		for (const leaf of leaves) {
			const view = leaf.view as CanvasViewLike;
			if (view.containerEl?.contains(nodeRoot)) return view.canvas ?? null;
		}
		return null;
	}

	/**
	 * Resolve the canvas runtime objects for the given node element.
	 * Node instances are resolved in order: canvas.selection → data-id →
	 * CSS transform position match.
	 */
	findCanvasContext(nodeEl: HTMLElement): CanvasContext {
		const nodeRoot = nodeEl.closest<HTMLElement>('.canvas-node') ?? nodeEl;

		const leaves = this.app.workspace.getLeavesOfType('canvas');
		for (const leaf of leaves) {
			const view = leaf.view as CanvasViewLike;
			const canvas = view?.canvas;
			if (!canvas || !view.containerEl?.contains(nodeRoot)) continue;

			const canvasFile: TFile | null = view.file ?? null;
			const selectionSize = canvas.selection?.size ?? 0;
			if (selectionSize > 1) {
				return { canvas, canvasFile, canvasNode: null };
			}

			// 1) Resolve by the clicked DOM node's id first. This prevents
			// multi-selection from selecting an unrelated node.
			let canvasNode: CanvasNodeLike | null = null;
			const nodeId = nodeRoot.dataset?.id ?? null;
			if (nodeId && canvas.nodes) {
				canvasNode = canvas.nodes.get(nodeId) ?? null;
			}

			// 2) Selection is only a safe fallback for exactly one selected node.
			if (!canvasNode) {
				try {
					const sel = Array.from(canvas.selection ?? []);
					if (sel.length === 1) canvasNode = sel[0] ?? null;
				} catch {
					/* ignore */
				}
			}

			// 3) CSS transform position match fallback
			if (!canvasNode && canvas.nodes) {
				const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(
					nodeRoot.getAttribute('style') ?? '',
				);
				if (m && m[1] !== undefined && m[2] !== undefined) {
					const x = parseFloat(m[1]);
					const y = parseFloat(m[2]);
					for (const [, n] of canvas.nodes) {
						if (Math.abs((n.x ?? NaN) - x) < 0.5 && Math.abs((n.y ?? NaN) - y) < 0.5) {
							canvasNode = n;
							break;
						}
					}
				}
			}

			return { canvas, canvasFile, canvasNode };
		}

		return { canvas: null, canvasFile: null, canvasNode: null };
	}

	// ─── Floating editor ─────────────────────────────────────────────────────

	openFloatingEditor(nodeEl: HTMLElement) {
		if (this.activeModal || !this.isSingleTextNode(nodeEl)) return;
		const modal = new FloatingEditorModal(this.app, this, nodeEl);
		this.activeModal = modal;
		modal.open();
	}

	clearActiveModal(modal: FloatingEditorModal) {
		if (this.activeModal === modal) this.activeModal = null;
	}
}

// ─── Floating Editor Modal ─────────────────────────────────────────────────
// Embeds Obsidian's native MarkdownView (CodeMirror, live preview WYSIWYG).

class FloatingEditorModal extends Modal {
	plugin: CanvasFloatingEditorPlugin;
	nodeEl: HTMLElement;
	ctx: CanvasContext;

	mdLeaf: WorkspaceLeaf | null = null;
	mdView: MarkdownView | null = null;

	originalText: string = '';
	hasRawSource: boolean = false;

	// Autosave
	changeRef: EventRef | null = null;
	autoSaveTimer: number | null = null;

	// Manual resize (persisted to settings)
	resizeObserver: ResizeObserver | null = null;
	resizeSaveTimer: number | null = null;

	constructor(app: App, plugin: CanvasFloatingEditorPlugin, nodeEl: HTMLElement) {
		super(app);
		this.plugin = plugin;
		this.nodeEl = nodeEl;
		this.ctx = plugin.findCanvasContext(nodeEl);
	}

	async onOpen() {
		const { contentEl } = this;

		this.modalEl.addClass('cfe-modal');
		this.modalEl.setAttribute(
			'style',
			`--editor-width: ${this.plugin.settings.modalWidth}px; --editor-height: ${this.plugin.settings.modalHeight}px;`,
		);

		this.setTitle('Floating editor');

		// Track manual resizing via the CSS `resize: both` handle and persist
		// the chosen size back to the plugin settings (debounced).
		this.resizeObserver = new ResizeObserver(() => {
			// Use border-box dimensions: settings values feed the CSS `width`/
			// `height` properties (box-sizing: border-box), so measuring the
			// content box instead would shrink the saved size on every cycle.
			const width = this.modalEl.offsetWidth;
			const height = this.modalEl.offsetHeight;
			if (width < 200 || height < 200) return;
			// Skip no-op observations (e.g. the initial layout pass)
			if (width === this.plugin.settings.modalWidth && height === this.plugin.settings.modalHeight) {
				return;
			}
			this.plugin.settings.modalWidth = width;
			this.plugin.settings.modalHeight = height;
			if (this.resizeSaveTimer !== null) {
				window.clearTimeout(this.resizeSaveTimer);
			}
			this.resizeSaveTimer = window.setTimeout(() => {
				this.resizeSaveTimer = null;
				void this.plugin.saveSettings();
			}, 500);
		});
		this.resizeObserver.observe(this.modalEl);

		// Read the node's raw markdown
		const loaded = await this.loadNodeMarkdown();
		this.originalText = loaded.text;
		this.hasRawSource = loaded.raw;

		if (!loaded.raw) {
			new Notice('Unable to read the raw Markdown of this node. Editing is read-only.');
		}

		const editorContainer = contentEl.createDiv('cfe-editor-container');

		// ── Mount the native MarkdownView editor ──
		if (loaded.raw) {
			try {
				this.mdLeaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(this.app);
				this.mdView = new MarkdownView(this.mdLeaf);
				await this.mdLeaf.open(this.mdView);
				const viewContainer = (this.mdView as unknown as { containerEl: HTMLElement }).containerEl;
				editorContainer.appendChild(viewContainer);

				// Go straight to editing mode (reading view renders no editor)
				const state = this.mdView.getState();
				state.mode = 'source';
				await this.mdView.setState(state, {} as Parameters<MarkdownView['setState']>[1]);

				// Load content (clear = fresh document)
				this.mdView.setViewData(loaded.text, true);

				// A detached leaf is never "activated", so CodeMirror misses
				// its initial measurement → nudge a re-layout.
				window.setTimeout(() => {
					viewContainer.dispatchEvent(new Event('cm6-resize'));
					window.dispatchEvent(new Event('resize'));
				}, 50);

				// Autosave trigger 1: workspace editor-change event
				this.changeRef = this.app.workspace.on(
					'editor-change',
					(editor, info) => {
						if (this.mdView && editor === this.mdView.editor) {
							this.scheduleAutoSave();
						}
					},
				);

				// Autosave trigger 2 (redundant): native DOM input events from
				// CodeMirror bubble up to the container. Covers environments
				// where the workspace event does not reach this detached leaf.
				editorContainer.addEventListener('input', () => {
					this.scheduleAutoSave();
				});
			} catch (e) {
				console.error('[CanvasFloatingEditor] failed to mount native editor:', e);
				this.mdLeaf?.detach?.();
				this.mdLeaf = null;
				this.mdView = null;
				this.mountFallbackTextarea(editorContainer, loaded.text, true);
			}
		} else {
			this.mountFallbackTextarea(editorContainer, loaded.text, false);
		}
	}

	onClose() {
		// Stop autosave timers/listeners
		if (this.autoSaveTimer !== null) {
			window.clearTimeout(this.autoSaveTimer);
			this.autoSaveTimer = null;
		}
		if (this.changeRef) {
			this.app.workspace.offref(this.changeRef);
			this.changeRef = null;
		}

		// Stop resize tracking; flush a pending size so closing right after a
		// drag does not lose the last adjustment.
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.resizeSaveTimer !== null) {
			window.clearTimeout(this.resizeSaveTimer);
			this.resizeSaveTimer = null;
			void this.plugin.saveSettings();
		}

		// Flush pending changes; the editor content must be read before detach
		void this.saveNodeText();

		try {
			this.mdLeaf?.detach();
		} catch {
			/* ignore */
		}
		this.mdLeaf = null;
		this.mdView = null;

		contentElEmpty(this);
		this.plugin.clearActiveModal(this);
	}

	/**
	 * Debounced autosave after content changes.
	 */
	scheduleAutoSave() {
		if (!this.hasRawSource) return;
		if (this.autoSaveTimer !== null) {
			window.clearTimeout(this.autoSaveTimer);
		}
		this.autoSaveTimer = window.setTimeout(() => {
			this.autoSaveTimer = null;
			void this.saveNodeText();
		}, 800);
	}

	/**
	 * Fallback plain textarea when the native editor cannot be mounted.
	 * Read-only when no raw source is available (nothing could be saved).
	 */
	mountFallbackTextarea(container: HTMLElement, text: string, editable: boolean) {
		const ta = container.createEl('textarea', { cls: 'cfe-fallback-textarea' });
		ta.value = text;
		if (!editable) {
			ta.readOnly = true;
			ta.addClass('cfe-fallback-readonly');
			return;
		}
		ta.addEventListener('input', () => {
			this.scheduleAutoSave();
		});
	}

	// ─── Read raw markdown ───────────────────────────────────────────────────

	async loadNodeMarkdown(): Promise<{ text: string; raw: boolean }> {
		const { canvas, canvasFile, canvasNode } = this.ctx;

		// 1. Canvas runtime node instance (includes unsaved edits)
		if (canvasNode?.getData) {
			try {
				const data = canvasNode.getData();
				if (data?.type === 'text' && typeof data.text === 'string') {
					return { text: data.text, raw: true };
				}
				if (data && data.type !== 'text') {
					return { text: '', raw: false };
				}
			} catch (e) {
				console.warn('[CanvasFloatingEditor] runtime read failed:', e);
			}
		}

		// 2. Canvas runtime map + data-id
		const nodeRoot = this.nodeEl.closest<HTMLElement>('.canvas-node') ?? this.nodeEl;
		const nodeId = canvasNode?.getData?.()?.id ?? nodeRoot.dataset?.id ?? null;
		if (canvas?.nodes && nodeId) {
			try {
				const node = canvas.nodes.get(nodeId);
				const data = node?.getData?.();
				if (data?.type === 'text' && typeof data.text === 'string') {
					return { text: data.text, raw: true };
				}
			} catch {
				/* ignore */
			}
		}

		// 3. Canvas file JSON (raw markdown source)
		if (canvasFile && nodeId) {
			try {
				const json = JSON.parse(await this.app.vault.cachedRead(canvasFile)) as {
					nodes?: Array<{ id?: string; type?: string; text?: string }>;
				};
				const nd = json.nodes?.find((n) => n.id === nodeId);
				if (nd && typeof nd.text === 'string') {
					return { text: nd.text, raw: true };
				}
			} catch (e) {
				console.warn('[CanvasFloatingEditor] file read failed:', e);
			}
		}

		// 4. DOM fallback (rendered text; markdown syntax is lost)
		const previewEl = nodeRoot.querySelector<HTMLElement>(
			'.markdown-preview-view, .canvas-node-content',
		);
		return {
			text: previewEl?.innerText ?? nodeRoot.innerText ?? '',
			raw: false,
		};
	}

	// ─── Save ────────────────────────────────────────────────────────────────

	getCurrentText(): string | null {
		if (this.mdView) {
			return this.mdView.getViewData();
		}
		const ta = this.contentEl.querySelector<HTMLTextAreaElement>(
			'.cfe-fallback-textarea',
		);
		return ta?.value ?? null;
	}

	async saveNodeText() {
		const newText = this.getCurrentText();
		if (newText === null) return;
		if (newText === this.originalText) return;

		if (!this.hasRawSource) {
			new Notice('Save failed: the raw Markdown of this node is unavailable.');
			return;
		}

		const { canvas, canvasFile, canvasNode } = this.ctx;
		const nodeRoot = this.nodeEl.closest<HTMLElement>('.canvas-node') ?? this.nodeEl;
		const nodeId = canvasNode?.getData?.()?.id ?? nodeRoot.dataset?.id ?? null;

		// Refuse to save if the current Canvas is multi-selected. This is a
		// final guard against editing the wrong node.
		if (canvas?.selection && canvas.selection.size !== 1) {
			new Notice('Save failed: select exactly one canvas node.');
			return;
		}

		// 1. Canvas runtime API (preferred, updates the canvas instantly)
		const node = canvasNode ?? (canvas && nodeId ? canvas.nodes?.get(nodeId) : null);
		if (node?.setData && canvas) {
			try {
				const data = node.getData?.();
				if (data?.type === 'text') {
					node.setData({ ...data, text: newText });
					canvas.requestSave?.();
					this.originalText = newText;
					return;
				}
			} catch (e) {
				console.warn('[CanvasFloatingEditor] canvas API save failed:', e);
			}
		}

		// 2. File-level fallback: rewrite the .canvas JSON on disk
		if (canvasFile && nodeId) {
			try {
				await this.app.vault.process(canvasFile, (content) => {
					const json = JSON.parse(content) as {
						nodes?: Array<{ id?: string; type?: string; text?: string }>;
					};
					const nd = json.nodes?.find((n) => n.id === nodeId);
					if (!nd || typeof nd.text !== 'string') {
						throw new Error('Canvas text node not found');
					}
					nd.text = newText;
					return JSON.stringify(json);
				});
				this.originalText = newText;
				return;
			} catch (e) {
				console.warn('[CanvasFloatingEditor] file save failed:', e);
			}
		}

		new Notice('Save failed: cannot access the canvas data.');
	}
}

/** Empty the modal content (helper to keep onClose tidy). */
function contentElEmpty(modal: FloatingEditorModal) {
	modal.contentEl.empty();
}

// ─── Settings Tab ──────────────────────────────────────────────────────────
// Dual implementation: display() for Obsidian < 1.13, declarative
// getSettingDefinitions() for 1.13+ (enables the settings search index).

class CanvasFloatingEditorSettingTab extends PluginSettingTab {
	plugin: CanvasFloatingEditorPlugin;

	constructor(app: App, plugin: CanvasFloatingEditorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Editor width',
				desc: 'Width of the floating editor modal, in pixels.',
				control: {
					type: 'number',
					key: 'modalWidth',
					defaultValue: 760,
					validate: (value) =>
						Number.isFinite(value) && value >= 200
							? undefined
							: 'Width must be a number of at least 200.',
				},
			},
			{
				name: 'Editor height',
				desc: 'Height of the floating editor modal, in pixels.',
				control: {
					type: 'number',
					key: 'modalHeight',
					defaultValue: 560,
					validate: (value) =>
						Number.isFinite(value) && value >= 200
							? undefined
							: 'Height must be a number of at least 200.',
				},
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Editor width')
			.setDesc('Width of the floating editor modal, in pixels.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.modalWidth))
					.onChange(async (value) => {
						this.plugin.settings.modalWidth = parseInt(value) || 760;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Editor height')
			.setDesc('Height of the floating editor modal, in pixels.')
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.modalHeight))
					.onChange(async (value) => {
						this.plugin.settings.modalHeight = parseInt(value) || 560;
						await this.plugin.saveSettings();
					}),
			);
	}
}
