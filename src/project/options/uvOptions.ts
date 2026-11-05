/**
 * Read/write of `.uvprojx` / `.uvproj` target options.
 *
 * The functions in this module are pure string -> string transforms on top of
 * the offset preserving XML editor in `src/project/uvXml.ts`:
 * - only fields declared with `file === 'uvprojx'` in the schema are handled,
 * - values that did not change produce no text edit at all (the returned text
 *   is then byte-for-byte identical to the input),
 * - missing elements are created with `XmlEditor.setTextAt`.
 *
 * Companion `.uvopt(x)` values are handled by `uvoptFile.ts`.
 */
import {
    XmlDocument,
    XmlEditor,
    XmlElement,
    findPath,
    findTarget,
    firstChild,
    parseXml,
    trimmedTextOf
} from '../uvXml';
import { OPTION_FIELDS, OPTION_FIELDS_BY_ID } from './uvOptionSchema';
import { OptionApplyResult, OptionFieldDef, UvToolchainKind } from './types';

export interface OptionReadResult {
    toolchain: UvToolchainKind;
    values: Record<string, string | undefined>;
}

/** Fields whose value lives in the project file itself (`.uvprojx` / `.uvproj`). */
const UVPROJX_FIELDS: readonly OptionFieldDef[] = OPTION_FIELDS.filter((optionField) => optionField.file === 'uvprojx');

/** Human readable label used in the panel, notifications and warnings. */
export function toolchainLabel(toolchain: UvToolchainKind): string {
    switch (toolchain) {
        case 'ARM':
            return 'ARM (AC5)';
        case 'ARM6':
            return 'ARM (AC6)';
        case 'C51':
            return 'C51';
        case 'C251':
            return 'C251';
        default:
            return String(toolchain);
    }
}

/** Find a `<Target>` by name, throwing a descriptive error when it is missing. */
function requireTarget(doc: XmlDocument, targetName: string): XmlElement {
    const target = findTarget(doc.root, targetName);
    if (!target) {
        throw new Error(`目标不存在：${targetName}`);
    }
    return target;
}

/** Detect the toolchain family of an already parsed `<Target>` element. */
function toolchainOfTarget(target: XmlElement, targetName: string): UvToolchainKind {
    const targetOption = firstChild(target, 'TargetOption');
    if (targetOption) {
        const targetArmAds = firstChild(targetOption, 'TargetArmAds');
        if (targetArmAds) {
            const uac6 = firstChild(target, 'uAC6');
            return uac6 && trimmedTextOf(uac6) === '1' ? 'ARM6' : 'ARM';
        }
        const target51 = firstChild(targetOption, 'Target51');
        if (target51 && firstChild(target51, 'C51')) {
            return 'C51';
        }
        if (target51 && firstChild(target51, 'C251')) {
            return 'C251';
        }
        const target251 = firstChild(targetOption, 'Target251');
        if (target251 && firstChild(target251, 'C251')) {
            return 'C251';
        }
    }
    throw new Error(
        `无法识别目标「${targetName}」的工具链（未找到 TargetArmAds / Target51+C51 / Target251+C251）`
    );
}

/** Detect the toolchain family of a target inside an already parsed document. */
export function detectTargetToolchainFromDocument(doc: XmlDocument, targetName: string): UvToolchainKind {
    return toolchainOfTarget(requireTarget(doc, targetName), targetName);
}

/** Convenience wrapper around {@link detectTargetToolchainFromDocument}. */
export function detectTargetToolchain(xml: string, targetName: string): UvToolchainKind {
    return detectTargetToolchainFromDocument(parseXml(xml), targetName);
}

/** Read every `.uvprojx` field of one target. Missing elements yield `undefined`. */
export function readTargetValuesFromDocument(doc: XmlDocument, targetName: string): OptionReadResult {
    const target = requireTarget(doc, targetName);
    const toolchain = toolchainOfTarget(target, targetName);
    const values: Record<string, string | undefined> = {};
    for (const optionField of UVPROJX_FIELDS) {
        const path = optionField.path[toolchain];
        if (!path) {
            continue;
        }
        const element = findPath(target, path);
        values[optionField.id] = element ? trimmedTextOf(element) : undefined;
    }
    return { toolchain, values };
}

/** Read every `.uvprojx` field of one target. Throws when the target/toolchain is unknown. */
export function readTargetOptions(xml: string, targetName: string): OptionReadResult {
    return readTargetValuesFromDocument(parseXml(xml), targetName);
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeBoolValue(optionField: OptionFieldDef, raw: string): string | undefined {
    const value = raw.trim().toLowerCase();
    if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
        return '1';
    }
    if (value === '0' || value === 'false' || value === 'no' || value === 'off' || value === '') {
        return '0';
    }
    return undefined;
}

/**
 * Normalize a value coming from the webview before it is written into XML.
 * Booleans always end up as the `'1'` / `'0'` strings Keil uses; numbers are
 * validated; everything else is trimmed (multiline values keep their layout).
 * Returns `undefined` when the value must be skipped.
 */
