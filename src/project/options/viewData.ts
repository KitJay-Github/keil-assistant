/**
 * Build the view model sent to the "Options for Target" webview panel.
 *
 * Pure function: no `vscode` dependency, no file system writes. The caller
 * (`optionsPanel.ts` / `extension.ts`) reads the project files as UTF-8 text,
 * handles encoding problems and passes the text in.
 */
import * as path from 'path';
import { XmlDocument, parseXml, projectTargets, targetNameOf } from '../uvXml';
import { OPTION_TABS, getOptionField, isFieldDeclaredFor } from './uvOptionSchema';
import { readTargetValuesFromDocument, toolchainLabel } from './uvOptions';
import { findUvoptFileForProject, readUvoptOptions } from './uvoptFile';
import {
    OptionApplyResult,
    OptionEnumValue,
    OptionFieldDef,
    OptionFieldView,
    OptionSectionView,
    OptionTabView,
    OptionsViewData,
    UvToolchainKind
} from './types';

/**
 * Reason shown when the project has no companion options file. The panel and
 * the user documentation reuse this exact text.
 */
export const UVOPT_MISSING_REASON = '工程缺少 .uvoptx/.uvopt 文件，请先在 uVision 中打开并保存工程';

/** Input of {@link buildOptionsViewData}; mirrors the design document 3.4. */
export interface BuildOptionsViewDataInput {
    projectLabel: string;
    projectFile: string;
    uvprojxText: string;
    uvoptText?: string;
    activeTarget?: string;
}

/** Same shape as `OptionApplyResult` but without the XML payload. */
export type OptionApplySummary = Pick<OptionApplyResult, 'changed' | 'warnings'>;

type UvoptState = 'available' | 'missing' | 'unparsable' | 'unknown';

