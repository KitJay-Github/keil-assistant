/**
 * Debugger adapter selection for the uVision "Debug" page (`Use:` combo box).
 *
 * uVision stores the selection in the companion `.uvoptx` / `.uvopt` file:
 * - `DebugOpt/uSim` = `1` selects the built-in simulator,
 * - `DebugOpt/uTrg` = `1` selects a target debugger,
 * - `DebugOpt/nTsel` is the **0-based index** of the selected adapter inside the
 *   `CPUDLLn(...)` driver list of the device CPU group in the local `TOOLS.INI`,
 * - `DebugOpt/pMon` repeats the monitor DLL of that adapter
 *   (e.g. `Segger\JL2CM3.dll`), `tDll` / `tDlgDll` are usually empty.
 *
 * The index is installation specific: it is a position inside
 * `CPUDLL1=SARMCM3.DLL(TDRV0,...,TDRV11)` (Cortex-M) of the *local* TOOLS.INI,
 * not a stable global enum. Therefore the adapter list is derived from the local
 * installation (see `keilInstall.ts`); when no TOOLS.INI is available a built-in
 * MDK 5 default list is used so the panel can still be rendered.
 *
 * All writes go through the offset preserving editor in `../uvXml.ts`: only the
 * four `DebugOpt` fields above are touched, the rest of the file is preserved
 * byte for byte. A `.uvoptx` root element is `<ProjectOpt>` and its `<Target>`
 * elements are direct children (unlike `.uvprojx`, where they live below
 * `<Targets>`), so targets are located with `childElements` + `targetNameOf`
 * instead of `findTarget`.
 */
import * as path from 'path';
import {
    XmlDocument,
    XmlEditor,
    XmlElement,
    childElements,
    findPath,
    firstChild,
    parseXml,
    targetNameOf,
    trimmedTextOf
} from '../uvXml';
import { KeilCpuFamily, KeilDriverDefinition, KeilToolchainSection, KeilToolsIni } from './keilInstall';
import { OptionEnumValue } from './types';

/** Panel value that selects the uVision simulator (uSim=1 / uTrg=0). */
export const SIMULATOR_VALUE = 'sim';

/** Panel field id reported in `DebuggerApplyResult.changed`. */
export const DEBUGGER_FIELD_ID = 'debug.debugger';

/** Root element of `.uvoptx` / `.uvopt` documents. */
const UVOPT_ROOT_ELEMENT = 'ProjectOpt';

/** Path of the debugger block below one `<Target>` element. */
const DEBUG_OPT_PATH = ['TargetOption', 'DebugOpt'];

/** Value of an unidentifiable selection (`DebuggerChoice.value`). */
const UNKNOWN_VALUE = 'unknown';

/** One debugger of the uVision Debug page dropdown. */
export interface DebuggerDescriptor {
    /** 0 基序号（对应 DebugOpt/nTsel）。 */
    index: number;
    /** 调试器显示名，如 "J-LINK / J-TRACE Cortex"。 */
    name: string;
    /** 驱动 DLL，如 "Segger\\JL2CM3.dll"（写入 DebugOpt/pMon）。 */
    dll: string;
}

/** Panel value of the current debugger selection. */
export interface DebuggerChoice {
    /** 面板使用的值：'sim' 或序号字符串；无法识别时为 'unknown'。 */
    value: string;
    mode: 'simulator' | 'target' | 'unknown';
    index?: number;
    name?: string;
    dll?: string;
}

/** Result of writing the debugger selection back into a `.uvopt` document. */
export interface DebuggerApplyResult {
    xml: string;
    changed: string[];
    warnings: string[];
}

/** Default adapter list of one CPU family, used when no local TOOLS.INI exists. */
interface DefaultDebugger {
    name: string;
    dll: string;
}

/**
 * Fallback adapters (order = default MDK 5 `CPUDLLn` order). The DLLs are the
 * ones a stock MDK 5 `TOOLS.INI` declares; they are only used when the local
 * installation cannot be read. `c51` / `c251` are left empty because their
 * adapter lists differ too much between installations.
 */
