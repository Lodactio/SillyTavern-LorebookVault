import { highlightSource } from './highlight.js';

/**
 * A contenteditable editor that shows prompt source with its markdown, macros and tags styled
 * in place. The plain text stays the single source of truth: edits are applied to the text (or
 * read back from the DOM as text) and re-highlighted, so what you see is exactly what gets sent
 * to the model.
 */

const supportsPlaintextOnly = (() => {
    const probe = document.createElement('div');
    try {
        probe.contentEditable = 'plaintext-only';
    } catch {
        return false;
    }
    return probe.contentEditable === 'plaintext-only';
})();

const isBlock = (node) => node.nodeType === Node.ELEMENT_NODE && (/** @type {Element} */ (node).tagName === 'DIV' || /** @type {Element} */ (node).tagName === 'P');

/** A `<br>` at the end of a block only keeps an empty line open; it is not a newline. */
function isPlaceholderBr(br) {
    let next = br.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !(/** @type {Text} */ (next)).data) next = next.nextSibling;
    return !next && br.parentNode && (isBlock(br.parentNode) || br.parentNode.classList?.contains('lv-rich'));
}

/**
 * Reads the text of the editor (or of one line) and converts DOM points into text offsets.
 * Each block is a line. Also copes with the `<br>` / `<div>` nodes a browser may insert by itself.
 * @param {HTMLElement} root
 * @param {Array<{node: Node, offset: number}>} points
 */
function readDom(root, points = []) {
    let text = '';
    let blocks = 0;
    let afterBlock = false;
    const offsets = points.map(() => -1);
    const mark = (node, offset) => points.forEach((p, i) => {
        if (offsets[i] === -1 && p.node === node && p.offset === offset) offsets[i] = text.length;
    });

    const visit = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const data = /** @type {Text} */ (node).data;
            if (afterBlock && data) {
                text += '\n';
                afterBlock = false;
            }
            points.forEach((p, i) => {
                if (offsets[i] === -1 && p.node === node) offsets[i] = text.length + Math.min(p.offset, data.length);
            });
            text += data;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = /** @type {HTMLElement} */ (node);
        if (el.tagName === 'BR') {
            if (!isPlaceholderBr(el)) text += '\n';
            return;
        }
        const children = el.childNodes;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (isBlock(child)) {
                // A new line starts, unless this is the very first thing in the editor
                if (blocks++ > 0 || text.length) text += '\n';
                afterBlock = false;
            }
            mark(el, i);
            visit(child);
            if (isBlock(child)) afterBlock = true;
        }
        mark(el, children.length);
    };
    visit(root);
    return { text, offsets };
}

export class RichEditor {
    /**
     * @param {object} options
     * @param {(text: string) => void} [options.onChange] Called after every user edit
     * @param {() => void} [options.onBlur]
     * @param {(e: KeyboardEvent) => boolean|void} [options.onKeyDown] Return true to swallow the key
     * @param {(file: File) => Promise<string|null>} [options.onPasteImage] Returns text to insert
     * @param {string} [options.placeholder]
     * @param {boolean} [options.conceal] Hide markup on lines that aren't being edited
     */
    constructor(options = {}) {
        this.options = options;
        this.text = '';
        this.lineStarts = [0];
        this.activeLines = new Set();
        this.history = [];
        this.future = [];
        this.lastPush = 0;
        this.composing = false;

        this.el = document.createElement('div');
        this.el.className = 'lv-rich';
        this.el.spellcheck = true;
        this.el.setAttribute('role', 'textbox');
        this.el.setAttribute('aria-multiline', 'true');
        this.el.dataset.placeholder = options.placeholder ?? '';
        this.setEditable(true);
        this.setConceal(options.conceal ?? true);

        this.el.addEventListener('beforeinput', e => this.onBeforeInput(e));
        this.el.addEventListener('input', () => this.onInput());
        this.el.addEventListener('compositionstart', () => { this.composing = true; });
        this.el.addEventListener('compositionend', () => {
            this.composing = false;
            this.onInput();
        });
        this.el.addEventListener('keydown', e => this.onKeyDown(e));
        this.el.addEventListener('paste', e => this.onPaste(e));
        this.el.addEventListener('copy', e => this.onCopy(e, false));
        this.el.addEventListener('cut', e => this.onCopy(e, true));
        this.el.addEventListener('drop', e => this.onDrop(e));
        this.el.addEventListener('focus', () => this.updateActiveLines());
        this.el.addEventListener('blur', () => {
            this.setActiveLines(new Set());
            this.options.onBlur?.();
        });

        this.onSelectionChange = () => {
            if (document.activeElement === this.el) this.updateActiveLines();
        };
        document.addEventListener('selectionchange', this.onSelectionChange);

        this.render();
    }

