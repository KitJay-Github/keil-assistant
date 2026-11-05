/**
 * Keil uVision installation metadata: debugger/flash driver tables.
 *
 * The numeric `Utilities/Flash1/DriverSelection` value is **not** a stable global
 * enum. uVision writes `4096 + <0-based index>` of the selected driver inside the
 * driver list of the device's CPU group (`CPUDLLn` entries in `TOOLS.INI`). The
 * index therefore depends on the uVision installation that wrote the project, so
 * this module derives the candidate values from the **local** installation
 * instead of shipping a guessed hard-coded list.
 *
 * Example `TOOLS.INI` fragment (MDK 5):
 * ```
 * [ARM]
 * VERSION=5.36
 * CPUDLL1=SARMCM3.DLL(TDRV0,TDRV1,...,TDRV11)   # Drivers for Cortex-M devices
 * TDRV0=BIN\UL2CM3.DLL("ULINK2/ME Cortex Debugger")
 * TDRV3=BIN\CMSIS_AGDI.dll("CMSIS-DAP Debugger")
 * ```
 */
import * as fs from 'fs';
import * as path from 'path';
import type { OptionEnumValue, UvToolchainKind } from './types';

/** Base value of `DriverSelection`; the driver index is added to it. */
export const DRIVER_SELECTION_BASE = 4096;

export interface KeilDriverDefinition {
    /** `TDRVn` index in the section. */
    tdrvId: number;
    /** DLL path as written in TOOLS.INI, e.g. `BIN\UL2CM3.DLL`. */
    dll: string;
    /** Debugger name, e.g. `ULINK2/ME Cortex Debugger`. */
    name: string;
}

export interface KeilCpuDriverGroup {
    cpuDll: string;
    driverIds: number[];
    /** Trailing comment of the `CPUDLLn` line, e.g. `Drivers for Cortex-M devices`. */
    comment?: string;
}

export interface KeilToolchainSection {
    /** Toolchain version from `VERSION=`, e.g. `5.36`. */
    version?: string;
    /** Install path from `PATH=`. */
    installPath?: string;
    drivers: KeilDriverDefinition[];
    groups: KeilCpuDriverGroup[];
}

export interface KeilToolsIni {
    arm?: KeilToolchainSection;
    c51?: KeilToolchainSection;
    c251?: KeilToolchainSection;
}

/** CPU family used to pick the matching `CPUDLLn` driver group. */
export type KeilCpuFamily = 'arm7' | 'cortex-m' | 'cortex-r' | 'armv8-m' | 'c51' | 'c251' | 'unknown';

const SECTION_RE = /^\[([^\]]+)\]\s*$/;
const CPUDLL_RE = /^CPUDLL(\d+)\s*=\s*([^()]+?)\s*\((.*?)\)\s*(?:#\s*(.*))?$/i;
const TDRV_RE = /^TDRV(\d+)\s*=\s*([^(]*?)\s*\(\s*"([^"]*)"\s*\)/i;
const PATH_RE = /^PATH\s*=\s*"([^"]*)"/i;
const VERSION_RE = /^VERSION\s*=\s*([^\s#]+)/i;

function trimValue(value: string | undefined): string {
    return (value || '').trim();
}

function parseSection(lines: string[]): KeilToolchainSection {
    const section: KeilToolchainSection = { drivers: [], groups: [] };
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(';') || line.startsWith('#')) {
            continue;
        }
        const cpuDllMatch = CPUDLL_RE.exec(line);
        if (cpuDllMatch) {
            const driverIds = cpuDllMatch[3]
                .split(',')
                .map((entry) => Number(entry.trim().replace(/^TDRV/i, '')))
                .filter((value) => !Number.isNaN(value));
            const group: KeilCpuDriverGroup = {
                cpuDll: trimValue(cpuDllMatch[2]),
                driverIds
            };
            const comment = trimValue(cpuDllMatch[4]);
            if (comment) {
                group.comment = comment;
            }
            section.groups.push(group);
            continue;
        }
        const tdrvMatch = TDRV_RE.exec(line);
        if (tdrvMatch) {
            section.drivers.push({
                tdrvId: Number(tdrvMatch[1]),
                dll: trimValue(tdrvMatch[2]),
                name: trimValue(tdrvMatch[3])
            });
            continue;
        }
        const pathMatch = PATH_RE.exec(line);
        if (pathMatch) {
            section.installPath = pathMatch[1];
            continue;
        }
        const versionMatch = VERSION_RE.exec(line);
        if (versionMatch) {
            section.version = versionMatch[1];
        }
    }
    return section;
}

