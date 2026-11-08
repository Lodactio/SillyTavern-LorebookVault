import { escapeHtml as escapeAttr, findMacros, macroCategory, HTML_TAGS, LEGACY_MACROS, TAG_REGEX, ATTR_REGEX } from './render.js';

/**
 * Turns prompt source into decorated html for the rich editor.
 *
 * The output's text content is always exactly `text`: nothing is added, removed or reordered,
 * only wrapped in spans. Markup characters get the `lv-r-mark` class so CSS can conceal them on
 * lines that are not being edited. Each line becomes a `.lv-ln` block (the newlines are implied
 * by the blocks; empty lines hold a placeholder `<br>`).
 */

const PROTECT = '\u0001';
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text) => (/[&<>"]/.test(text) ? text.replace(/[&<>"]/g, c => ESCAPES[c]) : text);

/**
 * @typedef {object} Range
 * @property {number} s Start offset
 * @property {number} e End offset (exclusive)
 * @property {string} cls Classes
 * @property {string} [attrs] Extra html attributes
 */

class Decorator {
    /** @param {string} text */
    constructor(text) {
        this.text = text;
        /** @type {Range[]} */
        this.ranges = [];
        /** Text with protected (code, comment, macro, tag) characters masked out, used for markdown scans */
        this.scan = text.split('');
        this.lines = [];
        let start = 0;
        for (const line of text.split('\n')) {
            this.lines.push({ s: start, e: start + line.length, cls: [], attrs: '' });
            start += line.length + 1;
        }
    }

    add(s, e, cls, attrs = '') {
        if (e > s) this.ranges.push({ s, e, cls, attrs });
    }

    protect(s, e) {
        for (let i = s; i < e; i++) this.scan[i] = PROTECT;
    }

    isProtected(i) {
        return this.scan[i] === PROTECT;
    }

    lineAt(offset) {
        let lo = 0;
        let hi = this.lines.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.lines[mid].s <= offset) lo = mid; else hi = mid - 1;
        }
        return lo;
    }
}