const DEFAULT_DEBUGGERS: Record<KeilCpuFamily, DefaultDebugger[]> = {
    'cortex-m': [
        { name: 'ULINK2/ME Cortex Debugger', dll: 'BIN\\UL2CM3.DLL' },
        { name: 'ULINK Pro Cortex Debugger', dll: 'BIN\\ULP2CM3.DLL' },
        { name: 'ULINKplus Debugger', dll: 'BIN\\ULPL2CM3.dll' },
        { name: 'CMSIS-DAP Debugger', dll: 'BIN\\CMSIS_AGDI.dll' },
        { name: 'J-LINK / J-TRACE Cortex', dll: 'Segger\\JL2CM3.dll' },
        { name: 'Models Cortex-M Debugger', dll: 'BIN\\DbgFM.DLL' },
        { name: 'ST-Link Debugger', dll: 'STLink\\ST-LINKIII-KEIL_SWO.dll' },
        { name: 'NULink Debugger', dll: 'NULink\\Nu_Link.dll' },
        { name: 'Pemicro Debugger', dll: 'PEMicro\\Pemicro_ArmCortexInterface.dll' },
        { name: 'SiLabs UDA Debugger', dll: 'SiLabs\\SLAB_CM_Keil.dll' },
        { name: 'Altera Blaster Cortex Debugger', dll: 'BIN\\ABLSTCM.dll' },
        { name: 'TI XDS Debugger', dll: 'TI_XDS\\XDS2CM3.dll' }
    ],
    'armv8-m': [
        { name: 'ULINKplus Debugger', dll: 'BIN\\ULPL2CM3.dll' },
        { name: 'J-LINK / J-TRACE Cortex', dll: 'Segger\\JL2CM3.dll' },
        { name: 'ST-Link Debugger', dll: 'STLink\\ST-LINKIII-KEIL_SWO.dll' },
        { name: 'NULink Debugger', dll: 'NULink\\Nu_Link.dll' },
        { name: 'Pemicro Debugger', dll: 'PEMicro\\Pemicro_ArmCortexInterface.dll' },
        { name: 'ULINK Pro ARMv8-M Debugger', dll: 'BIN\\ULP2V8M.DLL' },
        { name: 'ULINK2/ME ARMv8-M Debugger', dll: 'BIN\\UL2V8M.DLL' },
        { name: 'CMSIS-DAP ARMv8-M Debugger', dll: 'BIN\\CMSIS_AGDI_V8M.DLL' },
        { name: 'Models ARMv8-M Debugger', dll: 'BIN\\DbgFMv8M.DLL' }
    ],
    arm7: [
        { name: 'ULINK2/ME ARM Debugger', dll: 'BIN\\UL2ARM.DLL' },
        { name: 'ULINK Pro ARM Debugger', dll: 'BIN\\ULP2ARM.DLL' },
        { name: 'J-LINK / J-TRACE ARM', dll: 'Segger\\JLTAgdi.dll' }
    ],
    'cortex-r': [{ name: 'J-LINK / J-TRACE Cortex', dll: 'Segger\\JL2CM3.dll' }],
    c51: [],
    c251: [],
    unknown: []
};

/**
 * CPU group (`CPUDLLn` entry) of each family. Mirrors the mapping of
 * `keilInstall.ts`, which keeps the debugger list and the `Utilities/Flash1`
 * driver list in the same order.
 */
const FAMILY_CPU_DLLS: Record<KeilCpuFamily, string[]> = {
    arm7: ['SARM.DLL'],
    'cortex-m': ['SARMCM3.DLL'],
    'cortex-r': ['SARMCR4.DLL'],
    'armv8-m': ['SARMV8M.DLL'],
    c51: [],
    c251: [],
    unknown: ['SARMCM3.DLL']
};

/**
 * `TOOLS.INI` section that owns the driver list of a CPU family.
 *
 * `sectionForToolchain` deliberately falls back to `[ARM]` for C51/C251
 * projects, which is correct for toolchain lookups but would hand a C51 target
 * the ARM debugger list, so the family is mapped strictly here.
 */
