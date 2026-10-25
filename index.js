import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import {
    world_names,
    loadWorldInfo,
    saveWorldInfo,
    reloadEditor,
    createWorldInfoEntry,
    setWIOriginalDataValue,
} from '../../../world-info.js';
import { callGenericPopup, Popup, POPUP_TYPE } from '../../../popup.js';
import { saveBase64AsFile, getBase64Async, debounce } from '../../../utils.js';
import { showdown, DOMPurify } from '../../../../lib.js';

const MODULE = 'lorebook_vault';
const COVER_FOLDER = 'lorebook-covers';

const defaultSettings = {
    coversEnabled: true,
    markdownEnabled: true,
    defaultMode: 'preview', // edit | preview | split
    bannerHeight: 160,
    xmlMode: 'structured', // structured | raw
    covers: {}, // lorebook name -> image path
};

/** @returns {typeof defaultSettings} */
function settings() {
    extension_settings[MODULE] = Object.assign({}, structuredClone(defaultSettings), extension_settings[MODULE]);
    extension_settings[MODULE].covers ??= {};
    return extension_settings[MODULE];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentWorldName() {
    const index = Number($('#world_editor_select').val());
    return Number.isInteger(index) && index >= 0 ? world_names[index] : null;
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function entryTitle(entry) {
    return entry.comment?.trim() || entry.key?.[0] || `Entry #${entry.uid}`;
}

/** Finds an entry by title (memo), then by keyword, case-insensitively. */
function findEntry(data, target) {
    if (!data?.entries || !target) return null;
    const needle = target.trim().toLowerCase();
    const entries = Object.values(data.entries);
    return entries.find(e => e.comment?.trim().toLowerCase() === needle)
        ?? entries.find(e => e.key?.some(k => k.trim().toLowerCase() === needle))
        ?? null;
}

function linksIn(text) {
    const result = [];
    for (const match of String(text ?? '').matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        result.push(match[1].trim());
    }
    return result;
}

function backlinksFor(data, entry) {
    const names = [entry.comment, ...(entry.key ?? [])].filter(Boolean).map(x => x.trim().toLowerCase());
    return Object.values(data.entries).filter(e => e.uid !== entry.uid
        && linksIn(e.content).some(link => names.includes(link.toLowerCase())));
}

// ---------------------------------------------------------------------------
// Markdown rendering (Obsidian flavoured)
// ---------------------------------------------------------------------------

const converter = new showdown.Converter({
    tables: true,
    strikethrough: true,
    tasklists: true,
    simpleLineBreaks: true,
    literalMidWordUnderscores: true,
    parseImgDimensions: true,
    simplifiedAutoLink: true,
    openLinksInNewWindow: true,
    ghCodeBlocks: true,
    emoji: true,
    disableForced4SpacesIndentedSublists: true,
});

/**
 * Holds lorebook data and the html fragments that rendering swaps in for placeholder tokens.
 * Tokens keep generated html away from the markdown converter.
 */
class RenderContext {
    constructor(data, depth) {
        this.data = data;
        this.depth = depth;
        this.blocks = [];
        this.inlines = [];
        this.code = [];
    }

    block(html) {
        this.blocks.push(html);
        return `\n\nLVBLOCK${this.blocks.length - 1}X\n\n`;
    }

    inline(html) {
        this.inlines.push(html);
        return `LVINLINE${this.inlines.length - 1}X`;
    }
}

/**
 * Applies Obsidian syntax to text outside of code spans/blocks.
 * @param {string} text
 * @param {RenderContext} ctx
 */
function preprocess(text, ctx) {
    const { data, depth } = ctx;
    const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
    return parts.map((part, i) => {
        if (i % 2 === 1) return part; // code, leave untouched

        return part
            // %% comments %%
            .replace(/%%[\s\S]*?%%/g, '')
            // keep consecutive callouts from merging into one blockquote
            .replace(/\n\s*\n(?=>\s*\[!)/g, '\n\n<!-- -->\n\n')
            // ![[Embed]]
            .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g, (_, target) => {
                const entry = findEntry(data, target);
                let html;
                if (!entry) {
                    html = `<div class="lv-embed lv-unresolved">Missing entry: ${escapeHtml(target)}</div>`;
                } else if (depth >= 2) {
                    html = `<div class="lv-embed"><a class="lv-wikilink" data-target="${escapeHtml(target)}">${escapeHtml(entryTitle(entry))}</a></div>`;
                } else {
                    html = `<div class="lv-embed"><div class="lv-embed-title"><a class="lv-wikilink" data-target="${escapeHtml(target)}">${escapeHtml(entryTitle(entry))}</a></div>${renderMarkdown(entry.content, data, depth + 1)}</div>`;
                }
                return ctx.block(html);
            })
            // [[Link]] / [[Link|Alias]] / [[Link#Heading]]
            .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, target, alias) => {
                const resolved = findEntry(data, target) ? '' : ' lv-unresolved';
                return `<a class="lv-wikilink${resolved}" data-target="${escapeHtml(target.trim())}">${escapeHtml((alias ?? target).trim())}</a>`;
            })
            // ==highlight==
            .replace(/==([^=\n]+)==/g, '<mark>$1</mark>')
            // #tags (not headings, not mid-word)
            .replace(/(^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, '$1<span class="lv-tag">#$2</span>');
    }).join('');
}

/** Turns `> [!type] Title` blockquotes into callouts. */
function applyCallouts(root) {
    for (const quote of root.querySelectorAll('blockquote')) {
        const first = quote.firstElementChild;
        if (!first || first.tagName !== 'P') continue;
        const match = first.innerHTML.match(/^\s*\[!(\w+)\]([+-]?)\s*([^<\n]*)(?:<br\s*\/?>\s*)?/i);
        if (!match) continue;

        const [whole, type, fold, title] = match;
        const callout = document.createElement(fold ? 'details' : 'div');
        callout.className = `lv-callout lv-callout-${type.toLowerCase()}`;
        if (fold === '+') callout.setAttribute('open', '');

        const header = document.createElement(fold ? 'summary' : 'div');
        header.className = 'lv-callout-title';
        header.textContent = title.trim() || type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();

        first.innerHTML = first.innerHTML.slice(whole.length);
        if (!first.innerHTML.trim()) first.remove();

        const body = document.createElement('div');
        body.className = 'lv-callout-body';
        body.append(...quote.childNodes);
        callout.append(header, body);
        quote.replaceWith(callout);
    }
}

// ---------------------------------------------------------------------------
// {{macros}}
// ---------------------------------------------------------------------------

const MACRO_CATEGORIES = {
    random: ['random', 'pick', 'roll'],
    variable: ['setvar', 'addvar', 'incvar', 'decvar', 'getvar', 'hasvar', 'deletevar', 'setvarkey', 'getvarkey',
        'setglobalvar', 'addglobalvar', 'incglobalvar', 'decglobalvar', 'getglobalvar', 'hasglobalvar', 'deleteglobalvar', 'setglobalvarkey', 'getglobalvarkey'],
    control: ['if', '/if', 'else', 'trim', 'noop', 'newline', 'space', 'reverse', 'banned', 'outlet'],
};

function macroCategory(name) {
    const lower = name.toLowerCase();
    if (lower === '//') return 'comment';
    if (/^[.$]/.test(lower)) return 'variable';
    return Object.keys(MACRO_CATEGORIES).find(key => MACRO_CATEGORIES[key].includes(lower)) ?? 'value';
}

/** Finds top-level `{{...}}` spans, respecting nested macros. */
function findMacros(text) {
    const spans = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length - 1; i++) {
        if (text[i] === '{' && text[i + 1] === '{') {
            if (depth++ === 0) start = i;
            i++;
        } else if (text[i] === '}' && text[i + 1] === '}' && depth > 0) {
            if (--depth === 0) spans.push([start, i + 2]);
            i++;
        }
    }
    return spans;
}