/** Parse a `TOOLS.INI` file of an MDK/C51/C251 installation. */
export function parseToolsIni(text: string): KeilToolsIni {
    const result: KeilToolsIni = {};
    const sections = new Map<string, string[]>();
    let current: string | undefined;
    for (const rawLine of String(text).split(/\r\n|\n|\r/)) {
        const sectionMatch = SECTION_RE.exec(rawLine.trim());
        if (sectionMatch) {
            current = sectionMatch[1].trim().toUpperCase();
            if (!sections.has(current)) {
                sections.set(current, []);
            }
            continue;
        }
        if (current) {
            const list = sections.get(current);
            if (list) {
                list.push(rawLine);
            }
        }
    }

    const assigned = new Set<string>();
    const assign = (key: keyof KeilToolsIni, sectionName: string): void => {
        const lines = sections.get(sectionName);
        if (!lines || assigned.has(key)) {
            return;
        }
        assigned.add(key);
        result[key] = parseSection(lines);
    };
    assign('arm', 'ARM');
    assign('c51', 'C51');
    assign('c251', 'C251');
    return result;
}

/** Pick the toolchain section of a `TOOLS.INI` for a project toolchain. */
export function sectionForToolchain(
    tools: KeilToolsIni | undefined,
    toolchain: UvToolchainKind
): KeilToolchainSection | undefined {
    if (!tools) {
        return undefined;
    }
    switch (toolchain) {
        case 'C51':
            return tools.c51 || tools.arm;
        case 'C251':
            return tools.c251 || tools.arm;
        default:
            return tools.arm;
    }
}

function coreFromCpuText(cpuText: string | undefined): string | undefined {
    const match = /CPUTYPE\s*\(\s*"([^"]*)"\s*\)/i.exec(cpuText || '');
    return match ? match[1].trim() : undefined;
}

/** Derive the CPU family (used to pick the right `CPUDLLn` driver list). */
export function cpuFamilyOf(cpuText: string | undefined, toolchain: UvToolchainKind): KeilCpuFamily {
    if (toolchain === 'C51') {
        return 'c51';
    }
    if (toolchain === 'C251') {
        return 'c251';
    }

    const core = coreFromCpuText(cpuText);
    if (core) {
        const normalized = core.toUpperCase();
        if (/CORTEX-M(23|33|35|52|55|85)/.test(normalized)) {
            return 'armv8-m';
        }
        if (normalized.startsWith('CORTEX-M')) {
            return 'cortex-m';
        }
        if (normalized.startsWith('CORTEX-R')) {
            return 'cortex-r';
        }
        return 'arm7';
    }

    const text = (cpuText || '').toUpperCase();
    if (/ARM(7|9|11)|TDMI|ARM96/.test(text)) {
        return 'arm7';
    }
    return 'cortex-m';
}

/** Fallback driver names (default MDK 5 `TOOLS.INI`) when no local install is found. */
const DEFAULT_DRIVER_NAMES: Record<KeilCpuFamily, string[]> = {
    'cortex-m': [
        'ULINK2/ME Cortex Debugger',
        'ULINK Pro Cortex Debugger',
        'ULINKplus Debugger',
        'CMSIS-DAP Debugger',
        'J-LINK / J-TRACE Cortex',
        'Models Cortex-M Debugger',
        'ST-Link Debugger',
        'NULink Debugger',
        'PEMicro Debugger',
        'SiLabs UDA Debugger',
        'Altera Blaster Cortex Debugger',
        'TI XDS Debugger'
    ],
    'armv8-m': [
        'ULINKplus Debugger',
        'J-LINK / J-TRACE Cortex',
        'ST-Link Debugger',
        'NULink Debugger',
        'PEMicro Debugger',
        'ULINK Pro ARMv8-M Debugger',
        'ULINK2/ME ARMv8-M Debugger',
        'CMSIS-DAP ARMv8-M Debugger',
        'Models ARMv8-M Debugger'
    ],
    arm7: ['ULINK2/ME ARM Debugger', 'ULINK Pro ARM Debugger', 'J-LINK / J-TRACE ARM'],
    'cortex-r': ['J-LINK / J-TRACE Cortex'],
    c51: [],
    c251: [],
    unknown: []
};

const GROUPS_BY_FAMILY: Record<KeilCpuFamily, string[]> = {
    arm7: ['SARM.DLL'],
    'cortex-m': ['SARMCM3.DLL'],
    'cortex-r': ['SARMCR4.DLL'],
    'armv8-m': ['SARMV8M.DLL'],
    c51: [],
    c251: [],
    unknown: ['SARMCM3.DLL']
};

function driverIdListOf(section: KeilToolchainSection | undefined, family: KeilCpuFamily): number[] {
    if (!section) {
        return [];
    }
    const wanted = GROUPS_BY_FAMILY[family].map((name) => name.toUpperCase());
    if (wanted.length > 0) {
        const group = section.groups.find((entry) => wanted.includes(path.basename(entry.cpuDll).toUpperCase()));
        if (group) {
            return group.driverIds;
        }
    }
    // C51 / C251 sections usually have a single driver list.
    return section.groups.length > 0 ? section.groups[0].driverIds : section.drivers.map((driver) => driver.tdrvId);
}