function sectionForFamily(
    tools: KeilToolsIni | undefined,
    family: KeilCpuFamily
): KeilToolchainSection | undefined {
    if (!tools) {
        return undefined;
    }
    switch (family) {
        case 'c51':
            return tools.c51;
        case 'c251':
            return tools.c251;
        default:
            return tools.arm;
    }
}

/**
 * `TDRVn` ids of the `CPUDLLn` list that belongs to `family`.
 *
 * C51 / C251 installations usually have a single driver list; families without
 * a matching group fall back to the first group (or to all `TDRV` entries) so a
 * slightly different TOOLS.INI layout still yields a usable list.
 */
function driverIdsOfFamily(section: KeilToolchainSection | undefined, family: KeilCpuFamily): number[] {
    if (!section) {
        return [];
    }
    const wanted = (FAMILY_CPU_DLLS[family] || []).map((name) => name.toUpperCase());
    if (wanted.length > 0) {
        const group = section.groups.find((entry) => wanted.includes(path.basename(entry.cpuDll).toUpperCase()));
        if (group) {
            return group.driverIds;
        }
    }
    if (section.groups.length > 0) {
        return section.groups[0].driverIds;
    }
    return section.drivers.map((driver) => driver.tdrvId);
}

/**
 * Debugger list of the local installation for one CPU family. The order is the
 * order of the `CPUDLLn` list, i.e. the 0-based position is the `nTsel` value
 * uVision writes. Falls back to the built-in MDK 5 default list when the local
 * `TOOLS.INI` is unavailable or declares no adapter for the family.
 */
export function debuggerList(tools: KeilToolsIni | undefined, family: KeilCpuFamily): DebuggerDescriptor[] {
    const section = sectionForFamily(tools, family);
    const driverIds = driverIdsOfFamily(section, family);
    const defaults = DEFAULT_DEBUGGERS[family] || [];

    if (!section || driverIds.length === 0) {
        return defaults.map((entry, index) => ({ index, name: entry.name, dll: entry.dll }));
    }

    const byId = new Map<number, KeilDriverDefinition>();
    for (const driver of section.drivers) {
        byId.set(driver.tdrvId, driver);
    }
    return driverIds.map((tdrvId, index) => {
        const driver = byId.get(tdrvId);
        return driver
            ? { index, name: driver.name, dll: driver.dll }
            : { index, name: `驱动器 #${tdrvId}`, dll: '' };
    });
}

/**
 * Options of the panel dropdown: `sim` (simulator) followed by every adapter,
 * with the 0-based position as value and the adapter name as label.
 */
export function debuggerOptions(tools: KeilToolsIni | undefined, family: KeilCpuFamily): OptionEnumValue[] {
    const options: OptionEnumValue[] = [{ value: SIMULATOR_VALUE, label: '仿真器（Simulator）' }];
    for (const descriptor of debuggerList(tools, family)) {
        options.push({ value: String(descriptor.index), label: descriptor.name });
    }
    return options;
}

/** Locate a `<Target>` of a `.uvopt` / `.uvoptx` document by `<TargetName>`. */
function findOptTarget(root: XmlElement, targetName: string): XmlElement | undefined {
    if (root.name !== UVOPT_ROOT_ELEMENT) {
        return undefined;
    }
    return childElements(root, 'Target').find((target) => targetNameOf(target) === targetName);
}

/** Trimmed text of a direct child leaf, `undefined` when the element is missing. */
function readLeaf(parent: XmlElement, name: string): string | undefined {
    const element = firstChild(parent, name);
    return element ? trimmedTextOf(element) : undefined;
}

/** Parse a non-negative decimal index (`nTsel`), `undefined` for anything else. */
function parseIndex(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
        return undefined;
    }
    const index = Number(trimmed);
    return Number.isSafeInteger(index) ? index : undefined;
}

