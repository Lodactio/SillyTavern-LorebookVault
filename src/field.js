import { RichEditor } from './editor.js';
import { renderMarkdown, escapeHtml } from './render.js';

/**
 * Wraps one of SillyTavern's textareas with a rich editor, a source view and a preview.
 *
 * The textarea stays in the DOM (hidden unless in source mode) and keeps owning the value:
 * edits are written back to it and announced with the same `input` / `change` / `blur` events
 * SillyTavern listens for, and values SillyTavern writes into it are picked up and shown.
 */

const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
const rawGet = (el) => valueDescriptor.get.call(el);
const rawSet = (el, value) => valueDescriptor.set.call(el, value);

/** @type {Set<RichField>} */
export const fields = new Set();

const FORMAT_BUTTONS = [
    { cmd: 'bold', icon: 'fa-bold', title: 'Bold (Ctrl+B)' },
    { cmd: 'italic', icon: 'fa-italic', title: 'Italic (Ctrl+I)' },
    { cmd: 'strike', icon: 'fa-strikethrough', title: 'Strikethrough' },
    { cmd: 'heading', icon: 'fa-heading', title: 'Heading (cycles # / ## / ###)' },
    { cmd: 'quote', icon: 'fa-quote-left', title: 'Quote' },
    { cmd: 'list', icon: 'fa-list-ul', title: 'Bullet list' },
    { cmd: 'code', icon: 'fa-terminal', title: 'Inline code' },
    { cmd: 'macro', icon: 'fa-dice-d6', title: 'Wrap in {{macro}}' },
];

const MODE_BUTTONS = [
    { mode: 'rich', icon: 'fa-pen-fancy', title: 'Rich editor' },
    { mode: 'source', icon: 'fa-align-left', title: 'Plain text' },
    { mode: 'split', icon: 'fa-table-columns', title: 'Rich editor + preview' },
    { mode: 'preview', icon: 'fa-eye', title: 'Preview' },
];

export class RichField {
    /**
     * @param {HTMLTextAreaElement} textarea
     * @param {object} options
     * @param {string} [options.group] Shown as a data attribute, for styling
     * @param {'rich'|'source'|'preview'|'split'} [options.mode]
     * @param {boolean} [options.allowSplit]
     * @param {boolean} [options.staticToolbar] Always show the toolbar instead of floating it on hover/focus
     * @param {boolean} [options.conceal]
     * @param {() => object|Promise<object>} [options.getData] Lorebook data for links and embeds
     * @param {() => string[]} [options.getLinkTargets] Enables `[[` autocomplete
     * @param {(target: string) => void} [options.onLinkClick]
     * @param {(file: File) => Promise<string|null>} [options.onPasteImage]
     * @param {Array<{icon: string, title: string, label?: string, onClick: () => void}>} [options.buttons]
     * @param {() => void} [options.onToggleXml]
     * @param {boolean} [options.managed] Lifetime handled by the caller (never disposed by scans)
     */
    constructor(textarea, options = {}) {
        this.textarea = textarea;
        this.options = options;
        this.mode = options.mode ?? 'rich';
        this.data = null;

        this.root = document.createElement('div');
        this.root.className = 'lv-field';
        if (options.group) this.root.dataset.group = options.group;
        if (options.staticToolbar) this.root.classList.add('lv-static-toolbar');
        // Fields that SillyTavern stretches to fill their container keep doing so
        if (textarea.matches('.flexGrow, .flex1, .height100p, .maximized_textarea, #mes_example_textarea, #firstmessage_textarea')) {
            this.root.classList.add('lv-fill');
        }
        if (textarea.matches('.flex1')) this.root.classList.add('flex1');
        if (textarea.matches('.flexGrow')) this.root.classList.add('flexGrow');
        const rows = Number(textarea.getAttribute('rows')) || (textarea.classList.contains('autoSetHeight') ? 1 : 3);
        this.root.style.setProperty('--lv-rows', String(Math.min(Math.max(rows, 1), 12)));

        this.editor = new RichEditor({
            placeholder: textarea.placeholder,
            conceal: options.conceal,
            onChange: text => this.pushToTextarea(text),
            onBlur: () => this.announceBlur(),
            onKeyDown: e => this.onSuggestKey(e),
            onPasteImage: options.onPasteImage,
        });

        this.toolbar = this.buildToolbar();
        this.preview = document.createElement('div');
        this.preview.className = 'lv-preview lv-markdown';
        this.preview.title = 'Double-click to edit';
        this.suggest = document.createElement('div');
        this.suggest.className = 'lv-suggest';

        textarea.before(this.root);
        this.panes = document.createElement('div');
        this.panes.className = 'lv-field-panes';
        this.panes.append(this.editor.el, textarea, this.preview);
        this.root.append(this.toolbar, this.panes, this.suggest);
        textarea.classList.add('lv-source');

        this.interceptValue();
        this.editor.setValue(rawGet(textarea));
        this.bindEvents();
        this.setMode(this.mode);
        this.syncDisabled();

        textarea.lvField = this;
        fields.add(this);
    }