/**
 * Replaces each top-level macro, passing the text around them through `outside`.
 * @param {string} text
 * @param {(source: string) => string} inside
 * @param {(text: string) => string} outside
 */
function mapMacros(text, inside, outside = x => x) {
    let result = '';
    let last = 0;
    for (const [start, end] of findMacros(text)) {
        result += outside(text.slice(last, start)) + inside(text.slice(start, end));
        last = end;
    }
    return result + outside(text.slice(last));
}

/** Splits on a separator, ignoring separators inside nested macros. */
function splitTopLevel(text, separator) {
    const parts = [];
    let depth = 0;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        if (text.startsWith('{{', i)) depth++;
        if (text.startsWith('}}', i)) depth = Math.max(0, depth - 1);
        if (depth === 0 && text.startsWith(separator, i)) {
            parts.push(current);
            current = '';
            i += separator.length - 1;
            continue;
        }
        current += text[i];
    }
    parts.push(current);
    return parts;
}

/** Same splitting rules SillyTavern uses for `{{random}}` / `{{pick}}`. */
function splitRandomList(text) {
    if (text.includes('::')) return splitTopLevel(text, '::').map(item => item.trim());
    return splitTopLevel(text.replace(/\\,/g, '\u0000'), ',').map(item => item.trim().replace(/\u0000/g, ','));
}

/** Escapes plain text while rendering any macros inside it. */
function macroText(text) {
    return mapMacros(text, renderMacro, escapeHtml);
}

/**
 * @param {string} source Full macro source, braces included
 * @returns {string} Chip html
 */
function renderMacro(source) {
    const body = source.slice(2, -2);
    const match = body.match(/^\s*(\/\/|[^\s:{}]+)\s*(::|:|\s|$)([\s\S]*)$/);
    if (!match) {
        return `<span class="lv-macro lv-macro-value" title="${escapeHtml(source)}">${escapeHtml(source)}</span>`;
    }

    const [, name, separator, rest] = match;
    const category = macroCategory(name);
    const braces = (inner, extraClass = '') => `<span class="lv-macro lv-macro-${category}${extraClass}" title="${escapeHtml(source)}"><span class="lv-macro-brace">{{</span>${inner}<span class="lv-macro-brace">}}</span></span>`;
    const nameHtml = `<span class="lv-macro-name">${category === 'random' ? '<i class="fa-solid fa-dice"></i> ' : ''}${escapeHtml(name)}</span>`;

    if (category === 'comment') {
        return braces(`${nameHtml} <span class="lv-macro-args">${macroText(rest.trim())}</span>`);
    }

    const lower = name.toLowerCase();
    if ((lower === 'random' || lower === 'pick') && rest.trim()) {
        const items = separator === '::' ? splitTopLevel(rest, '::').map(x => x.trim()) : splitRandomList(rest);
        const counts = new Map();
        items.forEach(item => counts.set(item, (counts.get(item) ?? 0) + 1));
        const weighted = counts.size < items.length;
        const pills = [...counts].map(([item, count]) => {
            const percent = Math.round(count / items.length * 1000) / 10;
            const label = item ? macroText(item) : '<i>(empty)</i>';
            const weight = weighted ? `<span class="lv-macro-weight">${count > 1 ? `×${count} · ` : ''}${percent}%</span>` : '';
            return `<span class="lv-macro-option" title="${count} of ${items.length} (${percent}%)">${label}${weight}</span>`;
        }).join('');
        const summary = `<span class="lv-macro-count">${items.length} options${weighted ? `, ${counts.size} unique` : ''}</span>`;
        return braces(`${nameHtml}${summary}<span class="lv-macro-options">${pills}</span>`, ' lv-macro-list');
    }

    if (!rest.trim()) return braces(nameHtml);

    const args = (separator === '::' || rest.includes('::')) ? splitTopLevel(rest, '::') : [rest];
    return braces(`${nameHtml}${args.map(arg => `<span class="lv-macro-arg">${macroText(arg.trim())}</span>`).join('')}`);
}

