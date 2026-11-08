import { showdown, DOMPurify } from '../../../../../lib.js';

/** Options shared by every preview. Kept in sync with the extension settings by index.js. */
export const renderOptions = {
    xmlMode: 'structured', // structured | raw
};

export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function entryTitle(entry) {
    return entry.comment?.trim() || entry.key?.[0] || `Entry #${entry.uid}`;
}

/** Finds an entry by title (memo), then by keyword, case-insensitively. */
export function findEntry(data, target) {
    if (!data?.entries || !target) return null;
    const needle = target.trim().toLowerCase();
    const entries = Object.values(data.entries);
    return entries.find(e => e.comment?.trim().toLowerCase() === needle)
        ?? entries.find(e => e.key?.some(k => k.trim().toLowerCase() === needle))
        ?? null;
}

export function linksIn(text) {
    const result = [];
    for (const match of String(text ?? '').matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        result.push(match[1].trim());
    }
    return result;
}

export function backlinksFor(data, entry) {
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

export function macroCategory(name) {
    const lower = name.toLowerCase();
    if (lower === '//') return 'comment';
    if (/^[.$]/.test(lower)) return 'variable';
    return Object.keys(MACRO_CATEGORIES).find(key => MACRO_CATEGORIES[key].includes(lower)) ?? 'value';
}

/** Finds top-level `{{...}}` spans, respecting nested macros. */
export function findMacros(text) {
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
export function mapMacros(text, inside, outside = x => x) {
    let result = '';
    let last = 0;
    for (const [start, end] of findMacros(text)) {
        result += outside(text.slice(last, start)) + inside(text.slice(start, end));
        last = end;
    }
    return result + outside(text.slice(last));
}

/** Splits on a separator, ignoring separators inside nested macros. */
export function splitTopLevel(text, separator) {
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
export function renderMacro(source) {
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
export const HTML_TAGS = new Set(['a', 'b', 'i', 'u', 's', 'em', 'strong', 'br', 'hr', 'sub', 'sup', 'span', 'small', 'mark', 'img', 'code', 'kbd', 'del', 'ins', 'q', 'font', 'center']);
/** SillyTavern's legacy macros, replaced case-insensitively before the text reaches the model. */
export const LEGACY_MACROS = { user: '{{user}}', bot: '{{char}}', char: '{{char}}', group: '{{group}}', charifnotgroup: '{{charIfNotGroup}}' };
export const TAG_REGEX = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
export const ATTR_REGEX = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/g;
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
        } else if (!closing && !attrs.trim() && lower === 'start') {
            top.children.push({ type: 'start', raw });
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
    const raw = renderOptions.xmlMode === 'raw';
    return nodes.map(node => {
        if (typeof node === 'string') return node;

        switch (node.type) {
            case 'macro':
                return ctx.inline(renderMacro(node.macro).replace('<span class="lv-macro ', `<span data-legacy="${escapeHtml(node.raw)}" class="lv-macro `));
            case 'stray':
                return ctx.inline(rawTag(node.raw, 'lv-xml-stray', node.reason));
            case 'start':
                return ctx.block(`<div class="lv-start" title="${escapeHtml(node.raw)}">START</div>`);
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
export function renderMarkdown(text, data, depth = 0) {
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