    destroy() {
        document.removeEventListener('selectionchange', this.onSelectionChange);
        this.el.remove();
    }

    setEditable(editable) {
        this.el.contentEditable = editable ? (supportsPlaintextOnly ? 'plaintext-only' : 'true') : 'false';
        this.el.classList.toggle('lv-readonly', !editable);
    }

    setConceal(conceal) {
        this.el.classList.toggle('lv-conceal', Boolean(conceal));
    }

    focus() {
        this.el.focus({ preventScroll: true });
    }

    getValue() {
        return this.text;
    }

    /** Replaces the content without recording undo history (e.g. when another entry loads). */
    setValue(text) {
        text = String(text ?? '').replace(/\r\n?/g, '\n');
        if (text === this.text) return;
        const focused = document.activeElement === this.el;
        const selection = focused ? this.getSelection() : null;
        this.text = text;
        this.history = [];
        this.future = [];
        this.render();
        if (selection) this.setSelection(Math.min(selection.start, text.length), Math.min(selection.end, text.length));
    }

    // ----- rendering -----

    lineOf(offset) {
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    /**
     * Re-highlights the text. Only the lines whose html changed are replaced, which keeps typing
     * fast in long prompts and leaves the rest of the DOM (and the browser's state for it) alone.
     */
    render() {
        const { lines, lineStarts } = highlightSource(this.text);
        const old = this.lineHtml ?? [];
        this.lineStarts = lineStarts;
        this.lineHtml = lines;
        this.el.classList.toggle('lv-is-empty', this.text === '');

        const intact = this.lineEls?.length === old.length && this.el.children.length === old.length
            && this.lineEls.every((el, i) => this.el.children[i] === el);
        if (!intact) {
            this.el.innerHTML = lines.join('');
        } else {
            let prefix = 0;
            const max = Math.min(old.length, lines.length);
            while (prefix < max && old[prefix] === lines[prefix]) prefix++;
            let suffix = 0;
            while (suffix < max - prefix && old[old.length - 1 - suffix] === lines[lines.length - 1 - suffix]) suffix++;
            const range = document.createRange();
            if (old.length - suffix > prefix) {
                range.setStartBefore(this.lineEls[prefix]);
                range.setEndAfter(this.lineEls[old.length - suffix - 1]);
                range.deleteContents();
            } else if (prefix < old.length) {
                range.setStartBefore(this.lineEls[prefix]);
            } else {
                range.selectNodeContents(this.el);
                range.collapse(false);
            }
            const html = lines.slice(prefix, lines.length - suffix).join('');
            if (html) range.insertNode(range.createContextualFragment(html));
        }
        this.lineEls = Array.from(this.el.children);
        this.applyActiveLines();
    }

    applyActiveLines() {
        this.lineEls?.forEach((el, i) => el.classList.toggle('lv-active', this.activeLines.has(i)));
    }

    setActiveLines(lines) {
        const same = lines.size === this.activeLines.size && [...lines].every(l => this.activeLines.has(l));
        if (same) return;
        const changed = new Set([...lines, ...this.activeLines]);
        this.activeLines = lines;
        changed.forEach(i => this.lineEls?.[i]?.classList.toggle('lv-active', lines.has(i)));
    }

    updateActiveLines() {
        const selection = this.getSelection();
        if (!selection) return;
        const lines = new Set();
        const first = this.lineOf(selection.start);
        const last = this.lineOf(selection.end);
        for (let i = first; i <= last; i++) lines.add(i);

        // A caret placed on a concealed line (click, End, arrows) lands before hidden closing
        // symbols like `*` or `**`. Once they show, put it after them, where the user meant to be.
        const wasConcealed = !this.activeLines.has(first) && this.el.classList.contains('lv-conceal');
        this.setActiveLines(lines);
        if (wasConcealed && selection.start === selection.end) {
            const lineEnd = this.lineStarts[first] + this.lineLength(first);
            if (selection.end < lineEnd && this.onlyMarkupBetween(selection.end, lineEnd)) this.setSelection(lineEnd);
        }
    }

    /** True if every character in [start, end) of one line is concealable markup. */
    onlyMarkupBetween(start, end) {
        const line = this.lineOf(start);
        const lineEl = this.lineEls?.[line];
        if (!lineEl) return false;
        let offset = this.lineStarts[line];
        const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const length = /** @type {Text} */ (node).data.length;
            const overlaps = offset + length > start && offset < end;
            if (overlaps && !node.parentElement?.closest('.lv-r-mark')) return false;
            offset += length;
        }
        return true;
    }

