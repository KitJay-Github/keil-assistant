/**
 * Offset-preserving XML DOM and text-level editor.
 *
 * Why not xml2js: rewriting a whole `.uvproj(x)` file through a generic XML
 * builder re-formats every node, drops empty-element shapes and rewrites the XML
 * declaration. That produces huge diffs and can confuse uVision. This module
 * parses the document once, records byte offsets for every element, and edits
 * only the affected character ranges.
 *
 * Invariant: `parseXml(source).apply()` (no edits) returns `source` unchanged,
 * byte for byte.
 */

export interface XmlTextEdit {
    start: number;
    end: number;
    text: string;
}

export interface XmlAttribute {
    name: string;
    value: string;
}

export interface XmlElement {
    name: string;
    attributes: XmlAttribute[];
    children: XmlElement[];
    parent?: XmlElement;
    /** Index of the opening `<`. */
    start: number;
    /** Index right after the opening tag `>`. */
    startTagEnd: number;
    /** Index of the closing `</`, equals `startTagEnd` for self-closing elements. */
    innerEnd: number;
    /** Index right after the closing tag `>`, equals `startTagEnd` for self-closing elements. */
    end: number;
    selfClosing: boolean;
}

export interface XmlDocument {
    root: XmlElement;
    source: string;
}

const DEFAULT_INDENT_UNIT = '  ';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ParsedTag {
    kind: 'start' | 'end' | 'selfClosing';
    name: string;
    attributes: XmlAttribute[];
    tagStart: number;
    tagEnd: number;
}

function isSpace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function skipSpace(source: string, index: number): number {
    let i = index;
    while (i < source.length && isSpace(source[i])) {
        i++;
    }
    return i;
}

function parseAttributes(raw: string, source: string, tagStart: number): XmlAttribute[] {
    const attributes: XmlAttribute[] = [];
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let match: RegExpExecArray | null;
    while ((match = attrRe.exec(raw)) !== null) {
        attributes.push({
            name: match[1],
            value: decodeXmlText(match[2] !== undefined ? match[2] : match[3])
        });
    }
    void source;
    void tagStart;
    return attributes;
}

function parseStartTag(source: string, tagStart: number): ParsedTag {
    // source[tagStart] === '<'
    let i = tagStart + 1;
    const nameStart = i;
    while (i < source.length && !isSpace(source[i]) && source[i] !== '>' && source[i] !== '/') {
        i++;
    }
    const name = source.slice(nameStart, i);
    if (!name) {
        throw new Error(`Invalid XML: empty tag name at offset ${tagStart}`);
    }

    const bodyStart = i;
    // Find the end of the opening tag, honouring quoted attribute values.
    let quote: string | undefined;
    while (i < source.length) {
        const ch = source[i];
        if (quote) {
            if (ch === quote) {
                quote = undefined;
            }
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '>') {
            break;
        }
        i++;
    }
    if (i >= source.length) {
        throw new Error(`Invalid XML: unterminated tag <${name}> at offset ${tagStart}`);
    }

    const body = source.slice(bodyStart, i);
    const selfClosing = /\/\s*$/.test(body);
    const attributeSource = selfClosing ? body.replace(/\/\s*$/, '') : body;

    return {
        kind: selfClosing ? 'selfClosing' : 'start',
        name,
        attributes: parseAttributes(attributeSource, source, tagStart),
        tagStart,
        tagEnd: i + 1
    };
}

function parseEndTag(source: string, tagStart: number): { name: string; tagEnd: number } {
    let i = tagStart + 2; // skip '</'
    i = skipSpace(source, i);
    const nameStart = i;
    while (i < source.length && !isSpace(source[i]) && source[i] !== '>') {
        i++;
    }
    const name = source.slice(nameStart, i);
    while (i < source.length && source[i] !== '>') {
        i++;
    }
    if (i >= source.length) {
        throw new Error(`Invalid XML: unterminated end tag </${name}> at offset ${tagStart}`);
    }
    return { name, tagEnd: i + 1 };
}

function createElement(tag: ParsedTag, source: string): XmlElement {
    const element: XmlElement = {
        name: tag.name,
        attributes: tag.attributes,
        children: [],
        start: tag.tagStart,
        startTagEnd: tag.tagEnd,
        innerEnd: tag.tagEnd,
        end: tag.tagEnd,
        selfClosing: tag.kind === 'selfClosing'
    };
    Object.defineProperty(element, 'source', {
        value: source,
        enumerable: false,
        configurable: true,
        writable: true
    });
    return element;
}