    buildToolbar() {
        const tb = document.createElement('div');
        tb.className = 'lv-tb';
        const button = (cls, icon, title, attrs = '', label = '') =>
            `<div class="menu_button lv-tb-btn ${cls}" title="${escapeHtml(title)}" ${attrs}><i class="fa-solid ${icon}"></i>${label ? ` ${escapeHtml(label)}` : ''}</div>`;
        const modes = MODE_BUTTONS.filter(m => m.mode !== 'split' || this.options.allowSplit);
        tb.innerHTML = `
            <div class="lv-tb-group lv-tb-format">${FORMAT_BUTTONS.map(b => button('lv-fmt', b.icon, b.title, `data-cmd="${b.cmd}"`)).join('')}</div>
            <div class="lv-tb-group">
                ${button('lv-xml-toggle', 'fa-code', 'XML tags in preview: structured / raw')}
                ${modes.map(m => button('lv-mode', m.icon, m.title, `data-mode="${m.mode}"`)).join('')}
            </div>
            ${this.options.buttons?.length ? `<div class="lv-tb-group">${this.options.buttons.map((b, i) => button('lv-extra', b.icon, b.title, `data-i="${i}"`, b.label)).join('')}</div>` : ''}`;
        return tb;
    }

    bindEvents() {
        const tb = this.toolbar;
        // Keep focus (and the selection) in the editor while clicking toolbar buttons
        tb.addEventListener('mousedown', e => e.preventDefault());
        tb.addEventListener('click', (e) => {
            const btn = /** @type {HTMLElement} */ (e.target).closest('.lv-tb-btn');
            if (!btn) return;
            e.stopPropagation();
            if (btn.classList.contains('lv-mode')) this.setMode(btn.dataset.mode, true);
            else if (btn.classList.contains('lv-fmt')) this.format(btn.dataset.cmd);
            else if (btn.classList.contains('lv-xml-toggle')) this.options.onToggleXml?.();
            else if (btn.classList.contains('lv-extra')) this.options.buttons[Number(btn.dataset.i)]?.onClick();
        });

        this.preview.addEventListener('dblclick', (e) => {
            if (/** @type {HTMLElement} */ (e.target).closest('a, .lv-wikilink, summary')) return;
            this.setMode(this.mode === 'split' ? 'split' : 'rich', true);
            this.focus();
        });
        this.preview.addEventListener('click', (e) => {
            const link = /** @type {HTMLElement} */ (e.target).closest('.lv-wikilink');
            if (!link || !this.options.onLinkClick) return;
            e.preventDefault();
            const target = link.dataset.target;
            if (target) this.options.onLinkClick(target);
        });

        // Ctrl/Cmd+click a [[link]] in the editor to follow it
        this.editor.el.addEventListener('click', (e) => {
            const link = /** @type {HTMLElement} */ (e.target).closest('.lv-r-wikilink');
            if (link && (e.ctrlKey || e.metaKey) && this.options.onLinkClick) {
                e.preventDefault();
                this.options.onLinkClick(link.dataset.target);
                return;
            }
            this.updateSuggest();
        });
        this.editor.el.addEventListener('mouseover', (e) => {
            const link = /** @type {HTMLElement} */ (e.target).closest('.lv-r-wikilink');
            if (link && this.options.onLinkClick) link.title = 'Ctrl+click to open';
        });
        this.editor.el.addEventListener('focus', () => this.syncDisabled());
        this.editor.el.addEventListener('blur', () => setTimeout(() => this.hideSuggest(), 150));

        // Source mode: the textarea is edited directly
        this.textarea.addEventListener('input', () => {
            if (this.writing) return;
            this.editor.setValue(rawGet(this.textarea));
            this.refreshPreviewSoon();
            if (document.activeElement === this.textarea) this.updateSuggest();
        });
        this.textarea.addEventListener('keydown', e => this.onSuggestKey(e) && e.preventDefault());
        this.textarea.addEventListener('blur', () => setTimeout(() => this.hideSuggest(), 150));
        this.textarea.addEventListener('click', () => this.updateSuggest());
        this.textarea.addEventListener('paste', async (e) => {
            const image = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
            if (!image || !this.options.onPasteImage) return;
            e.preventDefault();
            const insert = await this.options.onPasteImage(image.getAsFile());
            if (insert) this.insertInTextarea(insert);
        });

        this.suggest.addEventListener('mousedown', e => e.preventDefault());
        this.suggest.addEventListener('click', (e) => {
            const item = /** @type {HTMLElement} */ (e.target).closest('.lv-suggest-item');
            if (item) this.applySuggest(Number(item.dataset.i));
        });
    }