    // ----- selection -----

    lineLength(i) {
        return (i + 1 < this.lineStarts.length ? this.lineStarts[i + 1] - 1 : this.text.length) - this.lineStarts[i];
    }

    /** Text offset of a DOM point, looking only at the line it is in when the DOM is our own render. */
    pointToOffset(node, offset) {
        if (this.lineEls?.length) {
            if (node === this.el) {
                if (offset >= this.lineEls.length) return this.text.length;
                if (this.el.childNodes[offset] === this.lineEls[offset]) return this.lineStarts[offset];
            } else {
                const element = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
                const lineEl = element?.closest('.lv-ln');
                const line = lineEl && lineEl.parentNode === this.el ? this.lineEls.indexOf(lineEl) : -1;
                if (line >= 0 && lineEl.textContent.length === this.lineLength(line)) {
                    const local = readDom(/** @type {HTMLElement} */ (lineEl), [{ node, offset }]).offsets[0];
                    if (local >= 0) return this.lineStarts[line] + local;
                }
            }
        }
        const result = readDom(this.el, [{ node, offset }]).offsets[0];
        return result === -1 ? this.text.length : result;
    }

    /** DOM point for a text offset in the rendered content. */
    offsetToPoint(offset) {
        if (!this.lineEls?.length) return { node: this.el, offset: 0 };
        const line = this.lineOf(Math.min(offset, this.text.length));
        const lineEl = this.lineEls[line];
        let remaining = offset - this.lineStarts[line];
        const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
        let node;
        let last = null;
        while ((node = walker.nextNode())) {
            const length = /** @type {Text} */ (node).data.length;
            if (remaining < length) return { node, offset: remaining };
            if (remaining === length) {
                // At a boundary between two spans, prefer the start of the next one
                const next = walker.nextNode();
                return next ? { node: next, offset: 0 } : { node, offset: length };
            }
            remaining -= length;
            last = node;
        }
        return last ? { node: last, offset: /** @type {Text} */ (last).data.length } : { node: lineEl, offset: 0 };
    }

