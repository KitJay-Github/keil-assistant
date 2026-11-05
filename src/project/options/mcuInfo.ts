/**
 * Read-only MCU information derived from the Keil target options.
 *
 * The "Options for Target" panel renders a read-only "MCU 信息" section. All of
 * its content can be derived without opening uVision:
 * - `TargetCommonOption/Cpu` carries the memory map (`IRAM`/`IROM`/`XRAM`/
 *   `OCR_RVCTn`, ...), the core type (`CPUTYPE("Cortex-M4")`), the clock
 *   (`CLOCK(12000000)`) and the feature flags (`FPU2`, `DSP`, `TZ`, `ELITTLE`,
 *   `EBIG`, `ESEL`, `MODP2`, ...),
 * - `Device`, `Vendor`, `PackID`, `RegisterFile` and `SFDFile` are plain
 *   elements of the same subtree (see `uvOptionSchema.ts` for the field ids),
 * - the clock can fall back to the crystal frequency (`target.xtal`).
 *
 * The parser is defensive: the `Cpu` strings come from 1400+ heterogeneous real
 * world projects, so missing, truncated or otherwise malformed values must never
 * throw - whatever cannot be understood is simply omitted. This module is pure
 * (no `vscode` dependency, no file system access) so it can be unit tested.
 */
import type { UvToolchainKind } from './types';

/** Placeholder rendered for values that are missing or cannot be parsed. */
const UNKNOWN_VALUE = '—';

const HZ_PER_MHZ = 1000000;
const KIB = 1024;
const MIB = 1024 * 1024;

/** First 64 KiB of the address space: the limit of a classic 8051 (MCS-51). */
const LEGACY_64K_LIMIT = 0xffff;

/** 24-bit address space: the upper limit of an MCS-251 device. */
const LEGACY_251_LIMIT = 0xffffff;

/** Classic 8051 has at most 256 bytes of internal RAM. */
const LEGACY_51_IRAM_LIMIT = 0x100;

/** One contiguous memory region declared inside the `Cpu` string. */
export interface McuMemoryRegion {
    /** Region name exactly as declared, upper case, e.g. `IROM`, `IRAM2`, `XRAM`, `OCR_RVCT1`. */
    kind: string;
    /** First address of the region. */
    start: number;
    /** Size in bytes (inclusive range converted to a length). */
    size: number;
}

/** Everything the read-only MCU section can show. */
export interface McuDescription {
    device?: string;
    vendor?: string;
    packId?: string;
    /** `CPUTYPE` value; `MCS-51 (8051)` / `MCS-251` when the `Cpu` string has no `CPUTYPE`. */
    core?: string;
    clockHz?: number;
    flash?: McuMemoryRegion;
    ram?: McuMemoryRegion;
    /** All parsed regions, in the order they appear in the `Cpu` string. */
    memories: McuMemoryRegion[];
    fpu?: boolean;
    dsp?: boolean;
    trustZone?: boolean;
    endian?: 'little' | 'big';
    registerFile?: string;
    svdFile?: string;
}

/** One row of the generated read-only MCU section. */
export interface McuInfoRow {
    id: string;
    label: string;
    value: string;
}

interface MemoryBounds {
    start: number;
    size: number;
}

interface CpuToken {
    name: string;
    argument: string;
}

interface ParsedCpu {
    memories: McuMemoryRegion[];
    /** `CPUTYPE` value as written in the string (not inferred). */
    explicitCore?: string;
    clockHz?: number;
    fpu: boolean;
    dsp: boolean;
    trustZone: boolean;
    endian?: 'little' | 'big';
}

/**
 * Parse one numeric token of a `Cpu` string. Keil writes addresses either in
 * hexadecimal (`0x08000000`) or in decimal (`0`, `24000000`).
 */
function parseNumericToken(raw: string): number | undefined {
    const text = raw.trim();
    if (text.length === 0) {
        return undefined;
    }
    if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
        return parseInt(text.slice(2), 16);
    }
    if (/^[0-9]+$/.test(text)) {
        return parseInt(text, 10);
    }
    return undefined;
}