// ---------------------------------------------------------------------------
// XML tags, used by many lore entries for encapsulation
// ---------------------------------------------------------------------------

/** Tags treated as ordinary HTML formatting; everything else is lore structure. */
const HTML_TAGS = new Set(['a', 'b', 'i', 'u', 's', 'em', 'strong', 'br', 'hr', 'sub', 'sup', 'span', 'small', 'mark', 'img', 'code', 'kbd', 'del', 'ins', 'q', 'font', 'center']);
/** SillyTavern's legacy macros, replaced case-insensitively before the text reaches the model. */
const LEGACY_MACROS = { user: '{{user}}', bot: '{{char}}', char: '{{char}}', group: '{{group}}', charifnotgroup: '{{charIfNotGroup}}' };
const TAG_REGEX = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
const ATTR_REGEX = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
const CODE_REGEX = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * Forgiving tag parser: unclosed or mismatched tags become "stray" nodes instead of failing.
 * @param {string} text Text with code already masked
 * @returns {Array<string|object>} Node tree
 */
function parseTags(text) {
    const root = { type: 'root', children: [] };
    const stack = [root];
    let last = 0;

    const unwrap = (el) => {
        const siblings = el.parent.children;
        siblings.splice(siblings.indexOf(el), 1, { type: 'stray', raw: el.raw, reason: 'Unclosed tag' }, ...el.children);
        el.children.forEach(child => typeof child === 'object' && (child.parent = el.parent));
    };

    for (const match of text.matchAll(TAG_REGEX)) {
        const [raw, closing, name, attrs, selfClosing] = match;
        const lower = name.toLowerCase();
        if (HTML_TAGS.has(lower)) continue;

        const top = stack.at(-1);
        if (match.index > last) top.children.push(text.slice(last, match.index));
        last = match.index + raw.length;

        if (!closing && !attrs.trim() && !selfClosing && Object.hasOwn(LEGACY_MACROS, lower)) {
            top.children.push({ type: 'macro', raw, macro: LEGACY_MACROS[lower] });
        } else if (selfClosing && !closing) {
            top.children.push({ type: 'empty', name, attrs, raw });
        } else if (!closing) {
            const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
            const el = {
                type: 'element', name, attrs, raw, parent: top, children: [],
                atLineStart: !text.slice(lineStart, match.index).trim(),
            };
            top.children.push(el);
            stack.push(el);
        } else {
            const index = stack.findLastIndex((frame, i) => i > 0 && frame.name === name);
            if (index === -1) {
                top.children.push({ type: 'stray', raw, reason: 'No matching opening tag' });
                continue;
            }
            while (stack.length - 1 > index) unwrap(stack.pop());
            const el = stack.pop();
            const lineEnd = text.indexOf('\n', last);
            el.closeRaw = raw;
            el.atLineEnd = !text.slice(last, lineEnd === -1 ? undefined : lineEnd).trim();
        }
    }

    if (last < text.length) stack.at(-1).children.push(text.slice(last));
    while (stack.length > 1) unwrap(stack.pop());
    return root.children;
}

/** Removes the shared indentation so indented tag bodies don't turn into code blocks. */
function dedent(text) {
    const lines = text.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '').split('\n');
    // Nested block tokens sit at column 0 and must not count towards the shared indentation
    const indents = lines.filter(line => line.trim() && !/^\s*LVBLOCK\d+X\s*$/.test(line)).map(line => line.match(/^[ \t]*/)[0].length);
    const min = indents.length ? Math.min(...indents) : 0;
    const indent = new RegExp(`^[ \\t]{0,${min}}`);
    return lines.map(line => line.replace(indent, '')).join('\n');
}

function attrPills(attrs) {
    return [...String(attrs ?? '').matchAll(ATTR_REGEX)].map(([, key, dq, sq, bare]) => {
        const value = dq ?? sq ?? bare;
        return `<span class="lv-xml-attr"><span class="lv-xml-attr-key">${escapeHtml(key)}</span>${value !== undefined ? `<span class="lv-xml-attr-value">${escapeHtml(value)}</span>` : ''}</span>`;
    }).join('');
}

function rawTag(raw, className = 'lv-xml-raw', title = '') {
    return `<span class="${className}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(raw)}</span>`;
}