export function normalizeOptionValue(
    optionField: OptionFieldDef,
    rawValue: string,
    warnings: string[]
): string | undefined {
    const raw = typeof rawValue === 'string' ? rawValue : String(rawValue);
    if (optionField.type === 'bool') {
        const normalized = normalizeBoolValue(optionField, raw);
        if (normalized === undefined) {
            warnings.push(`字段 ${optionField.label}（${optionField.id}）需要 1/0 布尔值，已忽略：${raw}`);
        }
        return normalized;
    }
    if (optionField.type === 'number') {
        const trimmed = raw.trim();
        if (trimmed !== '' && Number.isNaN(Number(trimmed))) {
            warnings.push(`字段 ${optionField.label}（${optionField.id}）需要数字，已忽略：${raw}`);
            return undefined;
        }
        return trimmed;
    }
    if (optionField.type === 'multiline') {
        return raw;
    }
    return raw.trim();
}

/**
 * One missing element that has to be created by `applyTargetOptions`.
 * Creations are applied one at a time on freshly parsed text: `XmlEditor`
 * computes edits against a frozen DOM, so creating two sibling nodes below the
 * same missing container in one editor pass would emit the container twice.
 */
interface PendingCreation {
    id: string;
    path: string[];
    value: string;
}

/**
 * Apply option edits to a `.uvprojx` string.
 *
 * Only fields declared with `file === 'uvprojx'` are written; `.uvopt` field ids
 * are ignored here (they are written by `applyUvoptOptions`). Unchanged values
 * do not produce any edit, in which case the returned XML is identical to the
 * input text.
 */
export function applyTargetOptions(
    xml: string,
    targetName: string,
    values: Record<string, string>
): OptionApplyResult {
    const doc = parseXml(xml);
    const target = requireTarget(doc, targetName);
    const toolchain = toolchainOfTarget(target, targetName);
    const changed: string[] = [];
    const warnings: string[] = [];

    const updates: Array<{ id: string; path: string[]; value: string }> = [];
    const creations: PendingCreation[] = [];

    for (const id of Object.keys(values)) {
        const optionField = OPTION_FIELDS_BY_ID.get(id);
        if (!optionField) {
            warnings.push(`未知选项字段：${id}`);
            continue;
        }
        if (optionField.file !== 'uvprojx') {
            // `.uvopt` fields are written to the companion file by the caller.
            continue;
        }
        if (optionField.readonly) {
            continue;
        }
        const path = optionField.path[toolchain];
        if (!path) {
            warnings.push(
                `字段 ${optionField.label}（${id}）在 ${toolchainLabel(toolchain)} 中不可用，已忽略`
            );
            continue;
        }
        const normalized = normalizeOptionValue(optionField, values[id], warnings);
        if (normalized === undefined) {
            continue;
        }
        const existing = findPath(target, path);
        if (!existing) {
            // Absence already means "unset": do not pollute the project with empty
            // elements (or an explicit bool `0`) when the panel sends every field.
            const isDefaultBool = optionField.type === 'bool' && normalized === '0';
            if (normalized === '' || isDefaultBool) {
                continue;
            }
            creations.push({ id, path, value: normalized });
            continue;
        }
        if (trimmedTextOf(existing) === normalized) {
            // Reading trims surrounding whitespace; compare the normalized value so
            // that read -> apply never rewrites an unchanged element.
            continue;
        }
        updates.push({ id, path, value: normalized });
    }

    let currentXml = xml;
    if (updates.length > 0) {
        const editor = new XmlEditor(doc);
        for (const update of updates) {
            let outcome;
            try {
                outcome = editor.setTextAt(target, update.path, update.value);
            } catch (error) {
                warnings.push(`写入字段 ${update.id} 失败：${describeError(error)}`);
                continue;
            }
            if (outcome !== 'unchanged') {
                changed.push(update.id);
            }
        }
        currentXml = editor.apply();
    }

    for (const creation of creations) {
        let currentDoc: XmlDocument;
        try {
            currentDoc = parseXml(currentXml);
        } catch (error) {
            warnings.push(`创建字段 ${creation.id} 失败：${describeError(error)}`);
            continue;
        }
        const currentTarget = findTarget(currentDoc.root, targetName);
        if (!currentTarget) {
            warnings.push(`创建字段 ${creation.id} 失败：目标 ${targetName} 已不存在`);
            continue;
        }
        const editor = new XmlEditor(currentDoc);
        let outcome;
        try {
            outcome = editor.setTextAt(currentTarget, creation.path, creation.value);
        } catch (error) {
            warnings.push(`创建字段 ${creation.id} 失败：${describeError(error)}`);
            continue;
        }
        if (outcome === 'unchanged') {
            continue;
        }
        currentXml = editor.apply();
        changed.push(creation.id);
    }

    return { xml: currentXml, changed, warnings };
}