/**
 * Extract the start address and the size of one memory region argument.
 *
 * Three real world forms are supported:
 * - `0x20000000,0x00020000` - comma separated `start,size`,
 * - `0x20000000-0x20001FFF` - inclusive `start-end` range (size is `end - start + 1`),
 * - `0 - 0x41F` - the same range form with padding spaces (seen in C251 projects),
 * - a single address - a region whose size is unknown (reported as `0`).
 */
function parseMemoryBounds(argument: string): MemoryBounds | undefined {
    const text = argument.trim();
    if (text.length === 0) {
        return undefined;
    }

    if (text.indexOf(',') >= 0) {
        const parts = text.split(',');
        if (parts.length !== 2) {
            return undefined;
        }
        const start = parseNumericToken(parts[0]);
        const size = parseNumericToken(parts[1]);
        if (start === undefined || size === undefined || size < 0) {
            return undefined;
        }
        return { start, size };
    }

    const separator = text.indexOf('-');
    if (separator >= 0) {
        const start = parseNumericToken(text.slice(0, separator));
        const end = parseNumericToken(text.slice(separator + 1));
        if (start === undefined || end === undefined || end < start) {
            return undefined;
        }
        return { start, size: end - start + 1 };
    }

    const start = parseNumericToken(text);
    if (start === undefined) {
        return undefined;
    }
    return { start, size: 0 };
}

/** Strip the quotes Keil puts around `CPUTYPE("Cortex-M4")`. */
function unquote(value: string): string {
    const text = value.trim();
    if (text.length >= 2) {
        const first = text[0];
        const last = text[text.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return text.slice(1, -1).trim();
        }
    }
    return text;
}

/**
 * Split a `Cpu` string into `NAME(argument)` tokens plus the bare words that are
 * left over (the feature flags such as `FPU2`, `DSP`, `TZ`, `ELITTLE`, `EBIG`).
 * Tokens with nested parentheses are not expected in Keil files and are left to
 * the flag scan; they simply produce no memory region.
 */
function tokenizeCpuText(text: string): { tokens: CpuToken[]; flags: string[] } {
    const pattern = /([A-Za-z][A-Za-z0-9_]*)\s*\(([^()]*)\)/g;
    const tokens: CpuToken[] = [];
    let flagsText = '';
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
        flagsText += ` ${text.slice(cursor, match.index)} `;
        tokens.push({ name: match[1], argument: match[2] });
        cursor = match.index + match[0].length;
    }
    flagsText += ` ${text.slice(cursor)} `;
    const flags = flagsText
        .split(/[^A-Za-z0-9_]+/)
        .filter((word) => word.length > 0)
        .map((word) => word.toUpperCase());
    return { tokens, flags };
}

/** Parse the parts of a `Cpu` string that do not need the toolchain. */
function parseCpuText(cpuText: string | undefined): ParsedCpu {
    const parsed: ParsedCpu = { memories: [], fpu: false, dsp: false, trustZone: false };
    if (typeof cpuText !== 'string') {
        return parsed;
    }
    const text = cpuText.trim();
    if (text.length === 0) {
        return parsed;
    }

    const { tokens, flags } = tokenizeCpuText(text);
    for (const token of tokens) {
        const name = token.name.toUpperCase();
        if (name === 'CLOCK') {
            const clock = parseNumericToken(token.argument);
            if (clock !== undefined) {
                parsed.clockHz = clock;
            }
            continue;
        }
        if (name === 'CPUTYPE') {
            const core = unquote(token.argument);
            if (core.length > 0) {
                parsed.explicitCore = core;
            }
            continue;
        }
        if (/^FPU[0-9]*$/.test(name)) {
            // `FPU2` has no argument; `FPU3(SFPU)` / `FPU3(DFPU)` do.
            parsed.fpu = true;
            continue;
        }
        // Any remaining `NAME(numeric content)` pair is a memory region. This
        // covers IRAM/IROM/IRAM2/IROM2/XRAM/XRAM2 and OCR_RVCT1..OCR_RVCTn.
        const bounds = parseMemoryBounds(token.argument);
        if (bounds === undefined) {
            continue;
        }
        parsed.memories.push({ kind: name, start: bounds.start, size: bounds.size });
    }

    for (const flag of flags) {
        if (/^FPU[0-9]*$/.test(flag)) {
            parsed.fpu = true;
        } else if (flag === 'DSP') {
            parsed.dsp = true;
        } else if (flag === 'TZ') {
            parsed.trustZone = true;
        } else if (flag === 'ELITTLE') {
            parsed.endian = 'little';
        } else if (flag === 'EBIG') {
            parsed.endian = 'big';
        }
    }
    return parsed;
}