/**
 * Turns the node tree back into markdown, with tags replaced by html tokens.
 * @param {Array<string|object>} nodes
 * @param {RenderContext} ctx
 * @param {number} level Tag nesting level, used for colours
 */
function serializeNodes(nodes, ctx, level = 0) {
    const raw = settings().xmlMode === 'raw';
    return nodes.map(node => {
        if (typeof node === 'string') return node;

        switch (node.type) {
            case 'macro':
                return ctx.inline(renderMacro(node.macro).replace('<span class="lv-macro ', `<span data-legacy="${escapeHtml(node.raw)}" class="lv-macro `));
            case 'stray':
                return ctx.inline(rawTag(node.raw, 'lv-xml-stray', node.reason));
            case 'empty':
                return ctx.inline(raw
                    ? rawTag(node.raw)
                    : `<span class="lv-xml-chip" style="--lv-level:${level}"><span class="lv-xml-name">${escapeHtml(node.name)}</span>${attrPills(node.attrs)}</span>`);
        }

        const inner = serializeNodes(node.children, ctx, level + 1);
        const isBlock = (node.atLineStart && node.atLineEnd) || /\n\s*\n/.test(inner);

        if (raw) {
            if (!isBlock) return ctx.inline(rawTag(node.raw)) + inner + ctx.inline(rawTag(node.closeRaw));
            const body = dedent(inner);
            return ctx.block(`
                <div class="lv-xml-rawblock">
                    <div>${rawTag(node.raw)}</div>
                    ${body.trim() ? `<div class="lv-xml-rawbody">${markdownToHtml(body, ctx)}</div>` : ''}
                    <div>${rawTag(node.closeRaw)}</div>
                </div>`);
        }

        if (!isBlock) {
            return ctx.inline(`<span class="lv-xml-inline" style="--lv-level:${level}" title="${escapeHtml(node.raw.replace(/LVINLINE\d+X/g, '{{…}}'))}"><span class="lv-xml-mark">${escapeHtml(node.name)}</span>`)
                + inner + ctx.inline('</span>');
        }

        const body = dedent(inner);
        return ctx.block(`
            <div class="lv-xml" style="--lv-level:${level}">
                <div class="lv-xml-head"><span class="lv-xml-name">${escapeHtml(node.name)}</span>${attrPills(node.attrs)}</div>
                ${body.trim() ? `<div class="lv-xml-body">${markdownToHtml(body, ctx)}</div>` : ''}
            </div>`);
    }).join('');
}

/**
 * @param {string} text Markdown with masked code
 * @param {RenderContext} ctx
 */
function markdownToHtml(text, ctx) {
    const restored = text.replace(/LVCODE(\d+)X/g, (_, i) => ctx.code[Number(i)]);
    return converter.makeHtml(preprocess(restored, ctx));
}

/**
 * @param {string} text Markdown source
 * @param {object} data Lorebook data (for link resolution)
 * @param {number} depth Embed depth
 * @returns {string} Sanitized HTML
 */
function renderMarkdown(text, data, depth = 0) {
    const ctx = new RenderContext(data, depth);
    const masked = String(text ?? '').replace(CODE_REGEX, (code) => {
        ctx.code.push(code);
        return `LVCODE${ctx.code.length - 1}X`;
    });
    const withMacros = mapMacros(masked, source => ctx.inline(renderMacro(source)));

    let html = markdownToHtml(serializeNodes(parseTags(withMacros), ctx), ctx);
    // Block html contains tokens of its own nested content, so resolve until none are left
    for (let pass = 0; pass < 100 && /LV(?:BLOCK|INLINE)\d+X/.test(html); pass++) {
        html = html
            .replace(/(?:<p>)?LVBLOCK(\d+)X(?:<\/p>)?/g, (_, i) => ctx.blocks[Number(i)] ?? '')
            .replace(/LVINLINE(\d+)X/g, (_, i) => ctx.inlines[Number(i)] ?? '');
    }
    html = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'open'], ADD_TAGS: ['details', 'summary'] });

    const template = document.createElement('template');
    template.innerHTML = html;
    applyCallouts(template.content);
    const wrapper = document.createElement('div');
    wrapper.append(template.content);
    return wrapper.innerHTML;
}

// ---------------------------------------------------------------------------
// Inline markdown viewer/editor inside lorebook entries
// ---------------------------------------------------------------------------

const XML_TOGGLE_HTML = '<div class="menu_button lv-xml-toggle" title="XML tags: structured / raw"><i class="fa-solid fa-code"></i></div>';
const onXmlModeChange = new Set();

function syncXmlToggles() {
    $('.lv-xml-toggle').toggleClass('active', settings().xmlMode === 'raw');
}

function setXmlMode(mode) {
    settings().xmlMode = mode;
    saveSettingsDebounced();
    $('#lv_xml_mode').val(mode);
    syncXmlToggles();
    // Refresh every visible preview; callbacks for detached elements drop themselves
    onXmlModeChange.forEach(callback => callback());
}

function toggleXmlMode() {
    setXmlMode(settings().xmlMode === 'raw' ? 'structured' : 'raw');
}

