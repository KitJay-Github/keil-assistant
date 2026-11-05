/**
 * Group and file editing for Keil `.uvproj` / `.uvprojx` projects.
 *
 * Every function in this module is pure: it takes the project file text and
 * returns the new text. Parsing uses the offset-preserving {@link parseXml}
 * DOM and all edits are performed through {@link XmlEditor}, so untouched parts
 * of the document (formatting, XML declaration, comments, unrelated targets)
 * stay byte-for-byte identical.
 *
 * Path handling notes:
 * - File paths stored in the project file are Windows style and may be relative
 *   (`.\src\main.c`, `..\shared\main.c`) or absolute (cross-drive references).
 * - Paths are compared after `\\` -> `/` normalization, `path.normalize` and
 *   lower-casing, because Windows paths are case-insensitive.
 * - Paths written back use a `.\` prefix plus backslashes; cross-drive targets
 *   are written as absolute paths (see {@link toUvProjectPath}).
 */

import * as path from 'path';

import {
    XmlDocument,
    XmlEditor,
    XmlElement,
    buildEmptyElement,
    buildLeafElement,
    childElements,
    detectIndentUnit,
    findPath,
    findTarget,
    firstChild,
    indentOf,
    isWhitespaceOnly,
    parseXml,
    projectTargets,
    targetNameOf,
    textOf
} from './uvXml';

export type UvToolchainKind = 'ARM' | 'ARM6' | 'C51' | 'C251';

export interface UvFileEntry {
    fileName: string;
    filePath: string;
    fileType: number;
    includeInBuild: boolean;
}

export interface UvGroupEntry {
    name: string;
    includeInBuild: boolean;
    files: UvFileEntry[];
}

export interface UvTargetSummary {
    name: string;
    toolchain: UvToolchainKind;
    groupCount: number;
    fileCount: number;
}

/** Minimal description of a file that should be added to a group. */
export interface UvFileToAdd {
    /** Path as it is written into the project file (usually a `.\` path). */
    filePath: string;
    fileName: string;
    /** Keil `FileType`, e.g. 1 for C sources. */
    fileType: number;
}

/** Element path of the group include-in-build flag, relative to `<Group>`. */
const GROUP_INCLUDE_IN_BUILD_PATH = ['GroupOption', 'CommonProperty', 'IncludeInBuild'];

/** Element path of the file include-in-build flag, relative to `<File>`. */
const FILE_INCLUDE_IN_BUILD_PATH = ['FileOption', 'CommonProperty', 'IncludeInBuild'];

/** Keil's generic file type, used when the extension cannot be mapped. */
const FALLBACK_FILE_TYPE = 5;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function listTargets(xml: string): UvTargetSummary[] {
    const doc = parseXml(xml);
    return projectTargets(doc.root).map((target) => {
        const groups = groupElementsOf(target);
        return {
            name: targetNameOf(target),
            toolchain: detectToolchainOf(target),
            groupCount: groups.length,
            fileCount: groups.reduce((total, group) => total + fileElementsOf(group).length, 0)
        };
    });
}

export function detectToolchainOfTarget(xml: string, targetName: string): UvToolchainKind | undefined {
    const doc = parseXml(xml);
    const target = findTarget(doc.root, targetName);
    return target ? detectToolchainOf(target) : undefined;
}

export function readTargetGroups(xml: string, targetName: string): UvGroupEntry[] | undefined {
    const doc = parseXml(xml);
    const target = findTarget(doc.root, targetName);
    if (!target) {
        return undefined;
    }
    return groupElementsOf(target).map((group) => ({
        name: groupNameOf(group),
        includeInBuild: readIncludeInBuild(group, GROUP_INCLUDE_IN_BUILD_PATH),
        files: fileElementsOf(group).map((file) => ({
            fileName: fileNameOf(file),
            filePath: filePathOf(file),
            fileType: fileTypeOf(file),
            includeInBuild: readIncludeInBuild(file, FILE_INCLUDE_IN_BUILD_PATH)
        }))
    }));
}

// ---------------------------------------------------------------------------
// Group editing
// ---------------------------------------------------------------------------