/**
 * Parse an XML document. Tolerates XML declarations, comments, CDATA sections and
 * DOCTYPE declarations; throws on structurally broken markup (unclosed or
 * mismatched tags).
 */
export function parseXml(source: string): XmlDocument {
    if (typeof source !== 'string' || source.length === 0) {
        throw new Error('Invalid XML: empty document');
    }

    let root: XmlElement | undefined;
    const stack: XmlElement[] = [];
    let i = 0;

    while (i < source.length) {
        const lt = source.indexOf('<', i);
        if (lt === -1) {
            break;
        }

        if (source.startsWith('<!--', lt)) {
            const end = source.indexOf('-->', lt + 4);
            if (end === -1) {
                throw new Error(`Invalid XML: unterminated comment at offset ${lt}`);
            }
            i = end + 3;
            continue;
        }
        if (source.startsWith('<![CDATA[', lt)) {
            const end = source.indexOf(']]>', lt + 9);
            if (end === -1) {
                throw new Error(`Invalid XML: unterminated CDATA section at offset ${lt}`);
            }
            i = end + 3;
            continue;
        }
        if (source.startsWith('<?', lt)) {
            const end = source.indexOf('?>', lt + 2);
            if (end === -1) {
                throw new Error(`Invalid XML: unterminated processing instruction at offset ${lt}`);
            }
            i = end + 2;
            continue;
        }
        if (source.startsWith('<!', lt)) {
            // DOCTYPE and friends; skip to the matching '>'.
            let depth = 0;
            let j = lt + 2;
            for (; j < source.length; j++) {
                const ch = source[j];
                if (ch === '[') {
                    depth++;
                } else if (ch === ']') {
                    depth = Math.max(0, depth - 1);
                } else if (ch === '>' && depth === 0) {
                    break;
                }
            }
            i = j + 1;
            continue;
        }

        if (source[lt + 1] === '/') {
            const endTag = parseEndTag(source, lt);
            const current = stack.pop();
            if (!current) {
                throw new Error(`Invalid XML: unexpected end tag </${endTag.name}> at offset ${lt}`);
            }
            if (current.name !== endTag.name) {
                throw new Error(
                    `Invalid XML: mismatched end tag </${endTag.name}> at offset ${lt}, expected </${current.name}>`
                );
            }
            current.innerEnd = lt;
            current.end = endTag.tagEnd;
            i = endTag.tagEnd;
            continue;
        }

        const tag = parseStartTag(source, lt);
        const element = createElement(tag, source);

        if (stack.length > 0) {
            const parent = stack[stack.length - 1];
            element.parent = parent;
            parent.children.push(element);
        } else if (!root) {
            root = element;
        } else {
            throw new Error(`Invalid XML: multiple root elements (second root <${element.name}> at offset ${lt})`);
        }

        if (tag.kind !== 'selfClosing') {
            stack.push(element);
        }
        i = tag.tagEnd;
    }

    if (stack.length > 0) {
        const unclosed = stack[stack.length - 1];
        throw new Error(`Invalid XML: unclosed element <${unclosed.name}> at offset ${unclosed.start}`);
    }
    if (!root) {
        throw new Error('Invalid XML: no root element found');
    }

    return { root, source };
}

// ---------------------------------------------------------------------------
// Traversal and value helpers
// ---------------------------------------------------------------------------

export function childElements(element: XmlElement, name: string): XmlElement[] {
    return element.children.filter((child) => child.name === name);
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
    return element.children.find((child) => child.name === name);
}

/** Resolve a path of child element names, returning the first matching element. */
export function findPath(root: XmlElement, path: string[]): XmlElement | undefined {
    let current: XmlElement | undefined = root;
    for (const name of path) {
        if (!current) {
            return undefined;
        }
        current = firstChild(current, name);
    }
    return current;
}

/** Resolve a path and return every element matching the last path segment. */
export function findPaths(root: XmlElement, path: string[]): XmlElement[] {
    if (path.length === 0) {
        return [root];
    }
    const parents = path.length === 1 ? [root] : findPaths(root, path.slice(0, -1));
    const result: XmlElement[] = [];
    for (const parent of parents) {
        result.push(...childElements(parent, path[path.length - 1]));
    }
    return result;
}