function enhanceContentTextarea(textarea) {
    if (textarea.dataset.lvEnhanced) return;
    textarea.dataset.lvEnhanced = '1';

    const $textarea = $(textarea);
    const uid = $textarea.data('uid') ?? $textarea.closest('.world_entry').attr('uid');

    const toolbar = $(`
        <div class="lv-toolbar">
            <div class="lv-modes">
                <div class="menu_button lv-mode" data-mode="edit" title="Edit"><i class="fa-solid fa-pen"></i></div>
                <div class="menu_button lv-mode" data-mode="split" title="Split"><i class="fa-solid fa-table-columns"></i></div>
                <div class="menu_button lv-mode" data-mode="preview" title="Preview"><i class="fa-solid fa-eye"></i></div>
            </div>
            <div class="lv-modes">
                ${XML_TOGGLE_HTML}
                <div class="menu_button lv-open-vault" title="Open in Vault"><i class="fa-solid fa-book-open"></i> Vault</div>
            </div>
        </div>`);
    const wrap = $('<div class="lv-inline"></div>');
    const preview = $('<div class="lv-preview lv-markdown" title="Double-click to edit"></div>');

    $textarea.before(toolbar);
    $textarea.wrap(wrap);
    $textarea.after(preview);
    const container = $textarea.parent();

    let data = null;
    const refresh = async () => {
        const name = currentWorldName();
        if (!data && name) data = await loadWorldInfo(name);
        preview.html(renderMarkdown($textarea.val(), data));
    };
    const refreshDebounced = debounce(refresh, 250);

    const setMode = (mode) => {
        container.attr('data-mode', mode);
        toolbar.find('.lv-mode').removeClass('active').filter(`[data-mode="${mode}"]`).addClass('active');
        if (mode !== 'edit') refresh();
    };

    toolbar.on('click', '.lv-mode', function () { setMode($(this).data('mode')); });
    const rerender = () => {
        if (!textarea.isConnected) return onXmlModeChange.delete(rerender);
        if (container.attr('data-mode') !== 'edit') refresh();
    };
    onXmlModeChange.add(rerender);
    toolbar.on('click', '.lv-xml-toggle', toggleXmlMode);
    syncXmlToggles();

    toolbar.on('click', '.lv-open-vault', () => openVault(currentWorldName(), Number(uid)));
    $textarea.on('input', () => container.attr('data-mode') !== 'edit' && refreshDebounced());
    preview.on('dblclick', (e) => {
        if ($(e.target).closest('a, .lv-wikilink').length) return;
        setMode('edit');
        textarea.focus();
    });
    preview.on('click', '.lv-wikilink', function (e) {
        e.preventDefault();
        openVault(currentWorldName(), null, $(this).data('target'));
    });

    setMode(settings().defaultMode);
}

function observeEntries() {
    const list = document.getElementById('world_popup_entries_list');
    if (!list) return;

    const scan = () => {
        if (!settings().markdownEnabled) return;
        list.querySelectorAll('textarea[name="content"]:not([data-lv-enhanced])').forEach(enhanceContentTextarea);
    };

    new MutationObserver(scan).observe(list, { childList: true, subtree: true });
    scan();
}

// ---------------------------------------------------------------------------
// Vault: Obsidian-style full-screen editor for a lorebook
// ---------------------------------------------------------------------------

/**
 * @param {string} worldName
 * @param {number?} uid Entry to open
 * @param {string?} target Link target to resolve and open
 */
