/**
 * J-Link / J-Trace adapter settings stored in the `.uvopt(x)` target driver
 * registry entry (`TargetDriverDllRegistry/SetRegEntry[Key=JL2CM3]/Name`).
 *
 * uVision encodes the "Cortex JLink/JTrace Target Driver Setup" dialog in a
 * single command-line style string, e.g.:
 *
 * ```
 * -U20090928 -O78 -S1 -ZTIFSpeedSel10000 -A0 -C0 -JU1 -JI127.0.0.1 -JP0 -RST0
 *   -N00("ARM CoreSight SW-DP") -D00(1BA01477) ... -FO15 -FD20000000 ...
 * ```
 *
 * Mapping used here (see the design appendix):
 * - `-O<value>`: port/reset bit field. Bit 6 (0x40) selects SWD (else JTAG);
 *   the usual base value is 14 (JTAG) / 78 (SWD). Bit 0 is cleared when
 *   "Reset after Connect" is enabled.
 * - `-S<code> -ZTIFSpeedSel<kHz>`: adapter clock (speed code table below).
 * - `-C<index>`: connect mode (0 = Normal, 1 = with Pre-reset, 2 = under Reset).
 * - `-RST<index>`: reset strategy index (see {@link JLINK_RESET_OPTIONS}).
 * - `-JU<0|1>`: interface, 1 = USB, 0 = TCP/IP (`-JI<ip>` / `-JP<port>`).
 *
 * Everything else in the flag string (serial number, trace/flash settings,
 * device chain) is preserved byte for byte.
 */
import { childElements, escapeXmlText, findPath, parseXml, textOf, XmlElement } from '../uvXml';
import type { OptionEnumValue } from './types';

/** uVision's J-Link driver registry keys. */
const JLINK_KEYS = ['JL2CM3', 'JLTAgdi'];

export interface JlinkClockOption {
    /** Clock in kHz, written to `-ZTIFSpeedSel`. */
    khz: number;
    /** uVision speed code, written to `-S`. */
    code: number;
    label: string;
}

/**
 * Adapter clock list of the J-Link MDK driver. The code table mirrors uVision's
 * own numbering (`-S<code>`), the kHz value is stored in `-ZTIFSpeedSel`.
 */
export const JLINK_CLOCK_OPTIONS: JlinkClockOption[] = [
    { khz: 50000, code: 8, label: '50 MHz' },
    { khz: 33000, code: 9, label: '33 MHz' },
    { khz: 25000, code: 10, label: '25 MHz' },
    { khz: 20000, code: 0, label: '20 MHz' },
    { khz: 10000, code: 1, label: '10 MHz' },
    { khz: 5000, code: 2, label: '5 MHz' },
    { khz: 3000, code: 3, label: '3 MHz' },
    { khz: 2000, code: 4, label: '2 MHz' },
    { khz: 1000, code: 5, label: '1 MHz' },
    { khz: 500, code: 6, label: '500 kHz' },
    { khz: 200, code: 7, label: '200 kHz' }
];

export interface JlinkPortOption {
    value: 'jtag' | 'sw';
    label: string;
    /** `-O` bit 0x40. */
    oBit: number;
}

export const JLINK_PORT_OPTIONS: JlinkPortOption[] = [
    { value: 'jtag', label: 'JTAG', oBit: 0 },
    { value: 'sw', label: 'SW（Serial Wire）', oBit: 0x40 }
];

export interface JlinkConnectOption {
    value: 'normal' | 'pre-reset' | 'under-reset';
    label: string;
    /** `-C` index. */
    index: number;
}

export const JLINK_CONNECT_OPTIONS: JlinkConnectOption[] = [
    { value: 'normal', label: 'Normal', index: 0 },
    { value: 'pre-reset', label: 'with Pre-reset', index: 1 },
    { value: 'under-reset', label: 'under Reset', index: 2 }
];

export interface JlinkResetOption {
    value: string;
    label: string;
    /** `-RST` index. */
    index: number;
}

