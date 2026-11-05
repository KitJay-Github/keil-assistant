/**
 * Build the view model sent to the "Options for Target" webview panel.
 *
 * Pure function: no `vscode` dependency, no file system writes. The caller
 * (`optionsPanel.ts` / `extension.ts`) reads the project files as UTF-8 text,
 * handles encoding problems and passes the text in. Filesystem-heavy enrichment
 * (driver DLL versions, uVision version) is resolved by the caller and passed as
 * `debuggerInfo`; the `TOOLS.INI` text of the local installation is passed as
 * `keilToolsIniText` so this module can derive the real driver list for
 * `Utilities/Flash1/DriverSelection`.
 */
import * as path from 'path';
import { XmlDocument, parseXml, projectTargets, targetNameOf } from '../uvXml';
import { OPTION_TABS, getOptionField, isFieldDeclaredFor } from './uvOptionSchema';
import { readTargetValuesFromDocument, toolchainLabel } from './uvOptions';
import { findUvoptFileForProject, readUvoptOptions } from './uvoptFile';
import { cpuFamilyOf, driverSelectionOptions, parseToolsIni } from './keilInstall';
import type { KeilCpuFamily } from './keilInstall';
import { debuggerOptions, readDebuggerChoice } from './debuggerSelect';
import { DeviceCatalog, deviceOptions as buildDeviceOptionList } from './deviceDatabase';
import {
    JLINK_CLOCK_OPTIONS,
    JLINK_CONNECT_OPTIONS,
    JLINK_INTERFACE_OPTIONS,
    JLINK_PORT_OPTIONS,
    JLINK_RESET_OPTIONS,
    JlinkSettings,
    readJlinkSettings
} from './jlinkSettings';
import { buildMcuInfoRows, McuInfoRow } from './mcuInfo';
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

/** Enrichment resolved by the extension host (needs file system access). */
export interface DebuggerInfoInput {
    /** Absolute path of the uVision executable used for this project. */
    uvisionPath?: string;
    /** File version of `UV4.exe`, e.g. `5.36.0.0`. */
    uvisionVersion?: string;
    /** Debugger adapter name resolved from the local `TOOLS.INI`. */
    driverName?: string;
    /** Debug driver DLL as stored in the project, e.g. `BIN\CMSIS_AGDI.dll`. */
    driverDll?: string;
    /** Absolute path of the resolved driver DLL. */
    driverDllPath?: string;
    /** File version of the driver DLL. */
    driverVersion?: string;
    /** Where `driverDll` was read from, e.g. `.uvoptx (pMon)` or `.uvprojx (DllOption)`. */
    driverSource?: string;
    /** Flash download algorithm DLL (`Utilities/Flash2`). */
    flashDll?: string;
    /** Absolute path of the resolved flash algorithm DLL. */
    flashDllPath?: string;
    /** File version of the flash algorithm DLL. */
    flashVersion?: string;
    /** Optional warnings raised while resolving the information above. */
    warnings?: string[];
}