function unknownChoice(): DebuggerChoice {
    return { value: UNKNOWN_VALUE, mode: 'unknown' };
}

function resolveTargetChoice(
    index: number,
    tools: KeilToolsIni | undefined,
    family: KeilCpuFamily
): DebuggerChoice {
    const choice: DebuggerChoice = { value: String(index), mode: 'target', index };
    const descriptor = debuggerList(tools, family).find((entry) => entry.index === index);
    if (descriptor) {
        choice.name = descriptor.name;
        choice.dll = descriptor.dll;
    }
    return choice;
}

/**
 * Read the current debugger selection of one target from a `.uvopt` /
 * `.uvoptx` text.
 *
 * Missing text, missing target, missing `DebugOpt` and unparsable XML all yield
 * `{ mode: 'unknown', value: 'unknown' }`; this function never throws.
 */
export function readDebuggerChoice(
    uvoptText: string | undefined,
    targetName: string,
    tools: KeilToolsIni | undefined,
    family: KeilCpuFamily
): DebuggerChoice {
    if (typeof uvoptText !== 'string' || uvoptText.trim() === '') {
        return unknownChoice();
    }

    let doc: XmlDocument;
    try {
        doc = parseXml(uvoptText);
    } catch {
        return unknownChoice();
    }

    try {
        const target = findOptTarget(doc.root, targetName);
        if (!target) {
            return unknownChoice();
        }
        const debugOpt = findPath(target, DEBUG_OPT_PATH);
        if (!debugOpt) {
            return unknownChoice();
        }

        const useSimulator = readLeaf(debugOpt, 'uSim');
        const useTarget = readLeaf(debugOpt, 'uTrg');
        if (useSimulator === '1') {
            return { value: SIMULATOR_VALUE, mode: 'simulator' };
        }

        // Legacy/partial files may omit uSim/uTrg entirely; a valid nTsel is
        // then still a target selection.
        const flagsMissing = useSimulator === undefined && useTarget === undefined;
        if (useTarget !== '1' && !flagsMissing) {
            return unknownChoice();
        }
        const index = parseIndex(readLeaf(debugOpt, 'nTsel'));
        if (index === undefined) {
            return { value: UNKNOWN_VALUE, mode: useTarget === '1' ? 'target' : 'unknown' };
        }
        return resolveTargetChoice(index, tools, family);
    } catch {
        return unknownChoice();
    }
}

/** One `DebugOpt` leaf to write. */
interface DebuggerFieldEdit {
    path: string[];
    value: string;
}

/**
 * Translate a panel value (`sim` or an adapter index) into the `DebugOpt`
 * fields to write. Returns `undefined` for an unparsable value (nothing is
 * written, a warning is recorded instead).
 */