/** Reset strategies, in uVision's own order (index = `-RST` value). */
export const JLINK_RESET_OPTIONS: JlinkResetOption[] = [
    { value: 'normal', label: 'Normal', index: 0 },
    { value: 'core', label: 'Core', index: 1 },
    { value: 'reset-pin', label: 'Reset Pin', index: 2 },
    { value: 'connect-under-reset', label: 'Connect under Reset', index: 3 },
    { value: 'halt-after-bootloader', label: 'Halt after Bootloader', index: 4 },
    { value: 'halt-before-bootloader', label: 'Halt before Bootloader', index: 5 },
    { value: 'kinetis', label: 'Kinetis', index: 6 },
    { value: 'adi-halt-after-kernel', label: 'ADI Halt after Kernel', index: 7 },
    { value: 'core-and-peripherals', label: 'Core and Peripherals', index: 8 },
    { value: 'lpc1200', label: 'LPC1200', index: 9 }
];

export const JLINK_INTERFACE_OPTIONS: OptionEnumValue[] = [
    { value: 'usb', label: 'USB' },
    { value: 'tcp', label: 'TCP/IP' }
];

/** Target/trace flags that must stay untouched when rewriting the adapter part. */
const TRACE_FLAG_PREFIXES = ['-TO', '-TC', '-TP', '-TDS', '-TDT', '-TDC', '-TIE', '-TIP', '-TB', '-TFE'];

export interface JlinkSettings {
    /** Registry key the settings were read from (undefined when absent). */
    driverKey?: string;
    port?: 'jtag' | 'sw';
    maxClockKhz?: number;
    connect?: 'normal' | 'pre-reset' | 'under-reset';
    reset?: string;
    resetAfter?: boolean;
    interface?: 'usb' | 'tcp';
    ip?: string;
    tcpPort?: number;
}

export interface JlinkApplyResult {
    xml: string;
    changed: string[];
    warnings: string[];
}

/** True when the given driver DLL belongs to the J-Link/J-Trace driver. */
export function isJlinkDriver(dllPath: string | undefined): boolean {
    const dll = (dllPath || '').replace(/\//g, '\\').toLowerCase();
    const baseName = dll.split('\\').pop() || dll;
    return baseName === 'jl2cm3.dll' || baseName === 'jltagdi.dll';
}

function findEntry(target: XmlElement): { entry: XmlElement; key: string } | undefined {
    const registry = findPath(target, ['TargetOption', 'TargetDriverDllRegistry']);
    if (!registry) {
        return undefined;
    }
    for (const entry of childElements(registry, 'SetRegEntry')) {
        const keyElement = childElements(entry, 'Key')[0];
        const nameElement = childElements(entry, 'Name')[0];
        if (!keyElement || !nameElement) {
            continue;
        }
        const key = textOf(keyElement).trim();
        if (JLINK_KEYS.indexOf(key) !== -1) {
            return { entry, key };
        }
    }
    return undefined;
}

function findTargetElement(root: XmlElement, targetName: string): XmlElement | undefined {
    // `.uvprojx` nests targets under <Targets>, `.uvopt(x)` puts them directly under <ProjectOpt>.
    const container = findPath(root, ['Targets']);
    const targets = container ? childElements(container, 'Target') : childElements(root, 'Target');
    return targets.find((target) => {
        const nameElement = childElements(target, 'TargetName')[0];
        return nameElement ? textOf(nameElement).trim() === targetName : false;
    });
}

interface ParsedFlags {
    /** Ordered tokens; flag tokens keep their original text. */
    tokens: string[];
    /** Flag name (e.g. `-O`) -> token index. */
    indexByName: Map<string, number>;
}

function isFlagToken(token: string): boolean {
    return /^-[A-Za-z]/.test(token);
}

function parseFlagString(value: string): ParsedFlags {
    const tokens: string[] = [];
    // Split on spaces that are outside of parentheses/quotes ("-N00("ARM ...")").
    let current = '';
    let depth = 0;
    let quote = '';
    for (const ch of value) {
        if (quote) {
            current += ch;
            if (ch === quote) {
                quote = '';
            }
            continue;
        }
        if (ch === '"') {
            quote = ch;
            current += ch;
            continue;
        }
        if (ch === '(') {
            depth++;
            current += ch;
            continue;
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1);
            current += ch;
            continue;
        }
        if (/\s/.test(ch) && depth === 0) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current.length > 0) {
        tokens.push(current);
    }

    const indexByName = new Map<string, number>();
    tokens.forEach((token, index) => {
        const match = /^(-[A-Za-z]+)/.exec(token);
        if (match) {
            indexByName.set(match[1].toUpperCase(), index);
        }
    });
    return { tokens, indexByName };
}