    /** Catches values SillyTavern assigns with `.val()` / `.value =` (loading a character, switching presets...). */
    interceptValue() {
        const field = this;
        Object.defineProperty(this.textarea, 'value', {
            configurable: true,
            enumerable: true,
            get() { return rawGet(this); },
            set(value) {
                rawSet(this, value);
                if (!field.writing) {
                    field.editor.setValue(rawGet(this));
                    field.refreshPreviewSoon();
                }
            },
        });
    }

    destroy() {
        fields.delete(this);
        delete this.textarea.value;
        delete this.textarea.lvField;
        this.textarea.classList.remove('lv-source');
        this.root.before(this.textarea);
        this.editor.destroy();
        this.root.remove();
    }

    /** Releases a field whose DOM SillyTavern already threw away. */
    dispose() {
        fields.delete(this);
        this.editor.destroy();
    }

    get isConnected() {
        return this.root.isConnected;
    }

    getValue() {
        return rawGet(this.textarea);
    }

    /** Sets the value as if the user typed it: SillyTavern is notified. */
    setValue(text) {
        this.editor.setValue(text);
        this.pushToTextarea(this.editor.getValue());
    }

    /** Loads a value without notifying SillyTavern (e.g. switching entries in the Vault). */
    loadValue(text) {
        this.writing = true;
        rawSet(this.textarea, text);
        this.writing = false;
        this.editor.setValue(text);
        this.refreshPreview();
    }

    pushToTextarea(text) {
        this.writing = true;
        try {
            rawSet(this.textarea, text);
            this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } finally {
            this.writing = false;
        }
        this.dirty = true;
        this.refreshPreviewSoon();
        this.updateSuggest();
    }

    announceBlur() {
        if (!this.dirty) return;
        this.dirty = false;
        this.textarea.dispatchEvent(new Event('change', { bubbles: true }));
        this.textarea.dispatchEvent(new Event('blur'));
        this.textarea.dispatchEvent(new Event('focusout', { bubbles: true }));
    }

    syncDisabled() {
        this.editor.setEditable(!this.textarea.disabled && !this.textarea.readOnly);
    }

    setConceal(conceal) {
        this.editor.setConceal(conceal);
    }

    /**
     * @param {string} mode
     * @param {boolean} [byUser] Keeps focus where the user is working
     */
    setMode(mode, byUser = false) {
        if (mode === 'split' && !this.options.allowSplit) mode = 'rich';
        const wasSource = this.mode === 'source';
        this.mode = mode;
        this.root.dataset.mode = mode;
        this.toolbar.querySelectorAll('.lv-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        this.toolbar.querySelector('.lv-tb-format').classList.toggle('disabled', mode === 'preview');
        this.hideSuggest();
        if (wasSource) this.editor.setValue(rawGet(this.textarea));
        if (mode === 'preview' || mode === 'split') this.refreshPreview();
        if (mode === 'source' && this.textarea.classList.contains('autoSetHeight')) {
            // SillyTavern sized it while it was hidden; size it to its content again
            this.textarea.style.height = 'auto';
            this.textarea.style.height = `${this.textarea.scrollHeight + 4}px`;
        }
        if (byUser) {
            if (mode === 'source') this.textarea.focus();
            else if (mode !== 'preview') this.focus();
        }
    }

    focus() {
        if (this.mode === 'source') this.textarea.focus();
        else this.editor.focus();
    }

    async refreshPreview() {
        if (this.mode !== 'preview' && this.mode !== 'split') return;
        if (this.options.getData) this.data = await this.options.getData();
        this.preview.innerHTML = renderMarkdown(rawGet(this.textarea), this.data);
    }

    refreshPreviewSoon() {
        if (this.mode !== 'preview' && this.mode !== 'split') return;
        clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => this.refreshPreview(), 200);
    }

    // ----- formatting -----