export function addGroup(xml: string, targetName: string, groupName: string): string {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    if (findGroup(target, groupName)) {
        return xml;
    }

    const source = doc.source;
    const unit = detectIndentUnit(source);
    const editor = new XmlEditor(doc);
    insertGroupNode(editor, source, target, (groupIndent) => [
        buildLeafElement('GroupName', groupName, groupIndent + unit),
        buildEmptyElement('Files', groupIndent + unit)
    ]);
    return editor.apply();
}

export function renameGroup(xml: string, targetName: string, oldName: string, newName: string): string {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    const group = findGroup(target, oldName);
    if (!group || oldName === newName) {
        return xml;
    }

    const editor = new XmlEditor(doc);
    const outcome = editor.setTextAt(group, ['GroupName'], newName);
    return outcome === 'unchanged' ? xml : editor.apply();
}

export function removeGroup(xml: string, targetName: string, groupName: string): string {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    const group = findGroup(target, groupName);
    if (!group) {
        return xml;
    }
    // `<Files>` lives inside `<Group>`, so removing the group node removes both.
    return removeElementText(doc.source, group);
}

export function setGroupInBuild(
    xml: string,
    targetName: string,
    groupName: string,
    include: boolean
): string {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    const group = findGroup(target, groupName);
    if (!group) {
        return xml;
    }
    if (readIncludeInBuild(group, GROUP_INCLUDE_IN_BUILD_PATH) === include) {
        return xml;
    }

    const editor = new XmlEditor(doc);
    editor.setTextAt(group, GROUP_INCLUDE_IN_BUILD_PATH, include ? '1' : '0');
    return editor.apply();
}

// ---------------------------------------------------------------------------
// File editing
// ---------------------------------------------------------------------------

export function addFiles(
    xml: string,
    targetName: string,
    groupName: string,
    files: UvFileToAdd[]
): { xml: string; added: string[]; skipped: string[] } {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    const source = doc.source;
    const unit = detectIndentUnit(source);
    const group = findGroup(target, groupName);

    const knownPaths = new Set<string>();
    if (group) {
        for (const file of fileElementsOf(group)) {
            knownPaths.add(comparablePath(filePathOf(file)));
        }
    }

    const added: string[] = [];
    const skipped: string[] = [];
    const pending: UvFileToAdd[] = [];
    for (const file of files) {
        const key = comparablePath(file.filePath);
        if (key === '' || knownPaths.has(key)) {
            skipped.push(file.filePath);
            continue;
        }
        knownPaths.add(key);
        added.push(file.filePath);
        pending.push(file);
    }

    if (pending.length === 0) {
        return { xml, added, skipped };
    }

    const editor = new XmlEditor(doc);
    const fileLines = (fileIndent: string): string[] =>
        pending.map((file) => buildFileFragment(source, fileIndent, file));

    if (group) {
        insertFileNodes(editor, source, group, fileLines);
    } else {
        insertGroupNode(editor, source, target, (groupIndent) => [
            buildLeafElement('GroupName', groupName, groupIndent + unit),
            ...buildFilesBlockLines(unit, groupIndent + unit, fileLines)
        ]);
    }

    return { xml: editor.apply(), added, skipped };
}

export function removeFile(xml: string, targetName: string, groupName: string, filePath: string): string {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    const group = findGroup(target, groupName);
    if (!group) {
        return xml;
    }
    const file = findFileInGroup(group, filePath);
    if (!file) {
        return xml;
    }
    return removeElementText(doc.source, file);
}