function numberFlag(parsed: ParsedFlags, flag: string): number | undefined {
    const index = parsed.indexByName.get(flag.toUpperCase());
    if (index === undefined) {
        return undefined;
    }
    const match = /^(-[A-Za-z]+)(-?\d+)/.exec(parsed.tokens[index]);
    if (!match) {
        return undefined;
    }
    return Number(match[2]);
}

function stringFlag(parsed: ParsedFlags, flag: string): string | undefined {
    const index = parsed.indexByName.get(flag.toUpperCase());
    if (index === undefined) {
        return undefined;
    }
    const match = /^-([A-Za-z]+)(.*)$/.exec(parsed.tokens[index]);
    return match ? match[2] : undefined;
}

function findTraceFlag(parsed: ParsedFlags): number {
    for (let i = 0; i < parsed.tokens.length; i++) {
        const upper = parsed.tokens[i].toUpperCase();
        if (TRACE_FLAG_PREFIXES.some((prefix) => upper.startsWith(prefix.toUpperCase()))) {
            return i;
        }
    }
    return -1;
}

/** Read the J-Link settings from a `.uvopt(x)` document text. */
export function readJlinkSettings(uvoptText: string, targetName: string): JlinkSettings | undefined {
    let root: XmlElement;
    try {
        root = parseXml(uvoptText).root;
    } catch {
        return undefined;
    }
    const target = findTargetElement(root, targetName);
    if (!target) {
        return undefined;
    }
    const found = findEntry(target);
    if (!found) {
        return undefined;
    }
    const nameElement = childElements(found.entry, 'Name')[0];
    const parsed = parseFlagString(nameElement ? textOf(nameElement).trim() : '');

    const settings: JlinkSettings = { driverKey: found.key };
    const o = numberFlag(parsed, '-O');
    if (o !== undefined) {
        settings.port = (o & 0x40) !== 0 ? 'sw' : 'jtag';
        settings.resetAfter = (o & 0x01) === 0;
    }
    const speed = stringFlag(parsed, '-ZTIFSpeedSel');
    if (speed !== undefined) {
        const khz = Number(speed);
        if (!Number.isNaN(khz)) {
            settings.maxClockKhz = khz;
        }
    }
    const connect = numberFlag(parsed, '-C');
    if (connect !== undefined) {
        const match = JLINK_CONNECT_OPTIONS.find((option) => option.index === connect);
        if (match) {
            settings.connect = match.value;
        }
    }
    const rst = numberFlag(parsed, '-RST');
    if (rst !== undefined) {
        const match = JLINK_RESET_OPTIONS.find((option) => option.index === rst);
        if (match) {
            settings.reset = match.value;
        }
    }
    const ju = numberFlag(parsed, '-JU');
    if (ju !== undefined) {
        settings.interface = ju === 1 ? 'usb' : 'tcp';
    }
    const ip = stringFlag(parsed, '-JI');
    if (ip) {
        settings.ip = ip;
    }
    const port = numberFlag(parsed, '-JP');
    if (port !== undefined) {
        settings.tcpPort = port;
    }
    return settings;
}

function setFlag(parsed: ParsedFlags, flag: string, value: string): void {
    const full = flag + value;
    const existing = parsed.indexByName.get(flag.toUpperCase());
    if (existing !== undefined) {
        parsed.tokens[existing] = full;
        return;
    }
    // Insert adapter flags before the trace flags, the rest at the end.
    const traceIndex = findTraceFlag(parsed);
    const insertAt = traceIndex === -1 ? parsed.tokens.length : traceIndex;
    parsed.tokens.splice(insertAt, 0, full);
    parsed.indexByName.set(flag.toUpperCase(), insertAt);
    // Re-index the shifted tokens.
    parsed.indexByName.clear();
    parsed.tokens.forEach((token, index) => {
        const match = /^(-[A-Za-z]+)/.exec(token);
        if (match) {
            parsed.indexByName.set(match[1].toUpperCase(), index);
        }
    });
}

function serializeFlags(parsed: ParsedFlags): string {
    return parsed.tokens.join(' ');
}

/**
 * Apply adapter settings to the J-Link registry entry of one target.
 *
 * Only the adapter flags (`-O`, `-S`, `-ZTIFSpeedSel`, `-C`, `-RST`, `-JU`,
 * `-JI`, `-JP`) are rewritten; the serial number, device chain, trace and flash
 * settings are preserved. When the target has no J-Link registry entry the
 * settings are left untouched and a warning is returned.
 */