async function openVault(worldName, uid = null, target = null) {
    if (!worldName) {
        toastr.warning('Select a lorebook first.');
        return;
    }

    const data = await loadWorldInfo(worldName);
    if (!data?.entries) {
        toastr.error('Could not load lorebook.');
        return;
    }

    let dirty = false;
    let current = null;
    let mode = settings().defaultMode === 'edit' ? 'split' : settings().defaultMode;
    const history = [];

    const root = $(`
        <div class="lv-vault">
            <aside class="lv-sidebar">
                <div class="lv-vault-header">
                    ${coverImg(worldName, 'lv-vault-cover')}
                    <div class="lv-vault-name">${escapeHtml(worldName)}</div>
                </div>
                <div class="lv-sidebar-actions">
                    <input type="search" class="text_pole lv-search" placeholder="Search entries...">
                    <div class="menu_button lv-new" title="New entry"><i class="fa-solid fa-plus"></i></div>
                </div>
                <div class="lv-file-list"></div>
            </aside>
            <section class="lv-main">
                <div class="lv-main-header">
                    <div class="menu_button lv-back" title="Back"><i class="fa-solid fa-arrow-left"></i></div>
                    <input class="text_pole lv-title" placeholder="Entry title (memo)">
                    <div class="lv-modes">
                        ${XML_TOGGLE_HTML}
                        <div class="menu_button lv-mode" data-mode="edit" title="Edit"><i class="fa-solid fa-pen"></i></div>
                        <div class="menu_button lv-mode" data-mode="split" title="Split"><i class="fa-solid fa-table-columns"></i></div>
                        <div class="menu_button lv-mode" data-mode="preview" title="Preview"><i class="fa-solid fa-eye"></i></div>
                    </div>
                </div>
                <div class="lv-keys"></div>
                <div class="lv-panes">
                    <div class="lv-editor-wrap">
                        <textarea class="text_pole lv-editor" spellcheck="true" placeholder="Write markdown... use [[Entry]] to link, ![[Entry]] to embed. Paste images to upload."></textarea>
                        <div class="lv-suggest"></div>
                    </div>
                    <div class="lv-preview-pane lv-markdown"></div>
                </div>
                <div class="lv-backlinks"></div>
            </section>
        </div>`);

    const fileList = root.find('.lv-file-list');
    const editor = root.find('.lv-editor');
    const previewPane = root.find('.lv-preview-pane');
    const titleInput = root.find('.lv-title');
    const suggest = root.find('.lv-suggest');

    const save = debounce(() => saveWorldInfo(worldName, data), 500);

    const renderList = () => {
        const query = String(root.find('.lv-search').val() ?? '').toLowerCase();
        const entries = Object.values(data.entries)
            .filter(e => !query
                || entryTitle(e).toLowerCase().includes(query)
                || e.key?.some(k => k.toLowerCase().includes(query))
                || e.content?.toLowerCase().includes(query))
            .sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)));
        fileList.html(entries.map(e => `
            <div class="lv-file ${current?.uid === e.uid ? 'active' : ''} ${e.disable ? 'disabled' : ''}" data-uid="${e.uid}">
                <i class="fa-regular fa-file-lines"></i>
                <span>${escapeHtml(entryTitle(e))}</span>
            </div>`).join('') || '<div class="lv-empty">No entries</div>');
    };

    const renderPreview = () => {
        previewPane.html(current ? renderMarkdown(editor.val(), data) : '');
    };
    const renderPreviewDebounced = debounce(renderPreview, 200);

    const renderBacklinks = () => {
        if (!current) return root.find('.lv-backlinks').empty();
        const links = backlinksFor(data, current);
        root.find('.lv-backlinks').html(`
            <div class="lv-backlinks-title">Linked mentions (${links.length})</div>
            ${links.map(e => `<a class="lv-wikilink" data-uid="${e.uid}">${escapeHtml(entryTitle(e))}</a>`).join('')}`);
    };

    const setMode = (newMode) => {
        mode = newMode;
        root.find('.lv-panes').attr('data-mode', mode);
        root.find('.lv-main-header .lv-mode').removeClass('active').filter(`[data-mode="${mode}"]`).addClass('active');
        renderPreview();
    };

    const select = (entry, pushHistory = true) => {
        if (!entry) return;
        if (pushHistory && current && current.uid !== entry.uid) history.push(current.uid);
        current = entry;
        editor.val(entry.content ?? '');
        titleInput.val(entry.comment ?? '');
        root.find('.lv-keys').html((entry.key ?? []).map(k => `<span class="lv-key">${escapeHtml(k)}</span>`).join(''));
        root.find('.lv-back').toggleClass('disabled', history.length === 0);
        hideSuggest();
        renderList();
        renderPreview();
        renderBacklinks();
    };

    const navigate = (targetName) => {
        const entry = findEntry(data, targetName);
        if (entry) return select(entry);
        callGenericPopup(`Create entry "${escapeHtml(targetName)}"?`, POPUP_TYPE.CONFIRM).then(ok => {
            if (ok) createEntry(targetName);
        });
    };

    const createEntry = (title = '') => {
        const entry = createWorldInfoEntry(worldName, data);
        if (!entry) return;
        entry.comment = title;
        if (title) entry.key = [title];
        dirty = true;
        save();
        select(entry);
        titleInput.trigger('focus');
    };

    // Wikilink autocomplete: triggered when the caret sits right after an unclosed `[[`
    let suggestions = [];
    let suggestIndex = 0;
    function hideSuggest() {
        suggest.hide();
        suggestions = [];
    }
    const updateSuggest = () => {
        const el = editor[0];
        const before = el.value.slice(0, el.selectionStart);
        const match = before.match(/!?\[\[([^\]\n|#]*)$/);
        if (!match) return hideSuggest();
        const query = match[1].toLowerCase();
        suggestions = Object.values(data.entries)
            .filter(e => e.uid !== current?.uid && entryTitle(e).toLowerCase().includes(query))
            .slice(0, 8);
        if (!suggestions.length) return hideSuggest();
        suggestIndex = 0;
        suggest.html(suggestions.map((e, i) => `<div class="lv-suggest-item ${i === 0 ? 'active' : ''}" data-i="${i}">${escapeHtml(entryTitle(e))}</div>`).join('')).show();
    };
    const applySuggest = (i) => {
        const entry = suggestions[i];
        if (!entry) return;
        const el = editor[0];
        const before = el.value.slice(0, el.selectionStart);
        const after = el.value.slice(el.selectionStart);
        const start = before.lastIndexOf('[[') + 2;
        const insert = entryTitle(entry) + (after.startsWith(']]') ? '' : ']]');
        el.value = before.slice(0, start) + insert + after;
        const caret = start + insert.length + (after.startsWith(']]') ? 2 : 0);
        el.setSelectionRange(caret, caret);
        hideSuggest();
        editor.trigger('input');
    };

    // Events
    root.on('input', '.lv-search', renderList);
    root.on('click', '.lv-new', () => createEntry());
    root.on('click', '.lv-file', function () { select(data.entries[$(this).data('uid')]); });
    root.on('click', '.lv-main-header .lv-mode', function () { setMode($(this).data('mode')); });
    root.on('click', '.lv-back', () => {
        const uidBack = history.pop();
        if (uidBack !== undefined && data.entries[uidBack]) select(data.entries[uidBack], false);
    });
    root.on('click', '.lv-wikilink', function (e) {
        e.preventDefault();
        const linkUid = $(this).data('uid');
        if (linkUid !== undefined) return select(data.entries[linkUid]);
        navigate(String($(this).data('target')));
    });
    root.on('click', '.lv-xml-toggle', toggleXmlMode);
    onXmlModeChange.add(renderPreview);
    root.on('click', '.lv-suggest-item', function () { applySuggest(Number($(this).data('i'))); });

    titleInput.on('input', () => {
        if (!current) return;
        current.comment = String(titleInput.val());
        setWIOriginalDataValue(data, current.uid, 'comment', current.comment);
        dirty = true;
        save();
        renderList();
    });

    editor.on('input', () => {
        if (!current) return;
        current.content = String(editor.val());
        setWIOriginalDataValue(data, current.uid, 'content', current.content);
        dirty = true;
        save();
        renderPreviewDebounced();
        renderBacklinks();
        updateSuggest();
    });
    editor.on('click', updateSuggest);
    editor.on('blur', () => setTimeout(hideSuggest, 150));
    editor.on('keydown', (e) => {
        if (!suggestions.length) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
            suggest.find('.lv-suggest-item').removeClass('active').eq(suggestIndex).addClass('active');
        } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            applySuggest(suggestIndex);
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            hideSuggest();
        }
    });

    // Paste images straight into the note
    editor.on('paste', async (e) => {
        const items = [...(e.originalEvent?.clipboardData?.items ?? [])];
        const imageItem = items.find(i => i.type.startsWith('image/'));
        if (!imageItem) return;
        e.preventDefault();
        try {
            const file = imageItem.getAsFile();
            const path = await uploadImage(file, `${worldName}_${Date.now()}`, 'lorebook-notes');
            const el = editor[0];
            const insert = `![](${path})`;
            el.setRangeText(insert, el.selectionStart, el.selectionEnd, 'end');
            editor.trigger('input');
        } catch (err) {
            console.error(err);
            toastr.error('Image upload failed.');
        }
    });

    setMode(mode);
    renderList();
    const first = (uid !== null && data.entries[uid])
        || (target && findEntry(data, target))
        || Object.values(data.entries).sort((a, b) => entryTitle(a).localeCompare(entryTitle(b)))[0];
    if (first) select(first, false);
    if (target && !findEntry(data, target)) navigate(target);

    syncXmlToggles();
    await callGenericPopup(root, POPUP_TYPE.DISPLAY, '', { large: true, wide: true, allowVerticalScrolling: false });
    onXmlModeChange.delete(renderPreview);

    // Flush and resync the built-in editor, which holds its own copy of the data
    if (dirty) {
        await saveWorldInfo(worldName, data, true);
        if (currentWorldName() === worldName) reloadEditor(worldName);
    }
}

// ---------------------------------------------------------------------------
// Cover art
// ---------------------------------------------------------------------------

function coverImg(name, className) {
    const path = settings().covers[name];
    return path ? `<img class="${className}" src="${escapeHtml(path)}" alt="">` : '';
}

async function uploadImage(file, baseName, folder) {
    const dataUrl = await getBase64Async(file);
    const [header, base64] = String(dataUrl).split(',');
    const ext = header.match(/image\/(\w+)/)?.[1]?.replace('jpeg', 'jpg') ?? 'png';
    const safeName = baseName.replace(/[^\p{L}\p{N}_-]+/gu, '_');
    return saveBase64AsFile(base64, folder, safeName, ext);
}

async function deleteImage(path) {
    try {
        await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path }),
        });
    } catch (err) {
        console.warn('[Lorebook Vault] Failed to delete image', err);
    }
}