export function moveFile(
    xml: string,
    targetName: string,
    fromGroup: string,
    toGroup: string,
    filePath: string
): string {
    if (fromGroup === toGroup) {
        return xml;
    }

    const sourceDoc = parseXml(xml);
    const sourceTarget = requireTarget(sourceDoc, targetName);
    const sourceGroup = findGroup(sourceTarget, fromGroup);
    if (!sourceGroup) {
        return xml;
    }
    const fileElement = findFileInGroup(sourceGroup, filePath);
    if (!fileElement) {
        return xml;
    }

    // Keep the whole `<File>` subtree (including `FileOption` and any other
    // child nodes uVision may have written) and re-indent it for its new home.
    const originalIndent = indentOf(sourceDoc.source, fileElement);
    const rawFragment = sourceDoc.source.slice(fileElement.start, fileElement.end);
    const withoutFile = removeElementText(sourceDoc.source, fileElement);

    // The removal shifted offsets, so re-parse before inserting the fragment.
    const doc = parseXml(withoutFile);
    const target = requireTarget(doc, targetName);
    const unit = detectIndentUnit(doc.source);
    const editor = new XmlEditor(doc);
    const destination = findGroup(target, toGroup);
    const fileLines = (fileIndent: string): string[] => [
        shiftFragmentIndent(rawFragment, originalIndent, fileIndent)
    ];

    if (destination) {
        insertFileNodes(editor, doc.source, destination, fileLines);
    } else {
        insertGroupNode(editor, doc.source, target, (groupIndent) => [
            buildLeafElement('GroupName', toGroup, groupIndent + unit),
            ...buildFilesBlockLines(unit, groupIndent + unit, fileLines)
        ]);
    }

    return editor.apply();
}