export function applyJlinkSettings(
    uvoptXml: string,
    targetName: string,
    values: Partial<JlinkSettings>
): JlinkApplyResult {
    const doc = parseXml(uvoptXml);
    const target = findTargetElement(doc.root, targetName);
    if (!target) {
        throw new Error(`目标不存在：${targetName}`);
    }
    const found = findEntry(target);
    if (!found) {
        return {
            xml: uvoptXml,
            changed: [],
            warnings: ['工程中缺少 J-Link 驱动记录（TargetDriverDllRegistry/JL2CM3），请先在 uVision 的 Debug 设置中打开一次并保存']
        };
    }
    const nameElements = childElements(found.entry, 'Name');
    if (nameElements.length === 0) {
        return { xml: uvoptXml, changed: [], warnings: ['J-Link 驱动记录缺少 Name 字段'] };
    }
    const nameElement = nameElements[0];
    const original = textOf(nameElement).trim();
    const parsed = parseFlagString(original);
    const warnings: string[] = [];
    const changed: string[] = [];

    if (values.port !== undefined) {
        const option = JLINK_PORT_OPTIONS.find((entry) => entry.value === values.port);
        if (option) {
            const current = numberFlag(parsed, '-O');
            const base = current === undefined ? 0x0e : current;
            // Switch the port bit only; bit 0 ("Reset after Connect") is handled below.
            const next = (base & ~0x41) | option.oBit | (base & 0x01);
            if (next !== current) {
                setFlag(parsed, '-O', String(next));
                changed.push('jlink.port');
            }
        }
    }
    if (values.resetAfter !== undefined) {
        const current = numberFlag(parsed, '-O');
        const base = current === undefined ? 0x0e : current;
        const next = values.resetAfter ? (base & ~0x01) : (base | 0x01);
        if (next !== current) {
            setFlag(parsed, '-O', String(next));
            if (changed.indexOf('jlink.port') === -1) {
                changed.push('jlink.resetAfter');
            } else {
                changed.push('jlink.resetAfter');
            }
        }
    }
    if (values.maxClockKhz !== undefined) {
        const option = JLINK_CLOCK_OPTIONS.find((entry) => entry.khz === values.maxClockKhz);
        if (!option) {
            warnings.push(`不支持的调试时钟：${values.maxClockKhz} kHz`);
        } else {
            const currentSpeed = Number(stringFlag(parsed, '-ZTIFSpeedSel'));
            const currentCode = numberFlag(parsed, '-S');
            if (currentSpeed !== option.khz || currentCode !== option.code) {
                setFlag(parsed, '-S', String(option.code));
                setFlag(parsed, '-ZTIFSpeedSel', String(option.khz));
                changed.push('jlink.maxClock');
            }
        }
    }
    if (values.connect !== undefined) {
        const option = JLINK_CONNECT_OPTIONS.find((entry) => entry.value === values.connect);
        if (option) {
            if (numberFlag(parsed, '-C') !== option.index) {
                setFlag(parsed, '-C', String(option.index));
                changed.push('jlink.connect');
            }
        }
    }
    if (values.reset !== undefined) {
        const option = JLINK_RESET_OPTIONS.find((entry) => entry.value === values.reset);
        if (option) {
            if (numberFlag(parsed, '-RST') !== option.index) {
                setFlag(parsed, '-RST', String(option.index));
                changed.push('jlink.reset');
            }
        }
    }
    if (values.interface !== undefined) {
        const target = values.interface === 'usb' ? 1 : 0;
        if (numberFlag(parsed, '-JU') !== target) {
            setFlag(parsed, '-JU', String(target));
            changed.push('jlink.interface');
        }
    }
    if (values.ip !== undefined) {
        if (stringFlag(parsed, '-JI') !== values.ip) {
            setFlag(parsed, '-JI', values.ip);
            changed.push('jlink.ip');
        }
    }
    if (values.tcpPort !== undefined) {
        if (numberFlag(parsed, '-JP') !== values.tcpPort) {
            setFlag(parsed, '-JP', String(values.tcpPort));
            changed.push('jlink.tcpPort');
        }
    }

    if (changed.length === 0) {
        return { xml: uvoptXml, changed: [], warnings };
    }
    const nextName = serializeFlags(parsed);
    // Replace only this Name element's inner text, preserving the rest byte for byte.
    const source = doc.source;
    const updated = source.slice(0, nameElement.startTagEnd)
        + escapeXmlText(nextName)
        + source.slice(nameElement.innerEnd);
    return { xml: updated, changed, warnings };
}