interface BuildTabsContext {
    toolchain?: UvToolchainKind;
    uvprojxValues: Record<string, string | undefined>;
    uvoptValues: Record<string, string | undefined>;
    uvoptState: UvoptState;
    uvoptReason?: string;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function pickActiveTarget(targets: string[], requested: string | undefined): string {
    if (requested && targets.includes(requested)) {
        return requested;
    }
    return targets.length > 0 ? targets[0] : '';
}

/**
 * Best effort companion `.uvopt(x)` path used only for display. Prefers the file
 * that actually exists; falls back to the conventional extension for the
 * current project file extension.
 */
function guessUvoptFile(projectFile: string): string {
    const parsed = path.parse(String(projectFile));
    const extension = parsed.ext.toLowerCase() === '.uvprojx' ? '.uvoptx' : '.uvopt';
    return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function resolveUvoptFile(input: BuildOptionsViewDataInput): string | undefined {
    if (input.uvoptText === undefined) {
        return undefined;
    }
    return findUvoptFileForProject(input.projectFile) || guessUvoptFile(input.projectFile);
}

function buildFieldView(optionField: OptionFieldDef, context: BuildTabsContext): OptionFieldView {
    const view: OptionFieldView = {
        id: optionField.id,
        label: optionField.label,
        type: optionField.type,
        value: ''
    };
    if (optionField.hint) {
        view.hint = optionField.hint;
    }
    if (optionField.placeholder !== undefined) {
        view.placeholder = optionField.placeholder;
    }
    if (optionField.enumValues) {
        view.options = optionField.enumValues.map(
            (entry: OptionEnumValue): OptionEnumValue => ({ value: entry.value, label: entry.label })
        );
    }
    if (optionField.readonly) {
        view.readonly = true;
    }

    const toolchain = context.toolchain;
    if (!toolchain) {
        view.unavailable = true;
        view.unavailableReason = '无法识别当前目标的工具链，暂不可用';
        return view;
    }
    if (!isFieldDeclaredFor(optionField, toolchain)) {
        view.unavailable = true;
        view.unavailableReason = `当前工具链（${toolchainLabel(toolchain)}）不支持该选项`;
        return view;
    }

    if (optionField.file === 'uvopt') {
        if (context.uvoptState === 'missing') {
            view.unavailable = true;
            view.unavailableReason = UVOPT_MISSING_REASON;
            return view;
        }
        if (context.uvoptState === 'unparsable') {
            view.unavailable = true;
            view.unavailableReason = context.uvoptReason || '无法解析 .uvopt/.uvoptx 文件';
            return view;
        }
        const value = context.uvoptValues[optionField.id];
        view.value = value === undefined ? '' : value;
        return view;
    }

    const value = context.uvprojxValues[optionField.id];
    view.value = value === undefined ? '' : value;
    return view;
}

function buildTabs(context: BuildTabsContext): OptionTabView[] {
    return OPTION_TABS.map((tab) => {
        const sections: OptionSectionView[] = tab.sections.map((section) => {
            const sectionView: OptionSectionView = {
                id: section.id,
                title: section.title,
                fields: section.fields.map((optionField) => buildFieldView(optionField, context))
            };
            if (section.description !== undefined) {
                sectionView.description = section.description;
            }
            return sectionView;
        });
        return { id: tab.id, title: tab.title, sections } as OptionTabView;
    });
}

function countUnavailable(tabs: OptionTabView[]): number {
    let count = 0;
    for (const tab of tabs) {
        for (const section of tab.sections) {
            for (const optionField of section.fields) {
                if (optionField.unavailable) {
                    count++;
                }
            }
        }
    }
    return count;
}

/** Human readable summaries of why fields are unavailable (deduplicated). */
function buildWarnings(context: BuildTabsContext, unavailableCount: number): string[] {
    const warnings: string[] = [];
    if (!context.toolchain) {
        warnings.push('无法识别当前目标的工具链，所有选项均标记为不可用');
    } else if (unavailableCount > 0) {
        warnings.push(
            `${unavailableCount} 个字段在当前工具链（${toolchainLabel(context.toolchain)}）下不可用`
        );
    }
    if (context.uvoptState === 'missing') {
        warnings.push(UVOPT_MISSING_REASON);
    } else if (context.uvoptState === 'unparsable') {
        warnings.push(context.uvoptReason || '无法解析 .uvopt/.uvoptx 文件');
    }
    return warnings;
}

/**
 * Build the complete panel payload.
 *
 * Behaviour (design document 3.4):
 * - fields unavailable for the active toolchain are marked `unavailable`,
 * - when `uvoptText` is missing every `file === 'uvopt'` field is unavailable
 *   with {@link UVOPT_MISSING_REASON},
 * - an unparsable project file makes the whole panel read-only,
 * - an unknown `activeTarget` falls back to the first target,
 * - `warnings` summarizes the unavailable reasons.
 */
export function buildOptionsViewData(input: BuildOptionsViewDataInput): OptionsViewData {
    const uvoptFile = resolveUvoptFile(input);
    const uvoptFileFields = uvoptFile !== undefined ? { uvoptFile } : {};

    let doc: XmlDocument;
    try {
        doc = parseXml(input.uvprojxText);
    } catch (error) {
        const reason = `工程文件解析失败，面板已切换为只读：${describeError(error)}`;
        return {
            projectLabel: input.projectLabel,
            projectFile: input.projectFile,
            ...uvoptFileFields,
            targets: [],
            activeTarget: '',
            toolchain: '未知',
            tabs: [],
            warnings: [reason],
            readonly: true,
            readonlyReason: reason
        };
    }

    const targets = projectTargets(doc.root)
        .map((target) => targetNameOf(target))
        .filter((name) => name.length > 0);
    const activeTarget = pickActiveTarget(targets, input.activeTarget);
    if (targets.length === 0) {
        const context: BuildTabsContext = {
            uvprojxValues: {},
            uvoptValues: {},
            uvoptState: 'unknown'
        };
        const tabs = buildTabs(context);
        return {
            projectLabel: input.projectLabel,
            projectFile: input.projectFile,
            ...uvoptFileFields,
            targets,
            activeTarget,
            toolchain: '未知',
            tabs,
            warnings: ['工程文件中未找到任何目标（Target）', ...buildWarnings(context, countUnavailable(tabs))],
            readonly: false
        };
    }

    let toolchain: UvToolchainKind | undefined;
    let uvprojxValues: Record<string, string | undefined> = {};
    try {
        const readResult = readTargetValuesFromDocument(doc, activeTarget);
        toolchain = readResult.toolchain;
        uvprojxValues = readResult.values;
    } catch {
        // Unknown toolchain family (e.g. an old TargetArm/Target166 project):
        // keep the panel usable but mark every field unavailable below.
        toolchain = undefined;
        uvprojxValues = {};
    }

    let uvoptState: UvoptState = toolchain ? 'available' : 'unknown';
    let uvoptValues: Record<string, string | undefined> = {};
    let uvoptReason: string | undefined;
    if (input.uvoptText === undefined) {
        if (toolchain) {
            uvoptState = 'missing';
        }
    } else {
        try {
            parseXml(input.uvoptText);
            if (toolchain) {
                uvoptValues = readUvoptOptions(input.uvoptText, activeTarget);
                uvoptState = 'available';
            }
        } catch (error) {
            uvoptState = 'unparsable';
            uvoptReason = `无法解析 .uvopt/.uvoptx 文件：${describeError(error)}`;
        }
    }

    const context: BuildTabsContext = {
        ...(toolchain !== undefined ? { toolchain } : {}),
        uvprojxValues,
        uvoptValues,
        uvoptState,
        ...(uvoptReason !== undefined ? { uvoptReason } : {})
    };
    const tabs = buildTabs(context);
    return {
        projectLabel: input.projectLabel,
        projectFile: input.projectFile,
        ...uvoptFileFields,
        targets,
        activeTarget,
        toolchain: toolchain ? toolchainLabel(toolchain) : '未知',
        tabs,
        warnings: buildWarnings(context, countUnavailable(tabs)),
        readonly: false
    };
}

/**
 * Split rendered field ids by the file that owns their value. The panel sends
 * both lists to the host so `.uvopt` ids go through `applyUvoptOptions` and
 * everything else through `applyTargetOptions`.
 */
export function splitValuesByFile(fields: OptionFieldView[]): { uvprojx: string[]; uvopt: string[] } {
    const result: { uvprojx: string[]; uvopt: string[] } = { uvprojx: [], uvopt: [] };
    for (const view of fields) {
        const optionField = getOptionField(view.id);
        if (optionField && optionField.file === 'uvopt') {
            result.uvopt.push(view.id);
        } else {
            result.uvprojx.push(view.id);
        }
    }
    return result;
}