    /** @returns {{start: number, end: number}|null} */
    getSelection() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
        if (!anchorNode || !this.el.contains(anchorNode) || !this.el.contains(focusNode)) return null;
        const a = this.pointToOffset(anchorNode, anchorOffset);
        const b = focusNode === anchorNode && focusOffset === anchorOffset ? a : this.pointToOffset(focusNode, focusOffset);
        return { start: Math.min(a, b), end: Math.max(a, b) };
    }

    setSelection(start, end = start) {
        const selection = window.getSelection();
        if (!selection) return;
        const a = this.offsetToPoint(start);
        const b = end === start ? a : this.offsetToPoint(end);
        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
        selection.removeAllRanges();
        selection.addRange(range);
        if (document.activeElement === this.el) this.updateActiveLines();
    }

    /** Converts a StaticRange from beforeinput into text offsets. */
    rangeOffsets(range) {
        if (!this.el.contains(range.startContainer) || !this.el.contains(range.endContainer)) return null;
        const a = this.pointToOffset(range.startContainer, range.startOffset);
        const b = this.pointToOffset(range.endContainer, range.endOffset);
        return { start: Math.min(a, b), end: Math.max(a, b) };
    }

    // ----- editing -----

    snapshot(selection = this.getSelection()) {
        return { text: this.text, start: selection?.start ?? this.text.length, end: selection?.end ?? this.text.length };
    }

    /** Records the state before an edit. Typing within a short burst is grouped into one undo step. */
    recordUndo(kind, selection) {
        const now = Date.now();
        const grouped = (kind === 'type' || kind === 'delete') && this.lastKind === kind && now - this.lastPush < 800;
        if (!grouped) this.history.push(this.snapshot(selection));
        if (this.history.length > 300) this.history.shift();
        this.future = [];
        this.lastPush = now;
        this.lastKind = kind;
    }

    /**
     * Replaces [start, end) with `insert` and moves the caret. All programmatic edits go through here.
     * @param {number} start
     * @param {number} end
     * @param {string} insert
     * @param {number} [selStart] New selection start, defaults to the end of the insertion
     * @param {number} [selEnd]
     */
    replace(start, end, insert, selStart, selEnd) {
        insert = insert.replace(/\r\n?/g, '\n');
        let kind = 'edit';
        if (insert.length === 1 && start === end && !/\s/.test(insert)) kind = 'type';
        else if (!insert && end - start <= 2) kind = 'delete';
        this.recordUndo(kind);
        this.text = this.text.slice(0, start) + insert + this.text.slice(end);
        const caret = start + insert.length;
        this.commit(selStart ?? caret, selEnd ?? selStart ?? caret);
    }

    commit(selStart, selEnd) {
        this.activeLines = new Set();
        if (document.activeElement === this.el) {
            for (let i = this.lineOfText(selStart); i <= this.lineOfText(selEnd); i++) this.activeLines.add(i);
        }
        this.render();
        if (document.activeElement === this.el) this.setSelection(selStart, selEnd);
        this.options.onChange?.(this.text);
    }

    /** Line index computed from the current text (lineStarts may be stale mid-edit). */
    lineOfText(offset) {
        let count = 0;
        for (let i = this.text.indexOf('\n'); i !== -1 && i < offset; i = this.text.indexOf('\n', i + 1)) count++;
        return count;
    }

    undo() {
        const state = this.history.pop();
        if (!state) return;
        this.future.push(this.snapshot());
        this.text = state.text;
        this.lastKind = null;
        this.commit(state.start, state.end);
    }

    redo() {
        const state = this.future.pop();
        if (!state) return;
        this.history.push(this.snapshot());
        this.text = state.text;
        this.lastKind = null;
        this.commit(state.start, state.end);
    }

    /** Takes over the edits that browsers tend to do in their own (html-producing) way. */
    onBeforeInput(e) {
        if (this.el.contentEditable === 'false') return;
        const type = e.inputType;
        const target = e.getTargetRanges?.()[0];
        const range = (target && this.rangeOffsets(target)) ?? this.getSelection();
        if (!range) return;

        switch (type) {
            case 'insertParagraph':
            case 'insertLineBreak':
                e.preventDefault();
                this.replace(range.start, range.end, '\n');
                return;
            case 'historyUndo':
                e.preventDefault();
                this.undo();
                return;
            case 'historyRedo':
                e.preventDefault();
                this.redo();
                return;
            case 'formatBold':
                e.preventDefault();
                this.wrap('**');
                return;
            case 'formatItalic':
                e.preventDefault();
                this.wrap('*');
                return;
            case 'formatStrikeThrough':
                e.preventDefault();
                this.wrap('~~');
                return;
            case 'insertFromPaste':
            case 'insertFromDrop':
            case 'insertFromYank':
                // The paste/drop listeners insert plain text; never let html in
                if (e.cancelable) e.preventDefault();
                return;
        }

        if (type.startsWith('format')) {
            e.preventDefault();
            return;
        }

        // Deletions are computed on the text: the browser skips concealed markup when it decides
        // what "one character back" is, and would delete hidden symbols along with it.
        if (type.startsWith('delete') && e.cancelable && !this.composing && type !== 'deleteByDrag') {
            const selection = this.getSelection() ?? range;
            const span = selection.start !== selection.end ? selection : this.deletionRange(type, selection.start);
            e.preventDefault();
            if (span && span.end > span.start) this.replace(span.start, span.end, '', span.start);
            return;
        }

        // Typed characters go through the text model too, so undo groups them predictably
        if (!this.composing && e.cancelable && (type === 'insertText' || type === 'insertReplacementText') && e.data !== null && !e.dataTransfer) {
            e.preventDefault();
            this.replace(range.start, range.end, e.data ?? '');
            return;
        }
        // Everything else (IME composition, spellcheck fixes, edits that can't be cancelled) is
        // left to the browser and read back from the DOM in onInput. Remember the selection for undo.
        this.pendingUndo = { kind: type.startsWith('delete') ? 'delete' : 'edit', selection: range };
    }

    /**
     * What a deletion with a collapsed caret removes.
     * @param {string} type beforeinput inputType
     * @param {number} caret
     * @returns {{start: number, end: number}|null}
     */
    deletionRange(type, caret) {
        const text = this.text;
        const before = text.slice(0, caret);
        const after = text.slice(caret);
        const graphemes = (str) => (typeof Intl !== 'undefined' && Intl.Segmenter)
            ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(str)].map(s => s.segment)
            : Array.from(str);

        switch (type) {
            case 'deleteContentBackward': {
                if (!caret) return null;
                const last = graphemes(before.slice(-8)).at(-1) ?? '';
                return { start: caret - last.length, end: caret };
            }
            case 'deleteContentForward': {
                if (caret >= text.length) return null;
                const first = graphemes(after.slice(0, 8))[0] ?? '';
                return { start: caret, end: caret + first.length };
            }
            case 'deleteWordBackward': {
                const m = before.match(/(?:[^\S\n]*[\p{L}\p{N}_]+|[^\S\n]*[^\s\p{L}\p{N}_]+|\s)$/u);
                return { start: caret - (m?.[0].length ?? 0), end: caret };
            }
            case 'deleteWordForward': {
                const m = after.match(/^(?:[\p{L}\p{N}_]+[^\S\n]*|[^\s\p{L}\p{N}_]+[^\S\n]*|\s)/u);
                return { start: caret, end: caret + (m?.[0].length ?? 0) };
            }
            case 'deleteSoftLineBackward':
            case 'deleteHardLineBackward': {
                const lineStart = before.lastIndexOf('\n') + 1;
                return { start: lineStart === caret ? Math.max(0, caret - 1) : lineStart, end: caret };
            }
            case 'deleteSoftLineForward':
            case 'deleteHardLineForward': {
                const lineEnd = after.indexOf('\n');
                return { start: caret, end: lineEnd === 0 ? caret + 1 : caret + (lineEnd === -1 ? after.length : lineEnd) };
            }
            default:
                return null;
        }
    }

    onInput() {
        if (this.composing) return;
        const selection = window.getSelection();
        const points = selection?.rangeCount ? [{ node: selection.focusNode, offset: selection.focusOffset }] : [];
        const { text, offsets } = readDom(this.el, points);
        // The browser edited the DOM itself; rebuild it fully rather than patching
        this.lineEls = null;
        if (text === this.text) {
            this.render();
            if (offsets[0] >= 0) this.setSelection(offsets[0]);
            return;
        }
        const pending = this.pendingUndo ?? { kind: 'edit', selection: null };
        this.pendingUndo = null;
        this.history.push({ text: this.text, start: pending.selection?.start ?? 0, end: pending.selection?.end ?? 0 });
        this.future = [];
        this.lastKind = pending.kind;
        this.lastPush = Date.now();
        this.text = text;
        const caret = offsets[0] >= 0 ? offsets[0] : text.length;
        this.commit(caret, caret);
    }

    onKeyDown(e) {
        if (this.options.onKeyDown?.(e)) {
            e.preventDefault();
            return;
        }
        // Keep SillyTavern's global hotkeys (swipes, send, etc.) out of the editor
        if (e.key !== 'Escape') e.stopPropagation();


        const mod = e.ctrlKey || e.metaKey;
        if (!mod || e.altKey) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            this.undo();
        } else if ((key === 'z' && e.shiftKey) || key === 'y') {
            e.preventDefault();
            this.redo();
        } else if (key === 'b') {
            e.preventDefault();
            this.wrap('**');
        } else if (key === 'i') {
            e.preventDefault();
            this.wrap('*');
        }
    }

    async onPaste(e) {
        e.preventDefault();
        const range = this.getSelection();
        if (!range) return;
        const data = e.clipboardData;
        const image = [...(data?.items ?? [])].find(item => item.type.startsWith('image/'));
        if (image && this.options.onPasteImage) {
            const insert = await this.options.onPasteImage(image.getAsFile());
            if (insert) this.replace(range.start, range.end, insert);
            return;
        }
        const text = data?.getData('text/plain') ?? '';
        if (text) this.replace(range.start, range.end, text);
    }

    onCopy(e, cut) {
        const range = this.getSelection();
        if (!range || range.start === range.end) return;
        e.preventDefault();
        e.clipboardData?.setData('text/plain', this.text.slice(range.start, range.end));
        if (cut && this.el.contentEditable !== 'false') this.replace(range.start, range.end, '');
    }

    onDrop(e) {
        e.preventDefault();
        const text = e.dataTransfer?.getData('text/plain');
        if (!text || this.el.contentEditable === 'false') return;
        const caret = document.caretRangeFromPoint?.(e.clientX, e.clientY);
        let offset = this.text.length;
        if (caret) {
            const { offsets } = readDom(this.el, [{ node: caret.startContainer, offset: caret.startOffset }]);
            if (offsets[0] >= 0) offset = offsets[0];
        }
        this.focus();
        this.replace(offset, offset, text);
    }

    // ----- formatting commands -----

    /** Wraps the selection in a delimiter pair, or unwraps it if it is already wrapped. */
    wrap(open, close = open) {
        const sel = this.getSelection() ?? { start: this.text.length, end: this.text.length };
        const { start, end } = sel;
        const text = this.text;
        const inner = text.slice(start, end);

        if (text.slice(start - open.length, start) === open && text.slice(end, end + close.length) === close) {
            this.replace(start - open.length, end + close.length, inner, start - open.length, end - open.length);
        } else if (inner.startsWith(open) && inner.endsWith(close) && inner.length >= open.length + close.length) {
            const unwrapped = inner.slice(open.length, inner.length - close.length);
            this.replace(start, end, unwrapped, start, start + unwrapped.length);
        } else {
            this.replace(start, end, open + inner + close, start + open.length, end + open.length);
        }
    }

    /**
     * Applies a function to every line touched by the selection.
     * @param {(line: string, index: number, lines: string[]) => string} transform
     */
    transformLines(transform) {
        const sel = this.getSelection() ?? { start: this.text.length, end: this.text.length };
        const start = this.text.lastIndexOf('\n', sel.start - 1) + 1;
        let end = this.text.indexOf('\n', sel.end);
        if (end === -1) end = this.text.length;
        const lines = this.text.slice(start, end).split('\n');
        const result = lines.map(transform).join('\n');
        const delta = result.length - (end - start);
        this.replace(start, end, result, sel.start === sel.end ? Math.max(start, sel.end + delta) : start, sel.start === sel.end ? Math.max(start, sel.end + delta) : start + result.length);
    }

    insertAtSelection(text) {
        const sel = this.getSelection() ?? { start: this.text.length, end: this.text.length };
        this.replace(sel.start, sel.end, text);
    }
}

export { readDom };