    format(cmd) {
        if (this.mode === 'preview') return;
        const actions = {
            bold: ['wrap', '**'],
            italic: ['wrap', '*'],
            strike: ['wrap', '~~'],
            code: ['wrap', '`'],
            macro: ['wrap', '{{', '}}'],
            heading: ['lines', (line) => {
                const level = line.match(/^(#{1,6})\s/)?.[1].length ?? 0;
                const bare = line.replace(/^#{1,6}\s+/, '');
                return level >= 3 ? bare : `${'#'.repeat(level + 1)} ${bare}`;
            }],
            quote: ['lines', (line, _, lines) => lines.every(l => /^>/.test(l)) ? line.replace(/^>\s?/, '') : `> ${line}`],
            list: ['lines', (line, _, lines) => lines.every(l => /^\s*[-*+]\s/.test(l)) ? line.replace(/^(\s*)[-*+]\s/, '$1') : `- ${line}`],
        };
        const [kind, a, b] = actions[cmd] ?? [];
        if (!kind) return;

        if (this.mode === 'source') {
            this.formatTextarea(kind, a, b);
            return;
        }
        if (document.activeElement !== this.editor.el) this.editor.focus();
        if (kind === 'wrap') this.editor.wrap(a, b ?? a);
        else this.editor.transformLines(a);
    }

    formatTextarea(kind, a, b) {
        const ta = this.textarea;
        ta.focus();
        let { selectionStart: start, selectionEnd: end } = ta;
        const value = rawGet(ta);
        if (kind === 'wrap') {
            const close = b ?? a;
            const inner = value.slice(start, end);
            ta.setSelectionRange(start, end);
            this.insertInTextarea(a + inner + close);
            ta.setSelectionRange(start + a.length, start + a.length + inner.length);
        } else {
            start = value.lastIndexOf('\n', start - 1) + 1;
            end = value.indexOf('\n', end);
            if (end === -1) end = value.length;
            const lines = value.slice(start, end).split('\n');
            const result = lines.map(a).join('\n');
            ta.setSelectionRange(start, end);
            this.insertInTextarea(result);
            ta.setSelectionRange(start, start + result.length);
        }
    }

    /** Inserts into the textarea at its selection, keeping the browser's native undo working. */
    insertInTextarea(text) {
        const ta = this.textarea;
        ta.focus();
        if (!document.execCommand('insertText', false, text)) {
            ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // ----- [[ link autocomplete -----

    caretInfo() {
        if (this.mode === 'source') {
            return { text: rawGet(this.textarea), caret: this.textarea.selectionStart };
        }
        const selection = this.editor.getSelection();
        if (!selection || selection.start !== selection.end) return null;
        return { text: this.editor.getValue(), caret: selection.start };
    }

    updateSuggest() {
        if (!this.options.getLinkTargets || this.mode === 'preview') return;
        const info = this.caretInfo();
        if (!info) return this.hideSuggest();
        const match = info.text.slice(0, info.caret).match(/!?\[\[([^\]\n|#]*)$/);
        if (!match) return this.hideSuggest();
        const query = match[1].toLowerCase();
        this.suggestions = this.options.getLinkTargets().filter(t => t.toLowerCase().includes(query)).slice(0, 8);
        if (!this.suggestions.length) return this.hideSuggest();
        this.suggestIndex = 0;
        this.suggest.innerHTML = this.suggestions.map((t, i) => `<div class="lv-suggest-item ${i === 0 ? 'active' : ''}" data-i="${i}">${escapeHtml(t)}</div>`).join('');
        this.suggest.style.display = 'block';

        // Position under the caret in the rich editor; at the bottom of the textarea otherwise
        const selection = window.getSelection();
        if (this.mode !== 'source' && selection?.rangeCount) {
            const rect = selection.getRangeAt(0).getBoundingClientRect();
            const base = this.root.getBoundingClientRect();
            if (rect.height || rect.width) {
                this.suggest.style.left = `${Math.max(0, rect.left - base.left)}px`;
                this.suggest.style.top = `${rect.bottom - base.top + 2}px`;
                this.suggest.style.bottom = 'auto';
                return;
            }
        }
        this.suggest.style.left = '8px';
        this.suggest.style.top = 'auto';
        this.suggest.style.bottom = '8px';
    }

    hideSuggest() {
        this.suggest.style.display = 'none';
        this.suggestions = [];
    }

    applySuggest(i) {
        const target = this.suggestions?.[i];
        const info = this.caretInfo();
        if (!target || !info) return;
        const before = info.text.slice(0, info.caret);
        const after = info.text.slice(info.caret);
        const start = before.lastIndexOf('[[') + 2;
        const closed = after.startsWith(']]');
        const insert = target + (closed ? '' : ']]');
        const caret = start + insert.length + (closed ? 2 : 0);
        this.hideSuggest();
        if (this.mode === 'source') {
            this.textarea.setSelectionRange(start, info.caret);
            this.insertInTextarea(insert);
            this.textarea.setSelectionRange(caret, caret);
        } else {
            this.editor.replace(start, info.caret, insert, caret);
        }
    }

    /** @returns {boolean} True if the key was used by the suggestion list */
    onSuggestKey(e) {
        if (!this.suggestions?.length) return false;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            this.suggestIndex = (this.suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + this.suggestions.length) % this.suggestions.length;
            this.suggest.querySelectorAll('.lv-suggest-item').forEach((el, i) => el.classList.toggle('active', i === this.suggestIndex));
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            this.applySuggest(this.suggestIndex);
            return true;
        }
        if (e.key === 'Escape') {
            e.stopPropagation();
            this.hideSuggest();
            return true;
        }
        return false;
    }
}