/**
 * Infer the core of a `Cpu` string that has no `CPUTYPE` (C51 / C251 projects).
 *
 * `Cpu` strings of the legacy toolchains carry no `CPUTYPE`, and the parser is
 * not given the toolchain, so the layout is used as a heuristic:
 * - an address beyond the 64 KiB code space (`0xFF0000` in C251 projects) or
 *   more than 256 bytes of internal RAM cannot be a classic 8051 -> MCS-251,
 * - anything above the 16 MiB MCS-251 address space (e.g. ARM flash at
 *   `0x08000000`) is not a legacy core at all -> unknown,
 * - ARM `Cpu` strings always contain `ELITTLE`/`EBIG` and `CPUTYPE`, so an
 *   endian flag also means "not a legacy core" -> unknown,
 * - everything else with a memory map is treated as a classic 8051.
 */
function inferLegacyCore(parsed: ParsedCpu): string | undefined {
    if (parsed.memories.length === 0 || parsed.endian !== undefined) {
        return undefined;
    }
    let above251Space = false;
    let above64K = false;
    let maxIramSize = 0;
    for (const region of parsed.memories) {
        if (region.start > LEGACY_251_LIMIT) {
            above251Space = true;
        }
        if (region.start > LEGACY_64K_LIMIT) {
            above64K = true;
        }
        if (region.kind === 'IRAM' || region.kind === 'IRAM2') {
            maxIramSize = Math.max(maxIramSize, region.size);
        }
    }
    if (above251Space) {
        return undefined;
    }
    if (above64K || maxIramSize > LEGACY_51_IRAM_LIMIT) {
        return 'MCS-251';
    }
    return 'MCS-51 (8051)';
}