export function getAttribute(element: XmlElement, name: string): string | undefined {
    const attribute = element.attributes.find((attr) => attr.name === name);
    return attribute ? attribute.value : undefined;
}

function sourceOf(element: XmlElement): string {
    const source = (element as unknown as { source?: string }).source;
    if (typeof source !== 'string') {
        throw new Error(`XmlElement <${element.name}> is not bound to a source document`);
    }
    return source;
}

/** Raw (entity decoded) inner text of a leaf element, without trimming. */
export function textOf(element: XmlElement): string {
    if (element.selfClosing) {
        return '';
    }
    const source = sourceOf(element);
    return decodeXmlText(source.slice(element.startTagEnd, element.innerEnd));
}

/** Inner text of a leaf element with surrounding whitespace removed. */
export function trimmedTextOf(element: XmlElement): string {
    return textOf(element).trim();
}

export function getText(root: XmlElement, path: string[]): string | undefined {
    const element = findPath(root, path);
    return element ? textOf(element) : undefined;
}

export function isWhitespaceOnly(value: string): boolean {
    return /^[ \t\r\n]*$/.test(value);
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

export function escapeXmlText(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeXmlAttribute(value: string): string {
    return escapeXmlText(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function decodeXmlText(value: string): string {
    if (value.indexOf('&') === -1) {
        return value;
    }
    return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
        switch (entity) {
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'amp':
                return '&';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
            default:
                if (entity[0] === '#') {
                    const code = entity[1] === 'x' || entity[1] === 'X'
                        ? parseInt(entity.slice(2), 16)
                        : parseInt(entity.slice(1), 10);
                    if (!isNaN(code)) {
                        return String.fromCodePoint(code);
                    }
                }
                return match;
        }
    });
}

// ---------------------------------------------------------------------------
// Indentation helpers
// ---------------------------------------------------------------------------

/** Whitespace that precedes `element` on its own line (empty when inline). */
export function indentOf(source: string, element: XmlElement): string {
    const lineStart = source.lastIndexOf('\n', element.start - 1) + 1;
    const prefix = source.slice(lineStart, element.start);
    return isWhitespaceOnly(prefix) ? prefix : '';
}

/** Leading whitespace of the line that contains `pos`. */
export function indentAt(source: string, pos: number): string {
    const lineStart = source.lastIndexOf('\n', pos - 1) + 1;
    let i = lineStart;
    while (i < source.length && (source[i] === ' ' || source[i] === '\t')) {
        i++;
    }
    return source.slice(lineStart, i);
}

/**
 * Detect the indentation unit used by a document, e.g. `'  '` or `'\t'`.
 * Falls back to two spaces.
 */
export function detectIndentUnit(source: string): string {
    const counts = new Map<string, number>();
    const stack: Array<{ indent: string }> = [];
    let i = 0;

    while (i < source.length) {
        const lt = source.indexOf('<', i);
        if (lt === -1) {
            break;
        }
        if (source.startsWith('<!--', lt)) {
            const end = source.indexOf('-->', lt + 4);
            i = end === -1 ? source.length : end + 3;
            continue;
        }
        if (source.startsWith('<![CDATA[', lt)) {
            const end = source.indexOf(']]>', lt + 9);
            i = end === -1 ? source.length : end + 3;
            continue;
        }
        if (source.startsWith('<?', lt)) {
            const end = source.indexOf('?>', lt + 2);
            i = end === -1 ? source.length : end + 2;
            continue;
        }

        const lineStart = source.lastIndexOf('\n', lt - 1) + 1;
        const prefix = source.slice(lineStart, lt);
        const ownIndent = isWhitespaceOnly(prefix) ? prefix : '';

        if (source[lt + 1] === '/') {
            stack.pop();
            const end = source.indexOf('>', lt);
            i = end === -1 ? source.length : end + 1;
            continue;
        }

        const parentIndent = stack.length > 0 ? stack[stack.length - 1].indent : '';
        if (ownIndent.length > parentIndent.length && ownIndent.startsWith(parentIndent)) {
            const unit = ownIndent.slice(parentIndent.length);
            if (unit.length > 0) {
                counts.set(unit, (counts.get(unit) || 0) + 1);
            }
        }

        const selfClosing = /\/\s*>$/.test(source.slice(lt, source.indexOf('>', lt) + 1));
        if (!selfClosing) {
            stack.push({ indent: ownIndent });
        }
        const end = source.indexOf('>', lt);
        i = end === -1 ? source.length : end + 1;
    }

    let best: string | undefined;
    let bestCount = 0;
    for (const [unit, count] of counts) {
        if (count > bestCount || (count === bestCount && best !== undefined && unit.length < best.length)) {
            best = unit;
            bestCount = count;
        }
    }
    return best || DEFAULT_INDENT_UNIT;
}

// ---------------------------------------------------------------------------
// Fragment builders
// ---------------------------------------------------------------------------

/** `<Name>value</Name>` on a single line, prefixed by `indent`. */
export function buildLeafElement(name: string, value: string, indent: string): string {
    return `${indent}<${name}>${escapeXmlText(value)}</${name}>`;
}

/** Empty element on a single line: `<Name></Name>`. */
export function buildEmptyElement(name: string, indent: string): string {
    return `${indent}<${name}></${name}>`;
}

/** Multi-line container whose children already carry their own indentation. */
export function buildContainerElement(
    name: string,
    childrenXml: string[],
    indent: string,
    unit: string
): string {
    if (childrenXml.length === 0) {
        return `${indent}<${name}></${name}>`;
    }
    const childIndent = indent + unit;
    void childIndent;
    return `${indent}<${name}>\n${childrenXml.join('\n')}\n${indent}</${name}>`;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export type ApplyOutcome = 'unchanged' | 'updated' | 'created';

interface TrackedEdit extends XmlTextEdit {
    seq: number;
}

/**
 * Pending insertion into a container element. Multiple fragments targeting the
 * same container are coalesced into a single edit so that appending twice does
 * not produce overlapping text ranges.
 */
interface ContainerEdit {
    start: number;
    end: number;
    fragments: string[];
    closingIndent: string;
    closingTag?: string;
}

export class XmlEditor {
    readonly doc: XmlDocument;
    private edits: TrackedEdit[] = [];
    private containerEdits = new Map<string, ContainerEdit>();
    private seq = 0;

    constructor(doc: XmlDocument) {
        this.doc = doc;
    }

    get dirty(): boolean {
        return this.edits.length > 0 || this.containerEdits.size > 0;
    }

    get editCount(): number {
        return this.edits.length + this.containerEdits.size;
    }

    get source(): string {
        return this.doc.source;
    }

    textAt(base: XmlElement, path: string[]): string | undefined {
        const element = findPath(base, path);
        return element ? textOf(element) : undefined;
    }

    /**
     * Set the text of the leaf element addressed by `path` (relative to `base`).
     * Missing elements are created, together with any missing intermediate parents.
     */
    setTextAt(base: XmlElement, path: string[], value: string): ApplyOutcome {
        if (path.length === 0) {
            throw new Error('setTextAt requires a non-empty path');
        }
        const existing = findPath(base, path);
        if (existing) {
            if (existing.children.length > 0) {
                return 'unchanged';
            }
            const current = textOf(existing);
            if (current === value) {
                return 'unchanged';
            }
            this.replaceLeafText(existing, value);
            return 'updated';
        }
        this.createNested(base, path, value);
        return 'created';
    }

    /**
     * Ensure a container element exists at `path` (relative to `base`).
     * Returns true when the element had to be created.
     */
    ensureContainerAt(base: XmlElement, path: string[]): boolean {
        if (path.length === 0) {
            return false;
        }
        if (findPath(base, path)) {
            return false;
        }
        this.createNested(base, path, undefined);
        return true;
    }

    setAttributeAt(base: XmlElement, path: string[], attribute: string, value: string): ApplyOutcome {
        const element = findPath(base, path);
        if (!element) {
            throw new Error(`setAttributeAt: element not found for path ${path.join('/')}`);
        }
        const startTag = this.source.slice(element.start, element.startTagEnd);
        const attrRe = new RegExp(`(\\s${escapeRegExp(attribute)}\\s*=\\s*)("[^"]*"|'[^']*')`);
        const match = attrRe.exec(startTag);
        if (match) {
            const attrStart = element.start + match.index + match[1].length;
            const attrEnd = attrStart + match[2].length;
            const current = decodeXmlText(match[2].slice(1, -1));
            if (current === value) {
                return 'unchanged';
            }
            this.pushEdit(attrStart, attrEnd, `"${escapeXmlAttribute(value)}"`);
            return 'updated';
        }
        // Insert before the closing '/>' or '>'.
        const insertAt = element.selfClosing
            ? this.findSelfClosingSlash(element.start, element.startTagEnd)
            : element.startTagEnd - 1;
        this.pushEdit(insertAt, insertAt, ` ${attribute}="${escapeXmlAttribute(value)}"`);
        return 'created';
    }

    /** Insert a raw XML fragment as the last child of `base`, indented to match. */
    appendChild(base: XmlElement, fragmentXml: string): boolean {
        this.insertIntoContainer(base, fragmentXml);
        return true;
    }

    /** Insert a raw XML fragment into the container addressed by `path`. */
    insertChildXml(base: XmlElement, pathToParent: string[], fragmentXml: string): boolean {
        const parent = findPath(base, pathToParent);
        if (!parent) {
            throw new Error(`insertChildXml: parent not found for path ${pathToParent.join('/')}`);
        }
        this.insertIntoContainer(parent, fragmentXml);
        return true;
    }

    /** Remove the first element matching `path`. */
    removeAt(base: XmlElement, path: string[]): boolean {
        const element = findPath(base, path);
        if (!element) {
            return false;
        }
        this.removeElement(element);
        return true;
    }

    /** Remove every element matching `path`. */
    removeAllAt(base: XmlElement, path: string[]): number {
        const elements = findPaths(base, path);
        for (const element of elements) {
            this.removeElement(element);
        }
        return elements.length;
    }

    /** True when a leaf element exists at `path`. */
    hasPath(base: XmlElement, path: string[]): boolean {
        return findPath(base, path) !== undefined;
    }

    apply(): string {
        const allEdits: TrackedEdit[] = [...this.edits];
        for (const containerEdit of this.containerEdits.values()) {
            allEdits.push({
                start: containerEdit.start,
                end: containerEdit.end,
                text: `\n${containerEdit.fragments.join('\n')}\n${containerEdit.closingIndent}${containerEdit.closingTag || ''}`,
                seq: this.seq++
            });
        }
        if (allEdits.length === 0) {
            return this.doc.source;
        }
        const sorted = [...allEdits].sort((left, right) => {
            if (left.start !== right.start) {
                return right.start - left.start;
            }
            if (left.end !== right.end) {
                return right.end - left.end;
            }
            return right.seq - left.seq;
        });

        let result = this.doc.source;
        let previousStart = Number.POSITIVE_INFINITY;
        for (const edit of sorted) {
            if (edit.end > previousStart) {
                throw new Error(
                    `XmlEditor: overlapping edits detected (offset ${edit.start}-${edit.end} vs ${previousStart})`
                );
            }
            result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
            previousStart = edit.start;
        }
        return result;
    }

    // -- internals ---------------------------------------------------------

    private pushEdit(start: number, end: number, text: string): void {
        this.edits.push({ start, end, text, seq: this.seq++ });
    }

    private findSelfClosingSlash(tagStart: number, tagEnd: number): number {
        let i = tagEnd - 2;
        while (i > tagStart && isSpace(this.source[i])) {
            i--;
        }
        if (this.source[i] !== '/') {
            throw new Error(`XmlEditor: expected self-closing slash in tag at offset ${tagStart}`);
        }
        return i;
    }

    private replaceLeafText(element: XmlElement, value: string): void {
        const escaped = escapeXmlText(value);
        if (element.selfClosing) {
            const slash = this.findSelfClosingSlash(element.start, element.startTagEnd);
            this.pushEdit(slash, element.startTagEnd, `>${escaped}</${element.name}>`);
            return;
        }
        if (element.children.length > 0) {
            return;
        }
        this.pushEdit(element.startTagEnd, element.innerEnd, escaped);
    }

    private removeElement(element: XmlElement): void {
        const source = this.source;
        const lineStart = source.lastIndexOf('\n', element.start - 1) + 1;
        const prefix = source.slice(lineStart, element.start);
        if (isWhitespaceOnly(prefix)) {
            // Remove the whole line, including the trailing newline.
            let lineEnd = element.end;
            if (lineEnd < source.length && source[lineEnd] === '\r') {
                lineEnd++;
            }
            if (lineEnd < source.length && source[lineEnd] === '\n') {
                lineEnd++;
            }
            this.pushEdit(lineStart, lineEnd, '');
            return;
        }
        this.pushEdit(element.start, element.end, '');
    }

    private insertIntoContainer(container: XmlElement, fragmentXml: string): void {
        const source = this.source;
        const containerIndent = indentOf(source, container);

        const addContainerEdit = (start: number, end: number, closingIndent: string): void => {
            const key = `${start}:${end}`;
            const existing = this.containerEdits.get(key);
            if (existing) {
                existing.fragments.push(fragmentXml);
                return;
            }
            this.containerEdits.set(key, {
                start,
                end,
                fragments: [fragmentXml],
                closingIndent
            });
        };

        if (container.selfClosing) {
            const slash = this.findSelfClosingSlash(container.start, container.startTagEnd);
            // `<Files/>` -> `<Files>` + content + `</Files>`.
            this.pushEdit(slash, container.startTagEnd, '>');
            const key = `${container.startTagEnd}:${container.startTagEnd}`;
            const existing = this.containerEdits.get(key);
            if (existing) {
                existing.fragments.push(fragmentXml);
            } else {
                this.containerEdits.set(key, {
                    start: container.startTagEnd,
                    end: container.startTagEnd,
                    fragments: [fragmentXml],
                    closingIndent: containerIndent,
                    closingTag: `</${container.name}>`
                });
            }
            return;
        }

        const innerText = source.slice(container.startTagEnd, container.innerEnd);
        const lastNewline = innerText.lastIndexOf('\n');
        const trailing = innerText.slice(lastNewline + 1);

        if (lastNewline !== -1 && isWhitespaceOnly(trailing)) {
            // Multi-line container: replace the trailing indentation of the close tag.
            addContainerEdit(container.startTagEnd + lastNewline, container.innerEnd, containerIndent);
            return;
        }

        if (isWhitespaceOnly(innerText) && innerText.indexOf('\n') === -1) {
            // Inline empty container: `<Files></Files>`.
            addContainerEdit(container.startTagEnd, container.innerEnd, containerIndent);
            return;
        }

        // Inline content: append right before the closing tag.
        addContainerEdit(container.innerEnd, container.innerEnd, containerIndent);
    }

    /** Create a nested element path below the deepest existing ancestor. */
    private createNested(base: XmlElement, path: string[], value: string | undefined): void {
        const unit = detectIndentUnit(this.source);

        let existingDepth = 0;
        let deepest: XmlElement = base;
        for (let i = 0; i < path.length; i++) {
            const next = firstChild(deepest, path[i]);
            if (!next) {
                break;
            }
            deepest = next;
            existingDepth = i + 1;
        }

        const remaining = path.slice(existingDepth);
        if (remaining.length === 0) {
            return;
        }

        const baseIndent = indentOf(this.source, deepest);
        const lines: string[] = [];
        for (let i = 0; i < remaining.length; i++) {
            const indent = baseIndent + unit.repeat(i + 1);
            const isLast = i === remaining.length - 1;
            if (isLast) {
                lines.push(
                    value === undefined
                        ? buildEmptyElement(remaining[i], indent)
                        : buildLeafElement(remaining[i], value, indent)
                );
            } else {
                lines.push(`${indent}<${remaining[i]}>`);
            }
        }
        // Close the containers from the inside out.
        for (let i = remaining.length - 2; i >= 0; i--) {
            lines.push(`${baseIndent + unit.repeat(i + 1)}</${remaining[i]}>`);
        }

        const fragment = lines.join('\n');
        this.insertIntoContainer(deepest, fragment);
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Parse `xml`, hand the parsed document to `mutate`, and return the new text. */
export function updateProjectXml(xml: string, mutate: (editor: XmlEditor, root: XmlElement) => void): string {
    const doc = parseXml(xml);
    const editor = new XmlEditor(doc);
    mutate(editor, doc.root);
    return editor.apply();
}

/** Locate every `<Target>` element of a `<Project>` document. */
export function projectTargets(root: XmlElement): XmlElement[] {
    const targets = findPath(root, ['Targets']);
    if (!targets) {
        return [];
    }
    return childElements(targets, 'Target');
}

/** Read `<TargetName>` of a target element. */
export function targetNameOf(target: XmlElement): string {
    const element = firstChild(target, 'TargetName');
    return element ? textOf(element).trim() : '';
}

/** Find a `<Target>` by name (case-sensitive). */
export function findTarget(root: XmlElement, targetName: string): XmlElement | undefined {
    return projectTargets(root).find((target) => targetNameOf(target) === targetName);
}