/** ``` fenced code blocks: whole lines, nothing inside is decorated. */
function decorateFences(d) {
    let open = -1;
    d.lines.forEach((line, i) => {
        const fence = /^\s*(```|~~~)/.test(d.text.slice(line.s, line.e));
        if (open === -1 && !fence) return;
        line.cls.push('lv-r-codeblock');
        if (fence) {
            line.cls.push('lv-r-fence');
            open = open === -1 ? i : -1;
        }
        d.protect(line.s, line.e);
    });
}

function decorateInlineCode(d) {
    for (const m of d.scan.join('').matchAll(/`[^`\n\u0001]+`/g)) {
        const s = m.index;
        const e = s + m[0].length;
        d.add(s, e, 'lv-r-code');
        d.add(s, s + 1, 'lv-r-mark');
        d.add(e - 1, e, 'lv-r-mark');
        d.protect(s, e);
    }
}

function decorateComments(d) {
    for (const m of d.text.matchAll(/%%[\s\S]*?%%/g)) {
        if (d.isProtected(m.index)) continue;
        d.add(m.index, m.index + m[0].length, 'lv-r-comment', 'title="Obsidian comment: hidden in previews, but still sent to the model"');
        d.protect(m.index, m.index + m[0].length);
    }
}

/** Separators at the top level of a macro body, skipping nested macros. */
function topLevelSeparators(body) {
    const result = [];
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
        if (body.startsWith('{{', i)) { depth++; i++; continue; }
        if (body.startsWith('}}', i)) { depth = Math.max(0, depth - 1); i++; continue; }
        if (depth === 0 && body.startsWith('::', i)) { result.push(i); i++; }
    }
    return result;
}

function decorateMacro(d, s, e) {
    const body = d.text.slice(s + 2, e - 2);
    const match = body.match(/^\s*(\/\/|[^\s:{}]+)/);
    const category = match ? macroCategory(match[1]) : 'value';
    d.add(s, e, `lv-r-macro lv-r-macro-${category}`);
    d.add(s, s + 2, 'lv-r-mbrace');
    d.add(e - 2, e, 'lv-r-mbrace');
    if (match) {
        const nameStart = s + 2 + match[0].length - match[1].length;
        d.add(nameStart, nameStart + match[1].length, 'lv-r-mname');
    }
    for (const i of topLevelSeparators(body)) d.add(s + 2 + i, s + 4 + i, 'lv-r-msep');
    for (const [ns, ne] of findMacros(body)) decorateMacro(d, s + 2 + ns, s + 2 + ne);
}

function decorateMacros(d) {
    for (const [s, e] of findMacros(d.text)) {
        decorateMacro(d, s, e);
        d.protect(s, e);
    }
}

function decorateTagToken(d, s, raw, level) {
    const e = s + raw.length;
    d.add(s, e, 'lv-r-tag', `style="--lv-level:${level}"`);
    const name = raw.match(/^<\/?([A-Za-z_][\w.:-]*)/);
    if (!name) return;
    const nameStart = s + raw.indexOf(name[1]);
    const nameEnd = nameStart + name[1].length;
    d.add(s, nameStart, 'lv-r-tagp');
    d.add(nameStart, nameEnd, 'lv-r-tagname');
    const closeLength = raw.endsWith('/>') ? 2 : 1;
    const attrs = raw.slice(nameEnd - s, raw.length - closeLength);
    for (const m of attrs.matchAll(ATTR_REGEX)) {
        const at = nameEnd + m.index;
        d.add(at, at + m[1].length, 'lv-r-attrk');
        const value = m[2] ?? m[3] ?? m[4];
        if (value !== undefined) {
            const valueStart = at + m[0].lastIndexOf(value);
            d.add(valueStart, valueStart + value.length, 'lv-r-attrv');
        }
    }
    d.add(e - closeLength, e, 'lv-r-tagp');
}

/** XML-style lore tags: coloured by nesting level, with unmatched tags flagged. */
function decorateTags(d) {
    const stack = [];
    const stray = (tag, reason) => d.add(tag.s, tag.s + tag.raw.length, 'lv-r-stray', `title="${reason}"`);

    for (const m of d.text.matchAll(TAG_REGEX)) {
        const [raw, closing, name, attrs, selfClosing] = m;
        const s = m.index;
        if (d.isProtected(s)) continue;
        const lower = name.toLowerCase();

        if (HTML_TAGS.has(lower)) {
            d.add(s, s + raw.length, 'lv-r-html');
            d.protect(s, s + raw.length);
            continue;
        }
        d.protect(s, s + raw.length);

        if (!closing && !attrs.trim() && !selfClosing && Object.hasOwn(LEGACY_MACROS, lower)) {
            d.add(s, s + raw.length, 'lv-r-macro lv-r-macro-value', `title="Legacy macro for ${LEGACY_MACROS[lower]}"`);
        } else if (!closing && !attrs.trim() && lower === 'start') {
            d.add(s, s + raw.length, 'lv-r-start', 'title="Starts a new example dialogue"');
            d.lines[d.lineAt(s)].cls.push('lv-r-startline');
        } else if (selfClosing && !closing) {
            decorateTagToken(d, s, raw, stack.length);
        } else if (!closing) {
            stack.push({ s, raw, name, level: stack.length });
        } else {
            const index = stack.findLastIndex(tag => tag.name === name);
            if (index === -1) {
                stray({ s, raw }, 'No matching opening tag');
                continue;
            }
            stack.splice(index + 1).forEach(tag => stray(tag, 'Unclosed tag'));
            const open = stack.pop();
            decorateTagToken(d, open.s, open.raw, open.level);
            decorateTagToken(d, s, raw, open.level);
        }
    }
    stack.forEach(tag => stray(tag, 'Unclosed tag'));
}

/** Line-level markdown: headings, quotes and callouts, lists, rules. */
function decorateLines(d) {
    const scan = d.scan.join('');
    for (const line of d.lines) {
        if (line.cls.includes('lv-r-codeblock')) continue;
        const text = scan.slice(line.s, line.e);
        let offset = 0;

        const quote = text.match(/^(?:[ \t]*>[ \t]?)+/);
        if (quote) {
            line.cls.push('lv-r-bq');
            d.add(line.s, line.s + quote[0].length, 'lv-r-mark lv-r-bqmark');
            offset = quote[0].length;
            const callout = text.slice(offset).match(/^\[!(\w+)\]([+-]?)/);
            if (callout) {
                const s = line.s + offset;
                d.add(s, s + callout[0].length, `lv-r-callout lv-r-callout-${callout[1].toLowerCase()}`);
                line.cls.push('lv-r-callout-line');
                offset += callout[0].length;
            }
        }

        const rest = text.slice(offset);
        const heading = rest.match(/^(#{1,6})([ \t]+)/);
        if (heading) {
            line.cls.push(`lv-r-h lv-r-h${heading[1].length}`);
            d.add(line.s + offset, line.s + offset + heading[0].length, 'lv-r-mark');
            continue;
        }

        if (/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(rest) && !quote) {
            line.cls.push('lv-r-hr');
            continue;
        }

        const list = rest.match(/^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?/);
        if (list) {
            const s = line.s + offset + list[1].length;
            d.add(s, s + list[2].length, 'lv-r-list');
            if (list[4]) {
                const taskStart = s + list[2].length + list[3].length;
                d.add(taskStart, taskStart + 3, `lv-r-task${/x/i.test(list[4]) ? ' lv-r-task-done' : ''}`);
            }
            d.protect(s, s + list[2].length);
        }
    }
}

/**
 * Runs an inline pattern over the masked text, line by line.
 * @param {Decorator} d
 * @param {RegExp} regex Global regex
 * @param {(m: RegExpMatchArray, s: number) => void} callback Called with the absolute start offset
 */
function scanInline(d, regex, callback) {
    const scan = d.scan.join('');
    for (const line of d.lines) {
        if (line.cls.includes('lv-r-codeblock')) continue;
        const text = scan.slice(line.s, line.e);
        for (const m of text.matchAll(regex)) callback(m, line.s + m.index);
    }
}

/** Wraps a delimited span, marks its delimiters and stops later patterns from reusing them. */
function delimited(d, s, length, open, close, cls) {
    const e = s + length;
    d.add(s, e, cls);
    d.add(s, s + open, 'lv-r-mark');
    d.add(e - close, e, 'lv-r-mark');
    d.protect(s, s + open);
    d.protect(e - close, e);
}

function decorateInline(d) {
    // [[Link]], [[Link|Alias]], ![[Embed]]
    scanInline(d, /(!?)\[\[([^\]\n\u0001]+)\]\]/g, (m, s) => {
        const e = s + m[0].length;
        const open = m[1].length + 2;
        d.add(s, e, `lv-r-wikilink${m[1] ? ' lv-r-embed' : ''}`, `data-target="${escapeAttr(m[2].split('|')[0].split('#')[0].trim())}"`);
        d.add(s, s + open, 'lv-r-mark');
        d.add(e - 2, e, 'lv-r-mark');
        const pipe = m[2].indexOf('|');
        if (pipe !== -1) d.add(s + open, s + open + pipe + 1, 'lv-r-mark');
        d.protect(s, e);
    });

    // [text](url) and ![alt](url)
    scanInline(d, /(!?)\[([^\]\n]*)\]\(([^)\s\n]*)\)/g, (m, s) => {
        const e = s + m[0].length;
        const textEnd = s + m[1].length + 1 + m[2].length;
        d.add(s, e, m[1] ? 'lv-r-image' : 'lv-r-link', `title="${escapeAttr(m[3])}"`);
        d.add(s, s + m[1].length + 1, 'lv-r-mark');
        d.add(textEnd, e, 'lv-r-mark lv-r-url');
        d.protect(s, e);
    });

    scanInline(d, /(\*\*|__)(?=[^\s*_])(.+?)(?<=[^\s*_])\1/g, (m, s) => delimited(d, s, m[0].length, 2, 2, 'lv-r-bold'));
    scanInline(d, /~~(?=\S)(.+?)(?<=\S)~~/g, (m, s) => delimited(d, s, m[0].length, 2, 2, 'lv-r-strike'));
    scanInline(d, /==(?=\S)([^=\n]+?)(?<=\S)==/g, (m, s) => delimited(d, s, m[0].length, 2, 2, 'lv-r-highlight'));
    scanInline(d, /(?<![*\w\\])\*(?=[^\s*])(.+?)(?<=[^\s*\\])\*(?!\*)/g, (m, s) => delimited(d, s, m[0].length, 1, 1, 'lv-r-italic'));
    scanInline(d, /(?<![_\p{L}\p{N}\\])_(?=[^\s_])(.+?)(?<=[^\s_\\])_(?![_\p{L}\p{N}])/gu, (m, s) => delimited(d, s, m[0].length, 1, 1, 'lv-r-italic'));

    // #tags (not headings, not mid-word)
    scanInline(d, /(^|[\s(])(#[\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu, (m, s) => {
        const start = s + m[1].length;
        d.add(start, start + m[2].length, 'lv-r-hashtag');
    });

    // "Dialogue", coloured like SillyTavern colours quotes in chat
    scanInline(d, /"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, (m, s) => d.add(s, s + m[0].length, 'lv-r-dq'));
}

/**
 * Renders [s, e) of the text with the ranges that fall inside it. Ranges that cross each other
 * are split so the html stays well formed.
 */
function renderSpan(text, s, e, ranges) {
    const events = new Map();
    const at = (i) => {
        if (!events.has(i)) events.set(i, { open: [], close: [] });
        return events.get(i);
    };
    for (const range of ranges) {
        at(range.s).open.push(range);
        at(range.e).close.push(range);
    }
    const points = [...events.keys()].sort((a, b) => a - b);

    let html = '';
    let last = s;
    /** @type {Range[]} */
    const stack = [];
    const openTag = (r) => `<span class="${r.cls}"${r.attrs ? ` ${r.attrs}` : ''}>`;

    for (const point of points) {
        html += escapeHtml(text.slice(last, point));
        last = point;
        const { open, close } = events.get(point);

        if (close.length) {
            // Close down to the deepest range that ends here, then reopen the survivors
            const ending = new Set(close);
            const lowest = stack.findIndex(r => ending.has(r));
            const cut = lowest === -1 ? stack.length : lowest;
            const removed = stack.splice(cut);
            html += '</span>'.repeat(removed.length);
            const reopen = removed.filter(r => !ending.has(r));
            reopen.forEach(r => { html += openTag(r); stack.push(r); });
        }

        // Longer ranges open first so they enclose the shorter ones
        open.sort((a, b) => b.e - a.e).forEach(r => { html += openTag(r); stack.push(r); });
    }
    html += escapeHtml(text.slice(last, e));
    html += '</span>'.repeat(stack.length);
    return html;
}

/**
 * @param {string} text Prompt source
 * @returns {{ lines: string[], lineStarts: number[] }} Html of each line block
 */
export function highlightSource(text) {
    const d = new Decorator(text);
    decorateFences(d);
    decorateInlineCode(d);
    decorateComments(d);
    decorateMacros(d);
    decorateTags(d);
    decorateLines(d);
    decorateInline(d);

    // Clip every range to the lines it covers, so line spans can stay outermost
    const perLine = d.lines.map(() => []);
    for (const range of d.ranges) {
        const first = d.lineAt(range.s);
        if (range.e <= d.lines[first].e) {
            perLine[first].push(range);
            continue;
        }
        for (let i = first; i < d.lines.length && d.lines[i].s < range.e; i++) {
            const line = d.lines[i];
            const s = Math.max(range.s, line.s);
            const e = Math.min(range.e, line.e);
            if (e > s) perLine[i].push({ ...range, s, e });
        }
    }

    const lines = d.lines.map((line, i) => `<div class="${['lv-ln', ...line.cls].join(' ')}">${line.e > line.s ? renderSpan(text, line.s, line.e, perLine[i]) : '<br>'}</div>`);
    return { lines, lineStarts: d.lines.map(line => line.s) };
}
