/**
 * Read/write of `.uvoptx` / `.uvopt` (uVision "options" file) values.
 *
 * The debugger selection, the Xtal frequency (CLKADS), the listing layout
 * (OPTLEX) and the run/debug flags (OPTTT, DebugOpt) live in the companion
 * options file rather than in `.uvprojx`. That file is optional: when it is
 * missing the panel marks the corresponding fields unavailable (see
 * `viewData.ts`) instead of inventing values.
 *
 * Robustness contract (see design document 3.3): a missing target or a missing
 * element never throws. Reads report `undefined`; writes return the input text
 * unchanged and add a warning. Unparsable XML is treated the same way.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
    XmlDocument,
    XmlEditor,
    XmlElement,
    childElements,
    findPath,
    firstChild,
    parseXml,
    trimmedTextOf
} from '../uvXml';
import { OPTION_FIELDS, OPTION_FIELDS_BY_ID } from './uvOptionSchema';
import { normalizeOptionValue } from './uvOptions';
import { OptionApplyResult, OptionFieldDef } from './types';

/** Root element of `.uvoptx` / `.uvopt` documents. */
export const UVOPT_ROOT_ELEMENT = 'ProjectOpt';

const UVOPT_FIELDS: readonly OptionFieldDef[] = OPTION_FIELDS.filter((optionField) => optionField.file === 'uvopt');

/** `true` for `.uvopt` / `.uvoptx` paths (case-insensitive). */
export function isUvoptFileName(filePath: string): boolean {
    const extension = path.extname(String(filePath)).toLowerCase();
    return extension === '.uvoptx' || extension === '.uvopt';
}

/**
 * Resolve the companion options file of a project file: same directory, same
 * base name. `.uvoptx` wins over `.uvopt` when both exist.
 */
export function findUvoptFileForProject(projectFile: string): string | undefined {
    const parsed = path.parse(String(projectFile));
    const candidates = [
        path.join(parsed.dir, `${parsed.name}.uvoptx`),
        path.join(parsed.dir, `${parsed.name}.uvopt`)
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Path of a `.uvopt` field. All `.uvopt` fields currently declare the same path
 * for every toolchain, so the first declared path is used.
 */
function uvoptPathOf(optionField: OptionFieldDef): string[] | undefined {
    return (
        optionField.path.ARM ||
        optionField.path.ARM6 ||
        optionField.path.C51 ||
        optionField.path.C251
    );
}

function targetNameOfElement(target: XmlElement): string {
    const nameElement = firstChild(target, 'TargetName');
    return nameElement ? trimmedTextOf(nameElement) : '';
}

function findUvoptTarget(doc: XmlDocument, targetName: string): XmlElement | undefined {
    if (doc.root.name !== UVOPT_ROOT_ELEMENT) {
        return undefined;
    }
    return childElements(doc.root, 'Target').find((target) => targetNameOfElement(target) === targetName);
}

function emptyUvoptValues(): Record<string, string | undefined> {
    const values: Record<string, string | undefined> = {};
    for (const optionField of UVOPT_FIELDS) {
        values[optionField.id] = undefined;
    }
    return values;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Read every `.uvopt` field of one target. Missing values are `undefined`;
 * missing target, missing element and unparsable XML never throw.
 */
export function readUvoptOptions(xml: string, targetName: string): Record<string, string | undefined> {
    let doc: XmlDocument;
    try {
        doc = parseXml(xml);
    } catch {
        return emptyUvoptValues();
    }
    const values = emptyUvoptValues();
    const target = findUvoptTarget(doc, targetName);
    if (!target) {
        return values;
    }
    for (const optionField of UVOPT_FIELDS) {
        const optionPath = uvoptPathOf(optionField);
        if (!optionPath) {
            continue;
        }
        const element = findPath(target, optionPath);
        values[optionField.id] = element ? trimmedTextOf(element) : undefined;
    }
    return values;
}

/**
 * Apply option edits to a `.uvoptx` / `.uvopt` string.
 *
 * Only existing elements are updated: a missing target or a missing element
 * leaves the text untouched and produces a warning (the file belongs to
 * uVision, so we never invent debugger blocks that uVision did not write).
 */
export function applyUvoptOptions(
    xml: string,
    targetName: string,
    values: Record<string, string>
): OptionApplyResult {
    const warnings: string[] = [];
    let doc: XmlDocument;
    try {
        doc = parseXml(xml);
    } catch (error) {
        return {
            xml,
            changed: [],
            warnings: [`无法解析 .uvopt/.uvoptx 文件：${describeError(error)}`]
        };
    }
    if (doc.root.name !== UVOPT_ROOT_ELEMENT) {
        return {
            xml,
            changed: [],
            warnings: [`不是有效的 .uvopt/.uvoptx 文件：根元素为 <${doc.root.name}>，应为 <${UVOPT_ROOT_ELEMENT}>`]
        };
    }
    const target = findUvoptTarget(doc, targetName);
    if (!target) {
        return {
            xml,
            changed: [],
            warnings: [`.uvopt/.uvoptx 文件中未找到目标「${targetName}」，已跳过相关字段`]
        };
    }

    const editor = new XmlEditor(doc);
    const changed: string[] = [];
    for (const id of Object.keys(values)) {
        const optionField = OPTION_FIELDS_BY_ID.get(id);
        if (!optionField || optionField.file !== 'uvopt') {
            // Unknown ids and `.uvprojx` ids are not ours to write.
            continue;
        }
        if (optionField.readonly) {
            continue;
        }
        const optionPath = uvoptPathOf(optionField);
        if (!optionPath) {
            continue;
        }
        const existing = findPath(target, optionPath);
        if (!existing) {
            warnings.push(
                `字段 ${optionField.label}（${id}）在 .uvopt/.uvoptx 中不存在，已保持原样`
            );
            continue;
        }
        const normalized = normalizeOptionValue(optionField, values[id], warnings);
        if (normalized === undefined) {
            continue;
        }
        if (trimmedTextOf(existing) === normalized) {
            continue;
        }
        let outcome;
        try {
            outcome = editor.setTextAt(target, optionPath, normalized);
        } catch (error) {
            warnings.push(`写入字段 ${optionField.label}（${id}）失败：${describeError(error)}`);
            continue;
        }
        if (outcome !== 'unchanged') {
            changed.push(id);
        }
    }

    return { xml: editor.apply(), changed, warnings };
}