/** Input of {@link buildOptionsViewData}. */
export interface BuildOptionsViewDataInput {
    projectLabel: string;
    projectFile: string;
    uvprojxText: string;
    uvoptText?: string;
    activeTarget?: string;
    /** Raw text of the Keil installation `TOOLS.INI`; enables the real driver list. */
    keilToolsIniText?: string;
    /** Debugger / flash driver information resolved by the host. */
    debuggerInfo?: DebuggerInfoInput;
    /** Device catalog scanned from the local CMSIS-Packs (host provided). */
    deviceCatalog?: DeviceCatalog;
    /** True while the host is scanning the packs in the background. */
    deviceCatalogScanning?: boolean;
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
    /** Real `DriverSelection` list of the local installation (replaces the fallback). */
    driverOptions?: OptionEnumValue[];
    /** Rows of the generated read-only "MCU 信息" section. */
    mcuRows?: McuInfoRow[];
    /** Host resolved debugger information; `undefined` when not available. */
    debuggerInfo?: DebuggerInfoInput;
    /** Device picker options (CMSIS-Pack catalog). */
    deviceOptions?: OptionEnumValue[];
    deviceOptionsHint?: string;
    /** Debugger adapter picker (`.uvopt` DebugOpt). */
    debuggerChoices?: OptionEnumValue[];
    debuggerValue?: string;
    debuggerHint?: string;
    /** J-Link adapter settings read from the target driver registry. */
    jlink?: JlinkSettings;
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

/** Read-only information row rendered as plain text by the webview. */
function infoFieldView(id: string, label: string, value: string, hint?: string): OptionFieldView {
    const view: OptionFieldView = {
        id,
        label,
        type: 'info',
        value: value === '' || value === undefined ? '—' : value,
        readonly: true
    };
    if (hint) {
        view.hint = hint;
    }
    return view;
}

/** Resolve the label of the currently stored `DriverSelection` value. */
function describeDriverSelection(value: string | undefined, options: OptionEnumValue[]): string {
    if (value === undefined || value === '') {
        return '—';
    }
    const match = options.find((option) => option.value === value);
    if (match) {
        return match.label;
    }
    return `${value}（未在本机驱动列表中，Keil 可能来自其他版本的安装）`;
}

function buildMcuSection(rows: McuInfoRow[]): OptionSectionView {
    return {
        id: 'target.mcu',
        title: 'MCU 信息（只读）',
        description: '根据工程中的器件与 Cpu 描述自动解析，仅供参考；修改请使用 uVision 的 Device 选择。',
        fields: rows.map((row) => infoFieldView(row.id, row.label, row.value))
    };
}

/** Device picker backed by the local CMSIS-Pack catalog. */
function buildDeviceSection(context: BuildTabsContext): OptionSectionView {
    const field: OptionFieldView = {
        id: 'target.deviceSelect',
        label: '芯片型号（Device）',
        type: 'enum',
        value: context.uvprojxValues['target.device'] || ''
    };
    if (context.deviceOptions && context.deviceOptions.length > 0) {
        field.options = context.deviceOptions;
    }
    if (context.deviceOptionsHint) {
        field.hint = context.deviceOptionsHint;
    }
    return {
        id: 'target.devicePicker',
        title: '器件型号选择',
        description:
            '列表来自本机 CMSIS-Pack。保存后会同步更新 Device、Vendor、PackID、Cpu（内存与内核）' +
            '以及可以解析到的 SVD/寄存器头文件；启动文件与 Flash 下载算法请在 uVision 中确认。',
        fields: [field]
    };
}

/** Debugger adapter picker backed by the local TOOLS.INI driver list. */
function buildDebuggerPickerSection(context: BuildTabsContext): OptionSectionView {
    const field: OptionFieldView = {
        id: 'debug.debugger',
        label: '调试器类型（Use）',
        type: 'enum',
        value: context.debuggerValue || 'unknown'
    };
    if (context.debuggerChoices && context.debuggerChoices.length > 0) {
        field.options = context.debuggerChoices;
    }
    if (context.debuggerHint) {
        field.hint = context.debuggerHint;
    }
    return {
        id: 'debug.debuggerPicker',
        title: '调试器选择',
        description:
            '写入 .uvoptx 的 DebugOpt（uSim / uTrg / nTsel / pMon）；列表顺序来自本机 TOOLS.INI 的驱动列表。',
        fields: [field]
    };
}

function optionViews<T extends { value: string; label: string }>(options: T[]): OptionEnumValue[] {
    return options.map((option) => ({ value: option.value, label: option.label }));
}

/** J-Link / J-Trace adapter settings stored in the target driver registry. */
function buildJlinkSection(settings: JlinkSettings): OptionSectionView {
    const fields: OptionFieldView[] = [
        {
            id: 'jlink.port',
            label: '调试接口（Port）',
            hint: 'JTAG / SW',
            type: 'enum',
            value: settings.port || 'sw',
            options: optionViews(JLINK_PORT_OPTIONS)
        },
        {
            id: 'jlink.maxClock',
            label: '最大时钟（Max Clock）',
            hint: '调试连接速度',
            type: 'enum',
            value: settings.maxClockKhz !== undefined ? String(settings.maxClockKhz) : '',
            options: JLINK_CLOCK_OPTIONS.map((option) => ({ value: String(option.khz), label: option.label }))
        },
        {
            id: 'jlink.connect',
            label: '连接方式（Connect）',
            hint: '连接目标时的行为',
            type: 'enum',
            value: settings.connect || 'normal',
            options: optionViews(JLINK_CONNECT_OPTIONS)
        },
        {
            id: 'jlink.reset',
            label: '复位方式（Reset）',
            hint: '目标复位策略',
            type: 'enum',
            value: settings.reset || 'normal',
            options: optionViews(JLINK_RESET_OPTIONS)
        },
        {
            id: 'jlink.resetAfter',
            label: '连接后复位（Reset after Connect）',
            hint: '连接完成后执行复位',
            type: 'bool',
            value: settings.resetAfter === false ? '0' : '1'
        },
        {
            id: 'jlink.interface',
            label: '接口（Interface）',
            hint: 'USB / TCP/IP',
            type: 'enum',
            value: settings.interface || 'usb',
            options: JLINK_INTERFACE_OPTIONS
        },
        {
            id: 'jlink.ip',
            label: 'TCP/IP 地址',
            hint: '仅 TCP/IP 接口使用',
            type: 'string',
            value: settings.ip || '127.0.0.1',
            placeholder: '127.0.0.1'
        },
        {
            id: 'jlink.tcpPort',
            label: 'TCP/IP 端口',
            hint: '0 表示默认端口',
            type: 'number',
            value: settings.tcpPort !== undefined ? String(settings.tcpPort) : '0'
        }
    ];
    return {
        id: 'debug.jlink',
        title: '调试器适配器设置（J-Link / J-Trace）',
        description:
            '写入 .uvoptx 的 TargetDriverDllRegistry（JL2CM3）参数串；' +
            '连接/复位方式按 uVision 驱动参数编码，保存后建议在 uVision 的 Debug→Settings 中核对。',
        fields
    };
}

function buildDebuggerSection(info: DebuggerInfoInput | undefined): OptionSectionView | undefined {
    if (!info) {
        return undefined;
    }
    const fields: OptionFieldView[] = [];
    const driverName = info.driverName || '';
    const driverDll = info.driverDll || '';
    const driverVersion = info.driverVersion || '';
    const uvisionVersion = info.uvisionVersion || '';
    const flashDll = info.flashDll || '';
    const flashVersion = info.flashVersion || '';

    if (driverName || driverDll) {
        fields.push(infoFieldView('info.debugger.name', '调试器', driverName || driverDll));
    }
    if (driverDll) {
        fields.push(infoFieldView('info.debugger.dll', '调试器 DLL', driverDll, info.driverSource ? `来源：${info.driverSource}` : undefined));
    }
    if (driverVersion) {
        fields.push(infoFieldView('info.debugger.version', '调试器版本', driverVersion, '取自驱动 DLL 的文件版本'));
    }
    if (flashDll) {
        fields.push(infoFieldView('info.debugger.flashDll', 'Flash 下载算法', flashDll));
    }
    if (flashVersion) {
        fields.push(infoFieldView('info.debugger.flashVersion', '下载算法版本', flashVersion));
    }
    if (uvisionVersion) {
        fields.push(infoFieldView('info.debugger.uvision', 'uVision 版本', uvisionVersion, info.uvisionPath));
    }
    if (fields.length === 0) {
        fields.push(
            infoFieldView(
                'info.debugger.none',
                '调试器信息',
                '—',
                '未找到可解析的调试器配置；请确认 Keil 安装路径与工程的 .uvoptx 文件'
            )
        );
    }
    return {
        id: 'debug.hardware',
        title: '调试器 / 下载信息（只读）',
        description: '来自工程的 .uvoptx 与本机 Keil 安装，仅供参考；实际下载参数请以 uVision 的 Options→Debug/Utilities 为准。',
        fields
    };
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

    // The DriverSelection value space depends on the local uVision installation,
    // so the panel lists the drivers found in its TOOLS.INI instead of a guess list.
    if (optionField.id === 'utilities.driverSelection' && context.driverOptions && context.driverOptions.length > 0) {
        view.options = context.driverOptions.map((entry) => ({ value: entry.value, label: entry.label }));
        view.hint = '来自本机 Keil 的驱动列表';
    }
    return view;
}

function buildTabs(context: BuildTabsContext): OptionTabView[] {
    const tabs = OPTION_TABS.map((tab) => {
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

    if (context.toolchain) {
        const targetTab = tabs.find((tab) => tab.id === 'target');
        if (targetTab && context.deviceOptions && context.deviceOptions.length > 0) {
            targetTab.sections.unshift(buildDeviceSection(context));
        }
        if (context.mcuRows && context.mcuRows.length > 0) {
            if (targetTab) {
                targetTab.sections.unshift(buildMcuSection(context.mcuRows));
            }
        }

        if (context.debuggerChoices && context.debuggerChoices.length > 0) {
            const debugTab = tabs.find((tab) => tab.id === 'debug');
            if (debugTab) {
                debugTab.sections.unshift(buildDebuggerPickerSection(context));
            }
        }

        if (context.jlink) {
            const debugTab = tabs.find((tab) => tab.id === 'debug');
            if (debugTab) {
                debugTab.sections.push(buildJlinkSection(context.jlink));
            }
        }

        // Show what the raw DriverSelection number actually means in the local install.
        if (context.driverOptions && context.driverOptions.length > 0) {
            const utilitiesTab = tabs.find((tab) => tab.id === 'utilities');
            const flashSection = utilitiesTab?.sections.find((section) => section.id === 'utilities.flash');
            if (flashSection) {
                const stored = context.uvprojxValues['utilities.driverSelection'];
                const info = infoFieldView(
                    'info.utilities.driverSelection',
                    '当前驱动编号含义',
                    describeDriverSelection(stored, context.driverOptions),
                    '编号 = 4096 + 本机驱动列表序号'
                );
                const index = flashSection.fields.findIndex((field) => field.id === 'utilities.driverSelection');
                flashSection.fields.splice(index === -1 ? flashSection.fields.length : index + 1, 0, info);
            }
        }
    }

    const debuggerSection = buildDebuggerSection(context.debuggerInfo);
    if (debuggerSection) {
        const debugTab = tabs.find((tab) => tab.id === 'debug');
        if (debugTab) {
            debugTab.sections.push(debuggerSection);
        }
    }

    return tabs;
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
function buildWarnings(context: BuildTabsContext, unavailableCount: number, extra: string[] = []): string[] {
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
    for (const warning of extra) {
        if (warning && !warnings.includes(warning)) {
            warnings.push(warning);
        }
    }
    return warnings;
}

function collectInputWarnings(input: BuildOptionsViewDataInput, hasToolsIni: boolean): string[] {
    const warnings: string[] = [];
    if (!hasToolsIni) {
        warnings.push('未读取到本机 Keil 安装的 TOOLS.INI，驱动列表使用通用默认值');
    }
    for (const warning of input.debuggerInfo?.warnings || []) {
        if (warning) {
            warnings.push(warning);
        }
    }
    return warnings;
}

/**
 * Build the complete panel payload.
 *
 * Behaviour:
 * - fields unavailable for the active toolchain are marked `unavailable`,
 * - when `uvoptText` is missing every `file === 'uvopt'` field is unavailable
 *   with {@link UVOPT_MISSING_REASON},
 * - an unparsable project file makes the whole panel read-only,
 * - an unknown `activeTarget` falls back to the first target,
 * - the `target` tab gets a read-only MCU info section and the `debug` tab a
 *   read-only debugger/flash-driver section,
 * - `utilities.driverSelection` lists the drivers of the local installation and
 *   an info row explains the stored number,
 * - `warnings` summarizes the unavailable reasons plus enrichment warnings.
 */
export function buildOptionsViewData(input: BuildOptionsViewDataInput): OptionsViewData {
    const uvoptFile = resolveUvoptFile(input);
    const uvoptFileFields = uvoptFile !== undefined ? { uvoptFile } : {};
    const tools = input.keilToolsIniText !== undefined ? parseToolsIni(input.keilToolsIniText) : undefined;

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
            warnings: [
                '工程文件中未找到任何目标（Target）',
                ...buildWarnings(context, countUnavailable(tabs), collectInputWarnings(input, tools !== undefined))
            ],
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

    let driverOptions: OptionEnumValue[] | undefined;
    let mcuRows: McuInfoRow[] | undefined;
    let deviceChoices: OptionEnumValue[] | undefined;
    let deviceChoicesHint: string | undefined;
    let debuggerChoices: OptionEnumValue[] | undefined;
    let debuggerValue: string | undefined;
    let debuggerHint: string | undefined;
    let jlinkSettings: JlinkSettings | undefined;
    if (toolchain) {
        const family: KeilCpuFamily = cpuFamilyOf(uvprojxValues['target.cpu'], toolchain);
        driverOptions = driverSelectionOptions(tools, family);
        try {
            mcuRows = buildMcuInfoRows(uvprojxValues, toolchain);
        } catch {
            mcuRows = [];
        }

        // Device picker: list comes from the local CMSIS-Pack catalog.
        deviceChoices = buildDeviceOptionList(input.deviceCatalog, uvprojxValues['target.device']);
        if (input.deviceCatalog) {
            deviceChoicesHint = `${input.deviceCatalog.devices.length} 个器件 / ${input.deviceCatalog.packs.length} 个 Pack`;
        } else {
            deviceChoicesHint = input.deviceCatalogScanning
                ? '正在扫描本机 CMSIS-Pack…'
                : '未找到本机 CMSIS-Pack，仅显示当前器件';
        }

        // Debugger picker: list comes from the local TOOLS.INI and is stored in .uvopt.
        if ((toolchain === 'ARM' || toolchain === 'ARM6') && uvoptState === 'available' && input.uvoptText !== undefined) {
            debuggerChoices = debuggerOptions(tools, family);
            const choice = readDebuggerChoice(input.uvoptText, activeTarget, tools, family);
            debuggerValue = choice.value;
            if (choice.mode === 'simulator') {
                debuggerHint = '使用仿真器（uSim=1）';
            } else if (choice.name) {
                debuggerHint = choice.dll ? `${choice.name}（${choice.dll}）` : choice.name;
            }
            if (uvoptState === 'available' && input.uvoptText !== undefined) {
                try {
                    jlinkSettings = readJlinkSettings(input.uvoptText, activeTarget);
                } catch {
                    jlinkSettings = undefined;
                }
            }
        }
    }

    const context: BuildTabsContext = {
        ...(toolchain !== undefined ? { toolchain } : {}),
        uvprojxValues,
        uvoptValues,
        uvoptState,
        ...(uvoptReason !== undefined ? { uvoptReason } : {}),
        ...(driverOptions !== undefined ? { driverOptions } : {}),
        ...(mcuRows !== undefined ? { mcuRows } : {}),
        ...(input.debuggerInfo !== undefined ? { debuggerInfo: input.debuggerInfo } : {}),
        ...(deviceChoices !== undefined ? { deviceOptions: deviceChoices } : {}),
        ...(deviceChoicesHint !== undefined ? { deviceOptionsHint: deviceChoicesHint } : {}),
        ...(debuggerChoices !== undefined ? { debuggerChoices } : {}),
        ...(debuggerValue !== undefined ? { debuggerValue } : {}),
        ...(debuggerHint !== undefined ? { debuggerHint } : {}),
        ...(jlinkSettings !== undefined ? { jlink: jlinkSettings } : {})
    };
    const tabs = buildTabs(context);
    const extraWarnings: string[] = [];
    if (toolchain && !input.deviceCatalog) {
        extraWarnings.push(
            input.deviceCatalogScanning
                ? '正在扫描本机 CMSIS-Pack 设备列表，完成后面板会自动刷新'
                : '未找到本机 CMSIS-Pack，器件列表仅包含当前器件'
        );
    }
    return {
        projectLabel: input.projectLabel,
        projectFile: input.projectFile,
        ...uvoptFileFields,
        targets,
        activeTarget,
        toolchain: toolchain ? toolchainLabel(toolchain) : '未知',
        tabs,
        warnings: buildWarnings(
            context,
            countUnavailable(tabs),
            collectInputWarnings(input, tools !== undefined).concat(extraWarnings)
        ),
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