/** Trimmed non-empty string, `undefined` otherwise. */
function cleanValue(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/** True for the ARM toolchain families (AC5 and AC6). */
function isArmToolchain(toolchain: UvToolchainKind): boolean {
    return toolchain === 'ARM' || toolchain === 'ARM6';
}

/**
 * Parse the MCU description that is encoded in a `Cpu` string.
 *
 * Only the `Cpu` text is used: `device`, `vendor`, `packId`, `registerFile` and
 * `svdFile` are never filled here (see {@link parseMcuDescription} for those).
 * Invalid input never throws; the result is then simply `{ memories: [] }`.
 */
export function parseCpuDescription(cpuText: string | undefined): McuDescription {
    const parsed = parseCpuText(cpuText);
    const description: McuDescription = { memories: parsed.memories };

    const core = parsed.explicitCore !== undefined ? parsed.explicitCore : inferLegacyCore(parsed);
    if (core !== undefined) {
        description.core = core;
    }
    if (parsed.clockHz !== undefined) {
        description.clockHz = parsed.clockHz;
    }
    const flash = parsed.memories.find((region) => region.kind === 'IROM');
    if (flash !== undefined) {
        description.flash = flash;
    }
    const ram = parsed.memories.find((region) => region.kind === 'IRAM');
    if (ram !== undefined) {
        description.ram = ram;
    }
    if (parsed.fpu) {
        description.fpu = true;
    }
    if (parsed.dsp) {
        description.dsp = true;
    }
    if (parsed.trustZone) {
        description.trustZone = true;
    }
    if (parsed.endian !== undefined) {
        description.endian = parsed.endian;
    }
    return description;
}

/**
 * Merge the target option values into one MCU description.
 *
 * `values` is keyed by the option field ids declared in `uvOptionSchema.ts`
 * (`target.device`, `target.vendor`, `target.packId`, `target.cpu`,
 * `target.sfdFile`, `target.registerFile`, ...). The toolchain decides the
 * legacy core name and removes an inferred core from an ARM project whose `Cpu`
 * string has no `CPUTYPE`. When the `Cpu` string has no `CLOCK`, the crystal
 * frequency from `.uvopt(x)` (`target.xtal`) is used as a fallback.
 */
export function parseMcuDescription(
    values: Record<string, string | undefined>,
    toolchain: UvToolchainKind
): McuDescription {
    const cpuText = values['target.cpu'];
    const parsed = parseCpuText(cpuText);
    const description = parseCpuDescription(cpuText);

    if (toolchain === 'C51') {
        description.core = 'MCS-51 (8051)';
    } else if (toolchain === 'C251') {
        description.core = 'MCS-251';
    } else if (parsed.explicitCore === undefined) {
        // Never claim a legacy core for an ARM project: only `CPUTYPE` is trustworthy.
        delete description.core;
    }

    if (description.clockHz === undefined) {
        const xtal = parseNumericToken(values['target.xtal'] || '');
        if (xtal !== undefined && xtal > 0) {
            description.clockHz = xtal;
        }
    }

    const device = cleanValue(values['target.device']);
    if (device !== undefined) {
        description.device = device;
    }
    const vendor = cleanValue(values['target.vendor']);
    if (vendor !== undefined) {
        description.vendor = vendor;
    }
    const packId = cleanValue(values['target.packId']);
    if (packId !== undefined) {
        description.packId = packId;
    }
    const registerFile = cleanValue(values['target.registerFile']);
    if (registerFile !== undefined) {
        description.registerFile = registerFile;
    }
    const svdFile = cleanValue(values['target.sfdFile']);
    if (svdFile !== undefined) {
        description.svdFile = svdFile;
    }
    return description;
}

/** Format a byte count: `1048576 -> '1 MB'`, `65536 -> '64 KB'`, `512 -> '512 B'`. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes)) {
        return UNKNOWN_VALUE;
    }
    const magnitude = Math.abs(bytes);
    if (magnitude >= MIB) {
        return `${formatScaled(bytes / MIB)} MB`;
    }
    if (magnitude >= KIB) {
        return `${formatScaled(bytes / KIB)} KB`;
    }
    return `${bytes} B`;
}

/** Round to at most two decimals and drop trailing zeros (`1.5`, `64`, `97.66`). */
function formatScaled(value: number): string {
    return String(Math.round(value * 100) / 100);
}

/**
 * Format a memory address as lower case hexadecimal, padded to eight digits:
 * `0x08000000`. Values that are not a valid address render as `—`.
 */
export function formatAddress(value: number): string {
    if (!Number.isFinite(value) || value < 0) {
        return UNKNOWN_VALUE;
    }
    const hex = Math.trunc(value).toString(16);
    return `0x${'0'.repeat(Math.max(0, 8 - hex.length))}${hex}`;
}

/**
 * Format a clock frequency: `72 MHz` for integer MHz, `12.5 MHz` for fractional
 * MHz (exact decimal digits) and `123 Hz` below one megahertz.
 */
function formatClock(clockHz: number): string {
    if (!Number.isFinite(clockHz) || clockHz < 0) {
        return UNKNOWN_VALUE;
    }
    if (clockHz < HZ_PER_MHZ) {
        return `${clockHz} Hz`;
    }
    const whole = Math.floor(clockHz / HZ_PER_MHZ);
    const fraction = Math.floor(clockHz % HZ_PER_MHZ);
    if (fraction === 0) {
        return `${whole} MHz`;
    }
    const fractionText = `${'000000'}${fraction}`.slice(-6).replace(/0+$/, '');
    return `${whole}.${fractionText} MHz`;
}

/** Format one memory region as `512 KB @ 0x08000000`. */
function formatMemoryRegion(region: McuMemoryRegion): string {
    return `${formatBytes(region.size)} @ ${formatAddress(region.start)}`;
}

/** Regions that are not already shown as the flash / RAM rows. */
function otherMemoryRegions(description: McuDescription): McuMemoryRegion[] {
    return description.memories.filter(
        (region) => region !== description.flash && region !== description.ram
    );
}

/** Format one "other" region as `IRAM2 32 KB @ 0x2007C000`. */
function formatOtherMemoryRegion(region: McuMemoryRegion): string {
    return `${region.kind} ${formatMemoryRegion(region)}`;
}

/** `FPU`, `DSP`, `TrustZone` and the endianness, in that order. */
function describeFeatures(description: McuDescription): string[] {
    const features: string[] = [];
    if (description.fpu) {
        features.push('FPU');
    }
    if (description.dsp) {
        features.push('DSP');
    }
    if (description.trustZone) {
        features.push('TrustZone');
    }
    if (description.endian === 'little') {
        features.push('小端');
    } else if (description.endian === 'big') {
        features.push('大端');
    }
    return features;
}

/**
 * Build the rows of the read-only "MCU 信息" section.
 *
 * The rows `mcu.device`, `mcu.core`, `mcu.clock`, `mcu.flash` and `mcu.ram` are
 * always present so the section keeps a stable layout; missing information is
 * rendered as `—`. The remaining rows are only emitted when they carry a value:
 * `mcu.otherMemories` (regions beyond the first IROM/IRAM), `mcu.features`
 * (ARM only - FPU/DSP/TrustZone/endian), `mcu.registerFile` and `mcu.svdFile`
 * (SVD files do not exist for C51/C251 targets).
 */
export function buildMcuInfoRows(
    values: Record<string, string | undefined>,
    toolchain: UvToolchainKind
): McuInfoRow[] {
    const description = parseMcuDescription(values, toolchain);
    const rows: McuInfoRow[] = [
        { id: 'mcu.device', label: '器件型号', value: description.device ?? UNKNOWN_VALUE },
        { id: 'mcu.core', label: '内核', value: description.core ?? UNKNOWN_VALUE },
        {
            id: 'mcu.clock',
            label: '主频',
            value: description.clockHz !== undefined ? formatClock(description.clockHz) : UNKNOWN_VALUE
        },
        {
            id: 'mcu.flash',
            label: 'Flash',
            value: description.flash !== undefined ? formatMemoryRegion(description.flash) : UNKNOWN_VALUE
        },
        {
            id: 'mcu.ram',
            label: 'RAM',
            value: description.ram !== undefined ? formatMemoryRegion(description.ram) : UNKNOWN_VALUE
        }
    ];

    const others = otherMemoryRegions(description);
    if (others.length > 0) {
        rows.push({
            id: 'mcu.otherMemories',
            label: '其他内存',
            value: others.map((region) => formatOtherMemoryRegion(region)).join('; ')
        });
    }

    if (isArmToolchain(toolchain)) {
        const features = describeFeatures(description);
        if (features.length > 0) {
            rows.push({ id: 'mcu.features', label: '特性', value: features.join('、') });
        }
    }

    if (description.registerFile !== undefined) {
        rows.push({ id: 'mcu.registerFile', label: '寄存器头文件', value: description.registerFile });
    }
    if (description.svdFile !== undefined && isArmToolchain(toolchain)) {
        rows.push({ id: 'mcu.svdFile', label: 'SVD 描述文件', value: description.svdFile });
    }
    return rows;
}