function pickImage() {
    return new Promise((resolve) => {
        const input = $('<input type="file" accept="image/*" hidden>');
        input.on('change', () => resolve(input[0].files?.[0] ?? null));
        input.trigger('click');
    });
}

async function setCover(name) {
    if (!name) return;
    const file = await pickImage();
    if (!file) return;
    try {
        const path = await uploadImage(file, `${name}_${Date.now()}`, COVER_FOLDER);
        const old = settings().covers[name];
        settings().covers[name] = path;
        saveSettingsDebounced();
        if (old) deleteImage(old);
        updateBanner();
        toastr.success('Cover art updated.');
    } catch (err) {
        console.error(err);
        toastr.error('Failed to upload cover art.');
    }
}

async function removeCover(name) {
    const old = settings().covers[name];
    if (!old) return;
    delete settings().covers[name];
    saveSettingsDebounced();
    deleteImage(old);
    updateBanner();
}

function updateBanner() {
    const banner = $('#lv_cover_banner');
    const name = currentWorldName();
    if (!settings().coversEnabled || !name) {
        banner.hide();
        return;
    }

    const path = settings().covers[name];
    banner.show()
        .toggleClass('has-cover', Boolean(path))
        .css('--lv-banner-height', `${settings().bannerHeight}px`)
        .css('background-image', path ? `url("${encodeURI(path)}")` : '');
    banner.find('.lv-banner-name').text(name);
    banner.find('.lv-banner-remove').toggle(Boolean(path));
}