export function setFileInBuild(
    xml: string,
    targetName: string,
    groupName: string,
    filePath: string,
    include: boolean
): string {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    const group = findGroup(target, groupName);
    if (!group) {
        return xml;
    }
    const file = findFileInGroup(group, filePath);
    if (!file) {
        return xml;
    }
    if (readIncludeInBuild(file, FILE_INCLUDE_IN_BUILD_PATH) === include) {
        return xml;
    }

    const editor = new XmlEditor(doc);
    editor.setTextAt(file, FILE_INCLUDE_IN_BUILD_PATH, include ? '1' : '0');
    return editor.apply();
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Map a file name (or path) to the numeric `FileType` uVision stores in the
 * project file.
 */
export function fileTypeForPath(filePath: string): number {
    const extension = path.extname(filePath.trim()).toLowerCase();
    switch (extension) {
        case '.c':
            return 1;
        case '.cpp':
        case '.cc':
        case '.cxx':
        case '.c++':
            return 8;
        case '.s':
        case '.asm':
        case '.a51':
            return 2;
        case '.lib':
        case '.a':
            return 4;
        case '.o':
        case '.obj':
            return 3;
        case '.png':
        case '.jpg':
        case '.gif':
        case '.bmp':
            return 9;
        case '.html':
        case '.htm':
        case '.inp':
            return 7;
        default:
            return FALLBACK_FILE_TYPE;
    }
}

/**
 * Convert an absolute path into the path form stored in the project file.
 *
 * Returns `.\relative\path` for every same-drive target and an absolute path
 * when the target is on another drive (uVision cannot express that relatively).
 */
export function toUvProjectPath(projectDir: string, absPath: string): string {
    const projectRoot = path.normalize(toNativeSeparators(projectDir.trim()));
    const target = path.normalize(toNativeSeparators(absPath.trim()));

    if (!path.isAbsolute(target)) {
        // Already a project relative path (e.g. from the tree view).
        return `.${path.sep}${target.replace(/^\.?[\\/]+/, '')}`;
    }

    const relative = path.relative(projectRoot, target);
    if (relative === '') {
        return '.';
    }
    if (path.isAbsolute(relative)) {
        // Different drive: there is no relative form.
        return target;
    }
    return `.${path.sep}${relative}`;
}

/**
 * Convert a project-file relative path (`.\src\main.c`, `..\shared\main.c`) or
 * an absolute path back into an absolute path.
 */
export function fromUvProjectPath(projectDir: string, uvPath: string): string {
    const projectRoot = path.normalize(toNativeSeparators(projectDir.trim()));
    const raw = uvPath.trim();
    if (raw === '') {
        return projectRoot;
    }
    const native = toNativeSeparators(raw);
    if (path.isAbsolute(native)) {
        return path.normalize(native);
    }
    return path.normalize(path.join(projectRoot, native));
}

// ---------------------------------------------------------------------------
// Internal helpers: reading
// ---------------------------------------------------------------------------

function targetOf(doc: XmlDocument, targetName: string): XmlElement | undefined {
    return findTarget(doc.root, targetName);
}

function requireTarget(doc: XmlDocument, targetName: string): XmlElement {
    const target = targetOf(doc, targetName);
    if (!target) {
        throw new Error(`工程中不存在目标「${targetName}」，无法修改工程文件。`);
    }
    return target;
}

function detectToolchainOf(target: XmlElement): UvToolchainKind {
    const toolsetName = textOfChild(target, 'ToolsetName').toUpperCase();
    const hasTarget251 = findPath(target, ['TargetOption', 'Target251']) !== undefined;
    const hasTarget51 = findPath(target, ['TargetOption', 'Target51']) !== undefined;

    // `MCS-251` also contains the substring `51`, so 251 must be checked first.
    if (toolsetName.indexOf('251') !== -1 || hasTarget251) {
        return 'C251';
    }
    if (toolsetName.indexOf('51') !== -1 || hasTarget51) {
        return 'C51';
    }

    const hasArmAds = findPath(target, ['TargetOption', 'TargetArmAds']) !== undefined;
    const usesArmclang = textOfChild(target, 'uAC6') === '1';
    return usesArmclang && hasArmAds ? 'ARM6' : 'ARM';
}

function groupsOf(target: XmlElement): XmlElement | undefined {
    return firstChild(target, 'Groups');
}

function groupElementsOf(target: XmlElement): XmlElement[] {
    const groups = groupsOf(target);
    return groups ? childElements(groups, 'Group') : [];
}

function groupNameOf(group: XmlElement): string {
    return textOfChild(group, 'GroupName');
}

function findGroup(target: XmlElement, groupName: string): XmlElement | undefined {
    return groupElementsOf(target).find((group) => groupNameOf(group) === groupName);
}

function filesOf(group: XmlElement): XmlElement | undefined {
    return firstChild(group, 'Files');
}

function fileElementsOf(group: XmlElement): XmlElement[] {
    const files = filesOf(group);
    return files ? childElements(files, 'File') : [];
}

function fileNameOf(file: XmlElement): string {
    return textOfChild(file, 'FileName');
}

function filePathOf(file: XmlElement): string {
    return textOfChild(file, 'FilePath');
}

function fileTypeOf(file: XmlElement): number {
    const parsed = Number.parseInt(textOfChild(file, 'FileType'), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return fileTypeForPath(fileNameOf(file) || filePathOf(file));
}

function findFileInGroup(group: XmlElement, filePath: string): XmlElement | undefined {
    const key = comparablePath(filePath);
    return fileElementsOf(group).find((file) => comparablePath(filePathOf(file)) === key);
}

function readIncludeInBuild(element: XmlElement, optionPath: string[]): boolean {
    const node = findPath(element, optionPath);
    if (!node) {
        // uVision omits the flag for files/groups that do take part in builds.
        return true;
    }
    const raw = textOf(node).trim().toLowerCase();
    if (raw === '') {
        return true;
    }
    return raw !== '0' && raw !== 'false';
}

function textOfChild(element: XmlElement, name: string): string {
    const child = firstChild(element, name);
    return child ? textOf(child).trim() : '';
}

/**
 * Normalize a project-file path for equality checks: `\\` -> `/`, collapsed
 * `.`/`..` segments, no `.\` prefix, lower case.
 */
function comparablePath(value: string): string {
    const trimmed = value.trim();
    if (trimmed === '') {
        return '';
    }
    return path
        .normalize(trimmed.replace(/\//g, path.sep))
        .replace(/[\\/]+/g, '/')
        .replace(/^\.\//, '')
        .toLowerCase();
}

// ---------------------------------------------------------------------------
// Internal helpers: fragments and indentation
// ---------------------------------------------------------------------------

function toNativeSeparators(value: string): string {
    return value.replace(/[\\/]+/g, path.sep);
}

/** Indentation of the line that holds `element`, resolved through parents when inline. */
function effectiveIndent(source: string, element: XmlElement): string {
    const own = indentOf(source, element);
    if (own.length > 0) {
        return own;
    }
    const parent = element.parent;
    if (!parent) {
        return '';
    }
    return effectiveIndent(source, parent) + detectIndentUnit(source);
}

/** One `<File>` node with FileName/FileType/FilePath children. */
function buildFileFragment(source: string, fileIndent: string, file: UvFileToAdd): string {
    const unit = detectIndentUnit(source);
    const leafIndent = fileIndent + unit;
    const fileType = Number.isFinite(file.fileType) && file.fileType > 0
        ? file.fileType
        : fileTypeForPath(file.fileName || file.filePath);

    return [
        `${fileIndent}<File>`,
        buildLeafElement('FileName', file.fileName, leafIndent),
        buildLeafElement('FileType', String(fileType), leafIndent),
        buildLeafElement('FilePath', file.filePath, leafIndent),
        `${fileIndent}</File>`
    ].join('\n');
}

/** `<Files> ... </Files>` block whose file lines are produced by `buildFileLines`. */
function buildFilesBlockLines(
    unit: string,
    filesIndent: string,
    buildFileLines: (fileIndent: string) => string[]
): string[] {
    const fileIndent = filesIndent + unit;
    return [`${filesIndent}<Files>`, ...buildFileLines(fileIndent), `${filesIndent}</Files>`];
}

/**
 * Insert file nodes into an existing group, creating the `<Files>` container
 * (or expanding a self-closing one) when necessary.
 */
function insertFileNodes(
    editor: XmlEditor,
    source: string,
    group: XmlElement,
    buildFileLines: (fileIndent: string) => string[]
): void {
    const unit = detectIndentUnit(source);
    const files = filesOf(group);
    if (files) {
        const fileIndent = effectiveIndent(source, files) + unit;
        editor.appendChild(files, buildFileLines(fileIndent).join('\n'));
        return;
    }

    const filesIndent = effectiveIndent(source, group) + unit;
    editor.appendChild(group, buildFilesBlockLines(unit, filesIndent, buildFileLines).join('\n'));
}

/**
 * Insert a new `<Group>` node under `<Groups>`, creating `<Groups>` when the
 * target does not have one yet.
 */
function insertGroupNode(
    editor: XmlEditor,
    source: string,
    target: XmlElement,
    buildInnerLines: (groupIndent: string) => string[]
): void {
    const unit = detectIndentUnit(source);
    const groups = groupsOf(target);
    if (groups) {
        const groupIndent = effectiveIndent(source, groups) + unit;
        editor.appendChild(
            groups,
            [`${groupIndent}<Group>`, ...buildInnerLines(groupIndent), `${groupIndent}</Group>`].join('\n')
        );
        return;
    }

    const groupsIndent = effectiveIndent(source, target) + unit;
    const groupIndent = groupsIndent + unit;
    editor.appendChild(
        target,
        [
            `${groupsIndent}<Groups>`,
            `${groupIndent}<Group>`,
            ...buildInnerLines(groupIndent),
            `${groupIndent}</Group>`,
            `${groupsIndent}</Groups>`
        ].join('\n')
    );
}

/**
 * Re-indent a raw element fragment copied from another position of the file.
 * Only the base indentation is shifted; nested indentation is preserved.
 */
function shiftFragmentIndent(rawFragment: string, originalIndent: string, targetIndent: string): string {
    return rawFragment
        .split('\n')
        .map((line, index) => {
            if (index === 0) {
                return `${targetIndent}${line}`;
            }
            if (line.length === 0) {
                return line;
            }
            const relative = originalIndent.length > 0 && line.startsWith(originalIndent)
                ? line.slice(originalIndent.length)
                : line.replace(/^[ \t]+/, '');
            return `${targetIndent}${relative}`;
        })
        .join('\n');
}

/**
 * Remove one element (plus its own line when it stands alone) from the
 * document text.
 *
 * `XmlEditor.removeAt` only addresses the *first* match of a path, so it cannot
 * delete an arbitrary `<Group>`/`<File>` instance. This helper performs the very
 * same minimal line-level deletion `XmlEditor` uses internally.
 */
function removeElementText(source: string, element: XmlElement): string {
    const lineStart = source.lastIndexOf('\n', element.start - 1) + 1;
    const prefix = source.slice(lineStart, element.start);
    if (isWhitespaceOnly(prefix)) {
        let lineEnd = element.end;
        if (source[lineEnd] === '\r') {
            lineEnd++;
        }
        if (source[lineEnd] === '\n') {
            lineEnd++;
        }
        return source.slice(0, lineStart) + source.slice(lineEnd);
    }
    return source.slice(0, element.start) + source.slice(element.end);
}