/**
 * Candidate `DriverSelection` values for the local installation.
 *
 * Values are rendered as `4096 + index` with the debugger name taken from
 * `TOOLS.INI`; `-1` (no driver) and `0` (unset) are always offered.
 */
export function driverSelectionOptions(
    tools: KeilToolsIni | undefined,
    family: KeilCpuFamily
): OptionEnumValue[] {
    const section = tools ? sectionForFamily(tools, family) : undefined;
    const byId = new Map<number, KeilDriverDefinition>();
    for (const driver of section ? section.drivers : []) {
        byId.set(driver.tdrvId, driver);
    }

    const ids = driverIdListOf(section, family);
    const names: string[] = [];
    let usedLocalList = false;

    if (ids.length > 0) {
        usedLocalList = true;
        for (const id of ids) {
            const driver = byId.get(id);
            names.push(driver ? driver.name : `驱动器 #${id}`);
        }
    } else {
        names.push(...DEFAULT_DRIVER_NAMES[family]);
    }

    const options: OptionEnumValue[] = [
        { value: '-1', label: '-1（未选择调试/下载驱动）' },
        { value: '0', label: '0（未指定，使用默认驱动）' }
    ];
    names.forEach((name, index) => {
        const value = String(DRIVER_SELECTION_BASE + index);
        options.push({ value, label: `${value}（${name}）` });
    });

    if (!usedLocalList && names.length > 0) {
        options.push({
            value: String(DRIVER_SELECTION_BASE + names.length),
            label: `${DRIVER_SELECTION_BASE + names.length}（其他驱动，见本机 TOOLS.INI）`
        });
    }
    return options;
}

/** Find the `TOOLS.INI` section matching a CPU family (used for driver lookups). */
function sectionForFamily(tools: KeilToolsIni, family: KeilCpuFamily): KeilToolchainSection | undefined {
    switch (family) {
        case 'c51':
            return tools.c51;
        case 'c251':
            return tools.c251;
        default:
            return tools.arm;
    }
}

function normalizeDll(value: string): string {
    return value
        .trim()
        .replace(/^"|"$/g, '')
        .replace(/\\/g, '/')
        .toLowerCase();
}

/** Resolve a driver definition (name + canonical DLL) from a DLL written in a project file. */
export function findDriverByDll(
    tools: KeilToolsIni | undefined,
    dllPath: string | undefined
): KeilDriverDefinition | undefined {
    const normalized = normalizeDll(dllPath || '');
    if (!normalized) {
        return undefined;
    }
    const baseName = path.basename(normalized);
    const sections: Array<KeilToolchainSection | undefined> = tools
        ? [tools.arm, tools.c51, tools.c251]
        : [];

    for (const section of sections) {
        if (!section) {
            continue;
        }
        for (const driver of section.drivers) {
            const candidate = normalizeDll(driver.dll);
            if (candidate === normalized || path.basename(candidate) === baseName) {
                return driver;
            }
        }
    }
    return undefined;
}

/**
 * Resolve the absolute path of a driver DLL written in a project file.
 * Tries the ARM / C51 / C251 subdirectories of the installation and the raw path.
 */
export function resolveDriverDllPath(
    keilRoot: string | undefined,
    toolchain: UvToolchainKind,
    dllPath: string | undefined
): string | undefined {
    const raw = trimValue(dllPath);
    if (!raw) {
        return undefined;
    }
    const normalized = raw.replace(/^"|"$/g, '').replace(/\//g, '\\');
    if (path.isAbsolute(normalized)) {
        return fs.existsSync(normalized) ? normalized : undefined;
    }
    const baseName = path.basename(normalized);
    const roots: string[] = [];
    if (keilRoot) {
        const subDirs = toolchain === 'C51' ? ['C51', 'C51\\BIN'] : toolchain === 'C251' ? ['C251', 'C251\\BIN'] : ['ARM', 'ARM\\BIN'];
        for (const subDir of subDirs) {
            roots.push(path.join(keilRoot, subDir, normalized));
            roots.push(path.join(keilRoot, subDir, baseName));
        }
        roots.push(path.join(keilRoot, normalized));
    }
    for (const candidate of roots) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/** Read and parse the `TOOLS.INI` of an installation root (best effort). */
export function readToolsIni(keilRoot: string | undefined): KeilToolsIni | undefined {
    if (!keilRoot) {
        return undefined;
    }
    const toolsPath = path.join(keilRoot, 'TOOLS.INI');
    try {
        if (!fs.existsSync(toolsPath)) {
            return undefined;
        }
        return parseToolsIni(fs.readFileSync(toolsPath, 'utf8'));
    } catch {
        return undefined;
    }
}