function injectBanner() {
    if ($('#lv_cover_banner').length) return;
    const banner = $(`
        <div id="lv_cover_banner">
            <div class="lv-banner-name"></div>
            <div class="lv-banner-actions">
                <div class="menu_button lv-banner-set" title="Set cover art"><i class="fa-solid fa-image"></i></div>
                <div class="menu_button lv-banner-remove" title="Remove cover art"><i class="fa-solid fa-trash-can"></i></div>
                <div class="menu_button lv-banner-vault" title="Open in Vault"><i class="fa-solid fa-book-open"></i></div>
                <div class="menu_button lv-banner-gallery" title="Lorebook gallery"><i class="fa-solid fa-images"></i></div>
            </div>
        </div>`);
    banner.on('click', '.lv-banner-set', () => setCover(currentWorldName()));
    banner.on('click', '.lv-banner-remove', () => removeCover(currentWorldName()));
    banner.on('click', '.lv-banner-vault', () => openVault(currentWorldName()));
    banner.on('click', '.lv-banner-gallery', openGallery);
    $('#world_popup_entries_list').before(banner);

    const galleryButton = $('<div id="lv_gallery_button" class="menu_button fa-solid fa-images" title="Lorebook gallery"></div>');
    galleryButton.on('click', openGallery);
    $('#world_popup_delete').before(galleryButton);

    $(document).on('change', '#world_editor_select', updateBanner);
    updateBanner();
}

async function openGallery() {
    const root = $(`
        <div class="lv-gallery">
            <input type="search" class="text_pole lv-gallery-search" placeholder="Search lorebooks...">
            <div class="lv-gallery-grid"></div>
        </div>`);

    const render = () => {
        const query = String(root.find('.lv-gallery-search').val() ?? '').toLowerCase();
        const names = [...world_names].filter(n => n.toLowerCase().includes(query)).sort((a, b) => a.localeCompare(b));
        root.find('.lv-gallery-grid').html(names.map(name => `
            <div class="lv-card" data-name="${escapeHtml(name)}">
                <div class="lv-card-art">${coverImg(name, 'lv-card-img') || '<i class="fa-solid fa-book"></i>'}</div>
                <div class="lv-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="lv-card-actions">
                    <div class="menu_button lv-card-edit" title="Open in editor"><i class="fa-solid fa-pen-to-square"></i></div>
                    <div class="menu_button lv-card-vault" title="Open in Vault"><i class="fa-solid fa-book-open"></i></div>
                    <div class="menu_button lv-card-cover" title="Set cover"><i class="fa-solid fa-image"></i></div>
                </div>
            </div>`).join('') || '<div class="lv-empty">No lorebooks</div>');
    };

    const popup = new Popup(root, POPUP_TYPE.DISPLAY, '', { wide: true, large: true });
    root.on('input', '.lv-gallery-search', render);
    root.on('click', '.lv-card-edit, .lv-card-art', function () {
        const name = $(this).closest('.lv-card').data('name');
        $('#world_editor_select').val(world_names.indexOf(String(name))).trigger('change');
        popup.completeCancelled();
    });
    root.on('click', '.lv-card-vault', function () {
        openVault(String($(this).closest('.lv-card').data('name')));
    });
    root.on('click', '.lv-card-cover', async function () {
        await setCover(String($(this).closest('.lv-card').data('name')));
        render();
    });

    render();
    await popup.show();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function injectSettings() {
    const s = settings();
    const html = $(`
        <div class="lv-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Lorebook Vault</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label"><input type="checkbox" id="lv_covers_enabled"> Lorebook cover art</label>
                    <label class="checkbox_label"><input type="checkbox" id="lv_markdown_enabled"> Markdown editor in entries (reload to apply)</label>
                    <label for="lv_default_mode">Default entry view</label>
                    <select id="lv_default_mode" class="text_pole">
                        <option value="preview">Preview</option>
                        <option value="split">Split</option>
                        <option value="edit">Edit</option>
                    </select>
                    <label for="lv_xml_mode">XML tags in previews</label>
                    <select id="lv_xml_mode" class="text_pole">
                        <option value="structured">Structured (boxes)</option>
                        <option value="raw">Raw (show tags as text)</option>
                    </select>
                    <label for="lv_banner_height">Cover banner height: <span id="lv_banner_height_value"></span>px</label>
                    <input type="range" id="lv_banner_height" min="60" max="400" step="10">
                </div>
            </div>
        </div>`);

    html.find('#lv_covers_enabled').prop('checked', s.coversEnabled).on('change', function () {
        s.coversEnabled = this.checked;
        saveSettingsDebounced();
        updateBanner();
    });
    html.find('#lv_markdown_enabled').prop('checked', s.markdownEnabled).on('change', function () {
        s.markdownEnabled = this.checked;
        saveSettingsDebounced();
    });
    html.find('#lv_default_mode').val(s.defaultMode).on('change', function () {
        s.defaultMode = String($(this).val());
        saveSettingsDebounced();
    });
    html.find('#lv_xml_mode').val(s.xmlMode).on('change', function () {
        setXmlMode(String($(this).val()));
    });
    html.find('#lv_banner_height_value').text(s.bannerHeight);
    html.find('#lv_banner_height').val(s.bannerHeight).on('input', function () {
        s.bannerHeight = Number($(this).val());
        html.find('#lv_banner_height_value').text(s.bannerHeight);
        saveSettingsDebounced();
        updateBanner();
    });

    $('#extensions_settings2').append(html);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

jQuery(() => {
    settings();
    injectSettings();
    injectBanner();
    observeEntries();

    // World list is populated asynchronously after settings load
    eventSource.on(event_types.SETTINGS_LOADED, updateBanner);
    eventSource.on(event_types.WORLDINFO_UPDATED, updateBanner);
});