function debuggerFieldEdits(
    value: string,
    tools: KeilToolsIni | undefined,
    family: KeilCpuFamily,
    warnings: string[]
): DebuggerFieldEdit[] | undefined {
    const normalized = String(value).trim();
    if (normalized === SIMULATOR_VALUE) {
        // uVision keeps nTsel/pMon untouched when the simulator is selected.
        return [
            { path: [...DEBUG_OPT_PATH, 'uSim'], value: '1' },
            { path: [...DEBUG_OPT_PATH, 'uTrg'], value: '0' }
        ];
    }

    const index = parseIndex(normalized);
    if (index === undefined) {
        warnings.push(`无法识别的调试器选择值「${value}」，已忽略`);
        return undefined;
    }

    const edits: DebuggerFieldEdit[] = [
        { path: [...DEBUG_OPT_PATH, 'uSim'], value: '0' },
        { path: [...DEBUG_OPT_PATH, 'uTrg'], value: '1' },
        { path: [...DEBUG_OPT_PATH, 'nTsel'], value: String(index) }
    ];
    const descriptor = debuggerList(tools, family).find((entry) => entry.index === index);
    if (!descriptor) {
        warnings.push(`本机 TOOLS.INI 的调试器列表中没有序号 ${index}，已写入序号但未更新 pMon`);
    } else if (!descriptor.dll) {
        warnings.push(`调试器序号 ${index} 缺少驱动 DLL，已写入序号但未更新 pMon`);
    } else {
        edits.push({ path: [...DEBUG_OPT_PATH, 'pMon'], value: descriptor.dll });
    }
    return edits;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Write the debugger selection of one target back into a `.uvopt` /
 * `.uvoptx` text.
 *
 * - `sim` writes `uSim=1` / `uTrg=0` and keeps `nTsel` / `pMon` unchanged;
 * - an adapter index writes `uSim=0` / `uTrg=1` / `nTsel=<index>` and
 *   `pMon=<driver DLL of the local list>`.
 *
 * Only those fields are touched; when nothing has to change the input text is
 * returned byte for byte. Missing `DebugOpt` (or `TargetOption`) nodes are
 * created with `XmlEditor.setTextAt`. A missing target or unparsable XML throws
 * an `Error` whose message contains the target name.
 */
export function applyDebuggerChoice(
    uvoptXml: string,
    targetName: string,
    value: string,
    tools: KeilToolsIni | undefined,
    family: KeilCpuFamily
): DebuggerApplyResult {
    let doc: XmlDocument;
    try {
        doc = parseXml(uvoptXml);
    } catch (error) {
        throw new Error(`无法解析 .uvopt/.uvoptx 文件（目标「${targetName}」）：${describeError(error)}`);
    }
    const target = findOptTarget(doc.root, targetName);
    if (!target) {
        throw new Error(`目标不存在：${targetName}`);
    }

    const warnings: string[] = [];
    const edits = debuggerFieldEdits(value, tools, family, warnings);
    if (!edits) {
        return { xml: uvoptXml, changed: [DEBUGGER_FIELD_ID], warnings };
    }

    if (!findPath(target, DEBUG_OPT_PATH)) {
        warnings.push(`目标「${targetName}」的 .uvopt/.uvoptx 中缺少 DebugOpt，已创建`);
    }

    const updates: DebuggerFieldEdit[] = [];
    const creations: DebuggerFieldEdit[] = [];
    for (const edit of edits) {
        const existing = findPath(target, edit.path);
        if (!existing) {
            creations.push(edit);
        } else if (trimmedTextOf(existing) !== edit.value) {
            updates.push(edit);
        }
    }
    if (updates.length === 0 && creations.length === 0) {
        // Read -> apply produces no edit at all: keep the file byte for byte.
        return { xml: uvoptXml, changed: [DEBUGGER_FIELD_ID], warnings };
    }

    let currentXml = uvoptXml;
    if (updates.length > 0) {
        const editor = new XmlEditor(doc);
        for (const update of updates) {
            try {
                editor.setTextAt(target, update.path, update.value);
            } catch (error) {
                warnings.push(`写入 ${update.path.join('/')} 失败：${describeError(error)}`);
            }
        }
        currentXml = editor.apply();
    }

    // Creations run one at a time on freshly parsed text: `XmlEditor` computes
    // edits against a frozen DOM, so creating two siblings below a missing
    // `DebugOpt` in one editor pass would emit the whole container twice.
    for (const creation of creations) {
        let currentDoc: XmlDocument;
        try {
            currentDoc = parseXml(currentXml);
        } catch (error) {
            warnings.push(`创建 ${creation.path.join('/')} 失败：${describeError(error)}`);
            break;
        }
        const currentTarget = findOptTarget(currentDoc.root, targetName);
        if (!currentTarget) {
            warnings.push(`创建 ${creation.path.join('/')} 失败：目标「${targetName}」已不存在`);
            break;
        }
        const editor = new XmlEditor(currentDoc);
        try {
            editor.setTextAt(currentTarget, creation.path, creation.value);
        } catch (error) {
            warnings.push(`创建 ${creation.path.join('/')} 失败：${describeError(error)}`);
            continue;
        }
        currentXml = editor.apply();
    }

    return { xml: currentXml, changed: [DEBUGGER_FIELD_ID], warnings };
}
