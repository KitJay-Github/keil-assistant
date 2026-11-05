/**
 * CMSIS-Pack device database.
 *
 * The "Options for Target" panel offers a device (chip) picker whose list must
 * come from the **local** CMSIS-Pack installation: a `.uvprojx` only stores the
 * device *name* (plus vendor / pack id / CPU string), the memory map, the SVD
 * file and the register header live in the matching `.pdsc` of an installed
 * pack. Everything here is derived from those local files, never from a
 * shipped hard-coded list, because the installed packs differ per machine.
 *
 * Scanning is cheap enough to be done once but far too slow to block the
 * extension host: the real local installation in this repository's CI machine
 * contains ~1700 `.pdsc` files / 130 MB and yields ~10 000 unique devices. The
 * scanner therefore
 * - extracts everything with regular expressions instead of building a DOM,
 * - yields to the event loop every {@link PROGRESS_BATCH_FILES} files,
 * - reports progress and never throws: unreadable files become warnings,
 * - is cached as JSON (see `deviceCatalogService.ts` for the lifetime policy).
 *
 * The write path is a pure string -> string transform on top of the offset
 * preserving XML editor in `src/project/uvXml.ts`, so applying a device only
 * touches the leaf elements of `<TargetCommonOption>` and keeps every other
 * byte of the project file untouched.
 *
 * Supported `.pdsc` shapes (all found in real installations):
 * - `<package vendor="Keil" name="..." version="...">` (root attributes), and
 * - `<package schemaVersion="..."><vendor>Keil</vendor><name>...</name>
 *   <url>...</url><releases><release version="...">` (root child elements, the
 *   common CMSIS-Pack 1.4+ layout, where the version is the newest release),
 * - `<family Dfamily Dvendor><subFamily DsubFamily><device Dname Dcore>`, with
 *   `Dvendor` / `Dcore` inherited from the family, and `Dcore` taken from the
 *   family `<processor Dcore="...">` when the device has no own attribute.
 */
import * as fs from 'fs';
import * as path from 'path';
import { XmlEditor, XmlElement, decodeXmlText, findPath, findTarget, parseXml } from '../uvXml';
import type { OptionEnumValue } from './types';

export interface DeviceEntry {
    /** Dname，如 "STM32F103CB"（唯一 key）。 */
    device: string;
    /** 显示厂商（Dvendor 冒号前部分），如 "STMicroelectronics"。 */
    vendor: string;
    /** 原始 Dvendor，如 "STMicroelectronics:13"。 */
    vendorId?: string;
    /** Dcore，如 "Cortex-M3"。 */
    core?: string;
    family?: string;
    subFamily?: string;
    /** package 属性。 */
    packVendor?: string;
    packName?: string;
    packVersion?: string;
    /** 用于写入 PackID：`${packVendor}.${packName}.${packVersion}`（无 version 时省略）。 */
    packId?: string;
    packUrl?: string;
    /** 来源 pdsc，用于按需补读 memory/svd/header。 */
    pdscPath: string;
}

export interface DevicePackInfo {
    vendor: string;
    name: string;
    version?: string;
    url?: string;
    pdscPath: string;
    deviceCount: number;
}

export interface DeviceCatalog {
    generatedAt: string;
    packRoots: string[];
    devices: DeviceEntry[];
    packs: DevicePackInfo[];
    warnings: string[];
}

export interface DeviceApplyResult {
    xml: string;
    changed: string[];
    warnings: string[];
}

/** First 20000 devices are rendered; the real installation has ~10750. */
const MAX_DEVICE_OPTIONS = 20000;

/** Number of files read between two event loop yields. */
const PROGRESS_BATCH_FILES = 80;

/** Fallback `CLOCK(n)` when neither the project nor a previous device has one. */
const DEFAULT_CLOCK_HZ = 12000000;

/** `<device>` closing tag (device elements never nest). */
const DEVICE_CLOSE_RE = /<\s*\/\s*device\s*>/gi;

/** Match body of an opening tag, honouring quoted attribute values. */
const QUOTED_BODY = `(?:"[^"]*"|'[^']*'|[^>"'])*`;

const PACKAGE_TAG_RE = new RegExp(`<\\s*package\\b(${QUOTED_BODY})>`, 'i');
const VENDOR_ELEMENT_RE = new RegExp(`<\\s*vendor\\s*>([\\s\\S]*?)<\\s*/\\s*vendor\\s*>`, 'i');
const NAME_ELEMENT_RE = new RegExp(`<\\s*name\\s*>([\\s\\S]*?)<\\s*/\\s*name\\s*>`, 'i');
const URL_ELEMENT_RE = new RegExp(`<\\s*url\\s*>([\\s\\S]*?)<\\s*/\\s*url\\s*>`, 'i');
const RELEASE_TAG_RE = new RegExp(`<\\s*release\\b(${QUOTED_BODY})>`, 'i');
const ATTRIBUTE_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Tags that carry the device tree. `<processor>` is included because most real
 * packs declare the core once per family (`<processor Dcore="Cortex-M3"/>`) and
 * leave `Dcore` off the individual `<device>` elements.
 */
const DEVICE_TREE_TAG_RE = new RegExp(`<\\s*(/?)\\s*(family|subFamily|device|processor)\\b(${QUOTED_BODY})>`, 'gi');

const DEVICE_OPEN_TAG_RE = new RegExp(`<\\s*device\\b(${QUOTED_BODY})>`, 'gi');
const MEMORY_TAG_RE = new RegExp(`<\\s*memory\\b(${QUOTED_BODY})\\/?\\s*>`, 'gi');
const DEBUG_TAG_RE = new RegExp(`<\\s*debug\\b(${QUOTED_BODY})\\/?\\s*>`, 'gi');
const COMPILE_TAG_RE = new RegExp(`<\\s*compile\\b(${QUOTED_BODY})\\/?\\s*>`, 'gi');

/** Cores that get the `FPU2` feature flag in a uVision `Cpu` string. */
const FPU2_CORES = new Set(['M4', 'M7', 'M33', 'M35P', 'M55', 'M85']);

/** Cores that get the `DSP` feature flag. */
const DSP_CORES = new Set(['M33', 'M35P', 'M55', 'M85']);

/** Cores that get the `TZ` (TrustZone) feature flag. */
const TZ_CORES = new Set(['M23', 'M33', 'M35P', 'M55', 'M85']);

/** Case-insensitive semantic version comparison: `undefined` sorts first. */
function compareVersions(left: string | undefined, right: string | undefined): number {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    if (leftParts === undefined && rightParts === undefined) {
        return 0;
    }
    if (leftParts === undefined) {
        return -1;
    }
    if (rightParts === undefined) {
        return 1;
    }
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index++) {
        const leftValue = leftParts[index] ?? 0;
        const rightValue = rightParts[index] ?? 0;
        if (leftValue !== rightValue) {
            return leftValue < rightValue ? -1 : 1;
        }
    }
    return 0;
}

function versionParts(version: string | undefined): number[] | undefined {
    if (typeof version !== 'string') {
        return undefined;
    }
    const match = /^\d+(?:\.\d+)*/.exec(version.trim());
    if (!match) {
        return undefined;
    }
    return match[0].split('.').map((part) => Number(part));
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cleanValue(value: string | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function vendorDisplay(vendorId: string | undefined): string | undefined {
    const raw = cleanValue(vendorId);
    if (raw === undefined) {
        return undefined;
    }
    const separator = raw.indexOf(':');
    return cleanValue(separator === -1 ? raw : raw.slice(0, separator));
}

/** Parse the attributes of one opening tag into a lower-cased name map. */
function attributeMap(tagBody: string): Map<string, string> {
    const attributes = new Map<string, string>();
    ATTRIBUTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ATTRIBUTE_RE.exec(tagBody)) !== null) {
        const raw = match[2] !== undefined ? match[2] : match[3];
        attributes.set(match[1].toLowerCase(), decodeXmlText(raw));
    }
    return attributes;
}

function elementText(text: string, pattern: RegExp): string | undefined {
    const match = pattern.exec(text);
    if (!match) {
        return undefined;
    }
    const value = cleanValue(
        decodeXmlText(match[1])
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
    );
    return value;
}

function buildPackId(vendor: string, name: string, version: string | undefined): string | undefined {
    if (vendor.length === 0 || name.length === 0) {
        return undefined;
    }
    return version !== undefined ? `${vendor}.${name}.${version}` : `${vendor}.${name}`;
}

interface PackIdentity {
    vendor: string;
    name: string;
    version?: string;
    url?: string;
}

/**
 * `.../<Vendor>/<Pack>/<version>/<Vendor>.<Pack>.pdsc` -> `version`.
 * `.Download` copies instead carry the version in the file name.
 */
function versionFromDirectory(pdscPath: string): string | undefined {
    const directory = cleanValue(path.basename(path.dirname(pdscPath)));
    if (directory === undefined || !/^\d+(?:\.\d+)*$/.test(directory)) {
        return undefined;
    }
    return directory;
}

function packFileParts(pdscPath: string): { vendor?: string; name?: string; version?: string } {
    const baseName = cleanValue(path.basename(pdscPath).replace(/\.pdsc$/i, ''));
    if (baseName === undefined) {
        return {};
    }
    const withVersion = /^(.+?)\.([^.]+)\.(\d+(?:\.\d+)*)$/.exec(baseName);
    if (withVersion) {
        return { vendor: withVersion[1], name: withVersion[2], version: withVersion[3] };
    }
    const withoutVersion = /^(.+?)\.([^.]+)$/.exec(baseName);
    if (withoutVersion) {
        return { vendor: withoutVersion[1], name: withoutVersion[2] };
    }
    return {};
}

function parsePackIdentity(text: string, pdscPath: string): PackIdentity {
    const packageMatch = PACKAGE_TAG_RE.exec(text);
    const packageAttributes = packageMatch ? attributeMap(packageMatch[1]) : new Map<string, string>();

    let vendor = cleanValue(packageAttributes.get('vendor'));
    let name = cleanValue(packageAttributes.get('name'));
    let version = cleanValue(packageAttributes.get('version'));
    let url = cleanValue(packageAttributes.get('url'));
    const fileParts = packFileParts(pdscPath);

    if (vendor === undefined) {
        vendor = elementText(text, VENDOR_ELEMENT_RE);
    }
    if (name === undefined) {
        name = elementText(text, NAME_ELEMENT_RE);
    }
    if (url === undefined) {
        url = elementText(text, URL_ELEMENT_RE);
    }
    if (version === undefined) {
        // Directory version is the authoritative "installed pack" version.
        version = versionFromDirectory(pdscPath);
    }
    if (version === undefined) {
        const releaseMatch = RELEASE_TAG_RE.exec(text);
        if (releaseMatch) {
            version = cleanValue(attributeMap(releaseMatch[1]).get('version'));
        }
    }
    if (version === undefined) {
        version = cleanValue(fileParts.version);
    }
    if (vendor === undefined) {
        vendor = cleanValue(fileParts.vendor);
    }
    if (name === undefined) {
        name = cleanValue(fileParts.name);
    }

    const identity: PackIdentity = { vendor: vendor ?? '', name: name ?? '' };
    if (version !== undefined) {
        identity.version = version;
    }
    if (url !== undefined) {
        identity.url = url;
    }
    return identity;
}

interface DeviceTreeContext {
    family?: string;
    subFamily?: string;
    familyVendorId?: string;
    inheritedCore?: string;
    pack: DevicePackInfo;
    packId?: string;
}

function createDeviceEntry(
    deviceName: string,
    attributes: Map<string, string>,
    context: DeviceTreeContext
): DeviceEntry {
    const vendorId = cleanValue(attributes.get('dvendor')) ?? context.familyVendorId;
    const vendor = vendorDisplay(vendorId) ?? (context.pack.vendor || 'Unknown');
    const entry: DeviceEntry = { device: deviceName, vendor, pdscPath: context.pack.pdscPath };
    if (vendorId !== undefined) {
        entry.vendorId = vendorId;
    }
    const core = cleanValue(attributes.get('dcore')) ?? context.inheritedCore;
    if (core !== undefined) {
        entry.core = core;
    }
    const family = cleanValue(attributes.get('dfamily')) ?? context.family;
    if (family !== undefined) {
        entry.family = family;
    }
    const subFamily = cleanValue(attributes.get('dsubfamily')) ?? context.subFamily;
    if (subFamily !== undefined) {
        entry.subFamily = subFamily;
    }
    const pack = context.pack;
    if (pack.vendor.length > 0) {
        entry.packVendor = pack.vendor;
    }
    if (pack.name.length > 0) {
        entry.packName = pack.name;
    }
    if (pack.version !== undefined) {
        entry.packVersion = pack.version;
    }
    if (context.packId !== undefined) {
        entry.packId = context.packId;
    }
    if (pack.url !== undefined) {
        entry.packUrl = pack.url;
    }
    return entry;
}

/** 解析一个 .pdsc 文本；畸形内容返回空设备列表，不抛异常。 */
export function parsePdscDevices(
    pdscText: string,
    pdscPath: string
): { pack: DevicePackInfo; devices: DeviceEntry[] } {
    const rawText = typeof pdscText === 'string' ? pdscText : '';
    // Comments in packs often quote device names or XML snippets; drop them
    // before the (otherwise tag-name driven) scan.
    const text = rawText.indexOf('<!--') === -1 ? rawText : rawText.replace(/<!--[\s\S]*?-->/g, '');
    const identity = parsePackIdentity(text, pdscPath);

    const pack: DevicePackInfo = { vendor: identity.vendor, name: identity.name, pdscPath, deviceCount: 0 };
    if (identity.version !== undefined) {
        pack.version = identity.version;
    }
    if (identity.url !== undefined) {
        pack.url = identity.url;
    }

    const packId = buildPackId(identity.vendor, identity.name, identity.version);
    const devices: DeviceEntry[] = [];

    let family: string | undefined;
    let subFamily: string | undefined;
    let familyVendorId: string | undefined;
    let inheritedCore: string | undefined;
    let insideDevice = false;

    DEVICE_TREE_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DEVICE_TREE_TAG_RE.exec(text)) !== null) {
        const closing = match[1] === '/';
        const tagName = match[2].toLowerCase();
        const body = match[3];

        if (closing) {
            if (tagName === 'device') {
                insideDevice = false;
            } else if (tagName === 'subfamily') {
                subFamily = undefined;
                insideDevice = false;
            } else if (tagName === 'family') {
                family = undefined;
                subFamily = undefined;
                familyVendorId = undefined;
                inheritedCore = undefined;
                insideDevice = false;
            }
            continue;
        }

        const attributes = attributeMap(body);
        if (tagName === 'family') {
            family = cleanValue(attributes.get('dfamily'));
            familyVendorId = cleanValue(attributes.get('dvendor'));
            subFamily = undefined;
            inheritedCore = undefined;
            insideDevice = false;
            continue;
        }
        if (tagName === 'subfamily') {
            subFamily = cleanValue(attributes.get('dsubfamily'));
            insideDevice = false;
            continue;
        }
        if (tagName === 'processor') {
            // Only the core declared outside of `<device>` is inherited.
            if (!insideDevice) {
                const core = cleanValue(attributes.get('dcore'));
                if (core !== undefined) {
                    inheritedCore = core;
                }
            }
            continue;
        }

        // <device>
        if (insideDevice) {
            // A nested `<device>` is not part of the CMSIS-Pack schema.
            continue;
        }
        insideDevice = !/\/\s*$/.test(body);
        const deviceName = cleanValue(attributes.get('dname'));
        if (deviceName === undefined) {
            continue;
        }
        devices.push(
            createDeviceEntry(deviceName, attributes, {
                family,
                subFamily,
                familyVendorId,
                inheritedCore,
                pack,
                packId
            })
        );
    }

    pack.deviceCount = devices.length;
    return { pack, devices };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function deviceContextScore(entry: DeviceEntry): number {
    let score = 0;
    if (entry.family !== undefined) {
        score += 1;
    }
    if (entry.subFamily !== undefined) {
        score += 1;
    }
    if (entry.vendorId !== undefined) {
        score += 1;
    }
    if (entry.core !== undefined) {
        score += 1;
    }
    return score;
}

/**
 * True for uVision's pack caches (`.Download`, `.Web`, `.Local`). Those `.pdsc`
 * files describe packs that are *not* installed: `.Web` even describes the
 * newest available version of every known pack. A `PackID` written into a
 * project must reference an installed pack, so these copies must never shadow
 * an installed one.
 */
function isCachePackPath(pdscPath: string): boolean {
    const segments = pdscPath.toLowerCase().split(/[\\/]+/);
    return segments.some((segment) => segment === '.download' || segment === '.web' || segment === '.local');
}

function preferCandidate(candidate: DeviceEntry, existing: DeviceEntry): boolean {
    // 1. An installed pack always wins over a cached pack description.
    const candidateCached = isCachePackPath(candidate.pdscPath);
    const existingCached = isCachePackPath(existing.pdscPath);
    if (candidateCached !== existingCached) {
        return !candidateCached;
    }
    // 2. When both are installed from several versions, the newer one wins.
    const byVersion = compareVersions(candidate.packVersion, existing.packVersion);
    if (byVersion !== 0) {
        return byVersion > 0;
    }
    // 3. Prefer the entry that carries the richest family/sub-family context.
    const candidateScore = deviceContextScore(candidate);
    const existingScore = deviceContextScore(existing);
    if (candidateScore !== existingScore) {
        return candidateScore > existingScore;
    }
    return false;
}

function mergeDevice(devicesByName: Map<string, DeviceEntry>, device: DeviceEntry): void {
    const key = device.device.toLowerCase();
    const existing = devicesByName.get(key);
    if (existing === undefined) {
        devicesByName.set(key, device);
        return;
    }
    if (preferCandidate(device, existing)) {
        devicesByName.set(key, device);
    }
}

function packKey(pack: DevicePackInfo): string {
    const identity = `${pack.vendor}.${pack.name}.${pack.version ?? ''}`.toLowerCase();
    return identity.length > 0 ? identity : pack.pdscPath.toLowerCase();
}

function registerPack(
    packsById: Map<string, DevicePackInfo>,
    pack: DevicePackInfo,
    warnings: string[],
    pdscPath: string
): void {
    if (pack.vendor.length === 0 && pack.name.length === 0) {
        warnings.push(`无法从设备描述文件解析 Pack 信息：${pdscPath}`);
        return;
    }
    const key = packKey(pack);
    const existing = packsById.get(key);
    if (existing === undefined) {
        packsById.set(key, pack);
        return;
    }
    // Keep the installed copy over a cached description of the same pack.
    if (isCachePackPath(existing.pdscPath) && !isCachePackPath(pack.pdscPath)) {
        packsById.set(key, pack);
        return;
    }
    if (isCachePackPath(existing.pdscPath) === isCachePackPath(pack.pdscPath)
        && pack.deviceCount > existing.deviceCount) {
        packsById.set(key, pack);
    }
}

function compareText(left: string, right: string): number {
    const normalizedLeft = left.toLowerCase();
    const normalizedRight = right.toLowerCase();
    if (normalizedLeft < normalizedRight) {
        return -1;
    }
    if (normalizedLeft > normalizedRight) {
        return 1;
    }
    return 0;
}

function comparePacks(left: DevicePackInfo, right: DevicePackInfo): number {
    const byVendor = compareText(left.vendor, right.vendor);
    if (byVendor !== 0) {
        return byVendor;
    }
    const byName = compareText(left.name, right.name);
    if (byName !== 0) {
        return byName;
    }
    return compareVersions(left.version, right.version);
}

function collectPdscFiles(directory: string, files: string[], warnings: string[], depth = 0): void {
    if (depth > 12) {
        return;
    }
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
        warnings.push(`无法读取 Pack 目录 ${directory}：${describeError(error)}`);
        return;
    }
    entries.sort((left, right) => compareText(left.name, right.name));

    const subDirectories: string[] = [];
    for (const entry of entries) {
        if (entry.isSymbolicLink()) {
            // Symbolic links can form cycles; packs never need them.
            continue;
        }
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            subDirectories.push(fullPath);
            continue;
        }
        if (/\.pdsc$/i.test(entry.name)) {
            files.push(fullPath);
        }
    }
    for (const subDirectory of subDirectories) {
        collectPdscFiles(subDirectory, files, warnings, depth + 1);
    }
}

function yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => {
        setImmediate(resolve);
    });
}

function reportProgress(
    onProgress: ((done: number, total: number) => void) | undefined,
    done: number,
    total: number
): void {
    if (!onProgress) {
        return;
    }
    try {
        onProgress(done, total);
    } catch {
        // A broken progress callback must not abort the scan.
    }
}

/**
 * 扫描 Pack 根目录下所有 .pdsc（递归）。
 * - 纯正则提取，不构造完整 DOM；
 * - 按 device 名去重：已安装的 Pack 优先于 `.Download`/`.Web`/`.Local` 缓存；
 *   同类中优先保留「版本较新」的包（比较语义化版本）与 `vendor`/`devices` 内
 *   上下文（family/subFamily/vendorId）更完整的条目；
 * - 每处理约 80 个文件 `await new Promise(r => setImmediate(r))` 让出事件循环；
 * - 不可读文件计入 warnings；全程不抛异常。
 */
export async function scanDeviceCatalog(
    packRoots: string[],
    onProgress?: (done: number, total: number) => void
): Promise<DeviceCatalog> {
    const warnings: string[] = [];
    const roots: string[] = [];
    const seenRoots = new Set<string>();
    const requestedRoots = Array.isArray(packRoots) ? packRoots : [];
    for (const rawRoot of requestedRoots) {
        if (typeof rawRoot !== 'string') {
            continue;
        }
        const trimmed = rawRoot.trim();
        if (trimmed.length === 0) {
            continue;
        }
        const resolved = path.resolve(trimmed);
        const key = resolved.toLowerCase();
        if (seenRoots.has(key)) {
            continue;
        }
        seenRoots.add(key);
        roots.push(resolved);
    }

    const files: string[] = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) {
            warnings.push(`Pack 根目录不存在：${root}`);
            continue;
        }
        collectPdscFiles(root, files, warnings);
    }

    const total = files.length;
    reportProgress(onProgress, 0, total);

    const devicesByName = new Map<string, DeviceEntry>();
    const packsById = new Map<string, DevicePackInfo>();
    let processed = 0;

    for (const file of files) {
        let text: string | undefined;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch (error) {
            warnings.push(`无法读取设备描述文件 ${file}：${describeError(error)}`);
        }
        if (text !== undefined) {
            try {
                const parsed = parsePdscDevices(text, file);
                registerPack(packsById, parsed.pack, warnings, file);
                for (const device of parsed.devices) {
                    mergeDevice(devicesByName, device);
                }
            } catch (error) {
                warnings.push(`无法解析设备描述文件 ${file}：${describeError(error)}`);
            }
        }

        processed++;
        reportProgress(onProgress, processed, total);
        if (processed % PROGRESS_BATCH_FILES === 0) {
            await yieldToEventLoop();
        }
    }

    const devices = Array.from(devicesByName.values());
    const packs = Array.from(packsById.values()).sort(comparePacks);
    return {
        generatedAt: new Date().toISOString(),
        packRoots: roots,
        devices,
        packs,
        warnings
    };
}

// ---------------------------------------------------------------------------
// Pack roots
// ---------------------------------------------------------------------------

const RTEPATH_RE = /^\s*RTEPATH\s*=\s*"?([^"\r\n]*)"?/gim;

/** Expand `%VAR%` references written in `TOOLS.INI` (e.g. `%LOCALAPPDATA%`). */
function expandEnvironmentVariables(value: string): string {
    return value.replace(/%([^%]+)%/g, (whole, name: string) => {
        const replacement = process.env[name];
        return replacement === undefined ? whole : replacement;
    });
}

function appendRoot(candidate: string, roots: string[], seen: Set<string>): void {
    const trimmed = candidate.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) {
        return;
    }
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) {
        return;
    }
    seen.add(key);
    roots.push(resolved);
}

/** 解析 TOOLS.INI 的 RTEPATH 并回退常见目录，返回实际存在的 Pack 根目录列表。 */
export function resolvePackRoots(toolsIniText: string | undefined, keilRoot: string | undefined): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();

    if (typeof toolsIniText === 'string' && toolsIniText.length > 0) {
        RTEPATH_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = RTEPATH_RE.exec(toolsIniText)) !== null) {
            const value = cleanValue(expandEnvironmentVariables(match[1]));
            if (value === undefined) {
                continue;
            }
            for (const part of value.split(';')) {
                appendRoot(part, roots, seen);
            }
        }
    }

    if (roots.length > 0) {
        return roots;
    }

    // No usable RTEPATH: fall back to the conventional locations.
    const localAppData = cleanValue(process.env.LOCALAPPDATA);
    if (localAppData !== undefined) {
        appendRoot(path.join(localAppData, 'Arm', 'Packs'), roots, seen);
    }
    if (typeof keilRoot === 'string' && keilRoot.trim().length > 0) {
        appendRoot(path.join(keilRoot.trim(), 'PACK'), roots, seen);
    }
    return roots;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isDeviceEntry(value: unknown): value is DeviceEntry {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.device === 'string'
        && value.device.length > 0
        && typeof value.vendor === 'string'
        && typeof value.pdscPath === 'string';
}

function isPackInfo(value: unknown): value is DevicePackInfo {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.vendor === 'string'
        && typeof value.name === 'string'
        && typeof value.pdscPath === 'string'
        && typeof value.deviceCount === 'number';
}

function catalogFromJson(raw: unknown): DeviceCatalog | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }
    if (typeof raw.generatedAt !== 'string' || !Array.isArray(raw.devices) || !Array.isArray(raw.packs)) {
        return undefined;
    }
    const devices = raw.devices.filter(isDeviceEntry);
    const packs = raw.packs.filter(isPackInfo);
    if (devices.length === 0 && raw.devices.length > 0) {
        return undefined;
    }
    return {
        generatedAt: raw.generatedAt,
        packRoots: isStringArray(raw.packRoots) ? raw.packRoots : [],
        devices,
        packs,
        warnings: isStringArray(raw.warnings) ? raw.warnings : []
    };
}

/** 只读取（不扫描）已有缓存；文件不存在/损坏返回 undefined。 */
export function readCachedCatalog(cacheFile: string): DeviceCatalog | undefined {
    try {
        const text = fs.readFileSync(cacheFile, 'utf8');
        return catalogFromJson(JSON.parse(text) as unknown);
    } catch {
        return undefined;
    }
}

/** 原子写缓存（临时文件 + rename）。 */
export function writeCachedCatalog(cacheFile: string, catalog: DeviceCatalog): void {
    const directory = path.dirname(cacheFile);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryFile = path.join(
        directory,
        `.${path.basename(cacheFile)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
        fs.writeFileSync(temporaryFile, JSON.stringify(catalog), 'utf8');
        fs.renameSync(temporaryFile, cacheFile);
    } catch (error) {
        try {
            fs.unlinkSync(temporaryFile);
        } catch {
            // The temporary file may not exist.
        }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function packDisplayName(entry: DeviceEntry): string {
    if (entry.packVendor && entry.packName) {
        return `${entry.packVendor}.${entry.packName}`;
    }
    return entry.packName || entry.packVendor || '';
}

/** `STM32F103CB（STMicroelectronics / Keil.STM32F1xx_DFP）`, or just the name. */
function deviceLabel(entry: DeviceEntry): string {
    const pack = packDisplayName(entry);
    const suffix = pack.length > 0 ? `${entry.vendor} / ${pack}` : entry.vendor;
    return suffix.length > 0 ? `${entry.device}（${suffix}）` : entry.device;
}

function compareDevices(left: DeviceEntry, right: DeviceEntry): number {
    const byVendor = compareText(left.vendor, right.vendor);
    if (byVendor !== 0) {
        return byVendor;
    }
    const byDevice = compareText(left.device, right.device);
    if (byDevice !== 0) {
        return byDevice;
    }
    return compareText(packDisplayName(left), packDisplayName(right));
}

/**
 * 面板下拉选项：value = device 名；label 形如
 * `STM32F103CB（STMicroelectronics / Keil.STM32F1xx_DFP）`；按 vendor+device
 * 排序；超过 20000 个时截断并在末尾加提示项（value 仍为设备名）。
 *
 * When no catalog is available (still scanning / no local packs) only the
 * currently stored device is returned, so the panel never shows an empty picker.
 */
export function deviceOptions(
    catalog: DeviceCatalog | undefined,
    currentDevice?: string
): OptionEnumValue[] {
    const current = cleanValue(currentDevice);
    if (catalog === undefined) {
        return current === undefined ? [] : [{ value: current, label: `${current}（当前型号）` }];
    }

    const options: OptionEnumValue[] = [];
    const devices = catalog.devices.slice().sort(compareDevices);
    const currentLower = (current ?? '').toLowerCase();
    const currentKnown = current !== undefined
        && devices.some((entry) => entry.device.toLowerCase() === currentLower);
    if (current !== undefined && !currentKnown) {
        options.push({ value: current, label: `${current}（当前型号，未在本机 Pack 中找到）` });
    }

    const visible = devices.slice(0, MAX_DEVICE_OPTIONS);
    for (const entry of visible) {
        options.push({ value: entry.device, label: deviceLabel(entry) });
    }

    if (devices.length > MAX_DEVICE_OPTIONS) {
        // The hint keeps a device name as value (see the contract), so selecting
        // it stays a no-op instead of writing an arbitrary string into Device.
        const fallbackValue = current !== undefined && currentKnown
            ? current
            : (visible.length > 0 ? visible[0].device : (current ?? ''));
        options.push({
            value: fallbackValue,
            label: `（器件过多：共 ${devices.length} 个，仅显示前 ${MAX_DEVICE_OPTIONS} 个）`
        });
    }
    return options;
}

/** 按设备名查找（大小写不敏感）。 */
export function findDevice(
    catalog: DeviceCatalog | undefined,
    deviceName: string | undefined
): DeviceEntry | undefined {
    if (catalog === undefined) {
        return undefined;
    }
    const wanted = cleanValue(deviceName);
    if (wanted === undefined) {
        return undefined;
    }
    const wantedLower = wanted.toLowerCase();
    return catalog.devices.find((entry) => entry.device.toLowerCase() === wantedLower);
}

// ---------------------------------------------------------------------------
// On-demand details (memory / SVD / header)
// ---------------------------------------------------------------------------

interface MemoryAttribute {
    id?: string;
    type?: string;
    start?: number;
    size?: number;
}

interface DeviceDetails {
    flash?: { start: number; size: number };
    ram?: { start: number; size: number };
    svd?: string;
    header?: string;
    warnings: string[];
}

const detailsCache = new Map<string, DeviceDetails>();

function parseNumericAttribute(value: string | undefined): number | undefined {
    const text = cleanValue(value);
    if (text === undefined) {
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

function deviceDetailsCacheKey(entry: DeviceEntry): string {
    return `${entry.pdscPath.toLowerCase()}|${entry.device.toLowerCase()}`;
}

/** Inner XML of one `<device Dname="...">` block, or `undefined` when absent. */
function findDeviceBlock(text: string, deviceName: string): string | undefined {
    const wanted = deviceName.trim().toLowerCase();
    DEVICE_OPEN_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DEVICE_OPEN_TAG_RE.exec(text)) !== null) {
        const body = match[1];
        const device = cleanValue(attributeMap(body).get('dname'));
        if (device === undefined || device.toLowerCase() !== wanted) {
            continue;
        }
        if (/\/\s*$/.test(body)) {
            return '';
        }
        const innerStart = match.index + match[0].length;
        DEVICE_CLOSE_RE.lastIndex = innerStart;
        const closeMatch = DEVICE_CLOSE_RE.exec(text);
        return closeMatch ? text.slice(innerStart, closeMatch.index) : text.slice(innerStart);
    }
    return undefined;
}

function parseMemories(block: string): MemoryAttribute[] {
    const memories: MemoryAttribute[] = [];
    MEMORY_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MEMORY_TAG_RE.exec(block)) !== null) {
        const attributes = attributeMap(match[1]);
        const memory: MemoryAttribute = {
            id: cleanValue(attributes.get('id')) ?? cleanValue(attributes.get('name')),
            type: cleanValue(attributes.get('type')),
            start: parseNumericAttribute(attributes.get('start')),
            size: parseNumericAttribute(attributes.get('size'))
        };
        if (memory.start !== undefined && memory.size !== undefined && memory.size > 0) {
            memories.push(memory);
        }
    }
    return memories;
}

function isFlashMemory(memory: MemoryAttribute): boolean {
    const type = (memory.type ?? '').toLowerCase();
    if (type.indexOf('flash') !== -1) {
        return true;
    }
    if (type.indexOf('ram') !== -1) {
        return false;
    }
    const id = (memory.id ?? '').toUpperCase();
    return id.indexOf('ROM') !== -1 || id.indexOf('FLASH') !== -1;
}

function isRamMemory(memory: MemoryAttribute): boolean {
    const type = (memory.type ?? '').toLowerCase();
    if (type.indexOf('ram') !== -1) {
        return true;
    }
    if (type.indexOf('flash') !== -1) {
        return false;
    }
    return (memory.id ?? '').toUpperCase().indexOf('RAM') !== -1;
}

function firstTagAttribute(block: string, tagPattern: RegExp, attributeName: string): string | undefined {
    tagPattern.lastIndex = 0;
    const match = tagPattern.exec(block);
    if (!match) {
        return undefined;
    }
    return cleanValue(attributeMap(match[1]).get(attributeName));
}

function loadDeviceDetails(entry: DeviceEntry): DeviceDetails {
    const details: DeviceDetails = { warnings: [] };
    let text: string;
    try {
        text = fs.readFileSync(entry.pdscPath, 'utf8');
    } catch (error) {
        details.warnings.push(`无法读取设备描述文件 ${entry.pdscPath}：${describeError(error)}`);
        return details;
    }

    const cleanText = text.indexOf('<!--') === -1 ? text : text.replace(/<!--[\s\S]*?-->/g, '');
    const block = findDeviceBlock(cleanText, entry.device);
    if (block === undefined) {
        details.warnings.push(`设备 ${entry.device} 在 ${entry.pdscPath} 中未找到`);
        return details;
    }

    const memories = parseMemories(block);
    const flash = memories.find(isFlashMemory);
    if (flash !== undefined && flash.start !== undefined && flash.size !== undefined) {
        details.flash = { start: flash.start, size: flash.size };
    }
    const ram = memories.find(isRamMemory);
    if (ram !== undefined && ram.start !== undefined && ram.size !== undefined) {
        details.ram = { start: ram.start, size: ram.size };
    }

    const svd = firstTagAttribute(block, DEBUG_TAG_RE, 'svd');
    if (svd !== undefined) {
        details.svd = svd;
    }
    const header = firstTagAttribute(block, COMPILE_TAG_RE, 'header');
    if (header !== undefined) {
        details.header = header;
    }
    return details;
}

function cloneDetails(details: DeviceDetails): DeviceDetails {
    const clone: DeviceDetails = { warnings: details.warnings.slice() };
    if (details.flash !== undefined) {
        clone.flash = { start: details.flash.start, size: details.flash.size };
    }
    if (details.ram !== undefined) {
        clone.ram = { start: details.ram.start, size: details.ram.size };
    }
    if (details.svd !== undefined) {
        clone.svd = details.svd;
    }
    if (details.header !== undefined) {
        clone.header = details.header;
    }
    return clone;
}

/** 按需从 pdsc 补读该设备的 memory/svd/header（结果缓存到内存 Map）。 */
export function readDeviceDetails(entry: DeviceEntry): DeviceDetails {
    const key = deviceDetailsCacheKey(entry);
    const cached = detailsCache.get(key);
    if (cached !== undefined) {
        return cloneDetails(cached);
    }
    const details = loadDeviceDetails(entry);
    detailsCache.set(key, details);
    return cloneDetails(details);
}

// ---------------------------------------------------------------------------
// Cpu string / project write path
// ---------------------------------------------------------------------------

/** `IRAM(0x20000000-0x20004FFF)` - the inclusive range form uVision writes. */
function formatMemoryToken(name: string, region: { start: number; size: number }): string {
    const lastAddress = region.start + region.size - 1;
    return `${name}(0x${region.start.toString(16)}-0x${lastAddress.toString(16)})`;
}

/** Copy an existing `IROM(...)` / `IRAM(...)` token out of a `Cpu` string. */
function extractCpuToken(cpuText: string, name: string): string | undefined {
    const match = new RegExp(`(?:^|\\s)(${name}\\s*\\([^()]*\\))`, 'i').exec(cpuText);
    return match ? match[1] : undefined;
}

/** `CLOCK(8000000)` -> `8000000`. */
function extractClock(cpuText: string): string | undefined {
    const match = /CLOCK\s*\(\s*([0-9]+)\s*\)/i.exec(cpuText);
    return match ? match[1] : undefined;
}

/** `CPUTYPE("Cortex-M3")` -> `Cortex-M3`. */
function extractCore(cpuText: string): string | undefined {
    const match = /CPUTYPE\s*\(\s*"([^"]*)"\s*\)/i.exec(cpuText);
    if (match) {
        return cleanValue(match[1]);
    }
    const unquoted = /CPUTYPE\s*\(\s*([^()]*?)\s*\)/i.exec(cpuText);
    return unquoted ? cleanValue(unquoted[1].replace(/^["']|["']$/g, '')) : undefined;
}

/** `Cortex-M33` -> `M33`, `Cortex-M35P` -> `M35P`; `undefined` for non Cortex-M. */
function cortexMCoreName(core: string | undefined): string | undefined {
    if (core === undefined) {
        return undefined;
    }
    const match = /CORTEX-M(\d+[A-Z]*)/i.exec(core);
    return match ? `M${match[1].toUpperCase()}` : undefined;
}

function isArmCore(core: string | undefined): boolean {
    return core !== undefined && /CORTEX|ARM/i.test(core);
}

/** 由设备信息构造 uVision 的 Cpu 字符串；保留当前 CLOCK(n)，无线索时默认 12000000。 */
export function buildCpuString(entry: DeviceEntry, currentCpu: string | undefined): string {
    const details = readDeviceDetails(entry);
    const current = typeof currentCpu === 'string' ? currentCpu : '';
    const segments: string[] = [];

    const ramToken = details.ram !== undefined
        ? formatMemoryToken('IRAM', details.ram)
        : extractCpuToken(current, 'IRAM');
    if (ramToken !== undefined) {
        segments.push(ramToken);
    }
    const flashToken = details.flash !== undefined
        ? formatMemoryToken('IROM', details.flash)
        : extractCpuToken(current, 'IROM');
    if (flashToken !== undefined) {
        segments.push(flashToken);
    }

    const core = cleanValue(entry.core) ?? extractCore(current);
    if (core !== undefined) {
        segments.push(`CPUTYPE("${core}")`);
        const coreName = cortexMCoreName(core);
        if (coreName !== undefined) {
            if (FPU2_CORES.has(coreName)) {
                segments.push('FPU2');
            }
            if (DSP_CORES.has(coreName)) {
                segments.push('DSP');
            }
            if (TZ_CORES.has(coreName)) {
                segments.push('TZ');
            }
        }
    }

    segments.push(`CLOCK(${extractClock(current) ?? String(DEFAULT_CLOCK_HZ)})`);
    if (isArmCore(core)) {
        segments.push('ELITTLE');
    }
    return segments.join(' ');
}

interface TargetFieldWriter {
    write(id: string, tagName: string, value: string): void;
}

/**
 * 把设备写入 .uvprojx 的 `<Target>/<TargetOption>/<TargetCommonOption>`：
 * - Device、Vendor、PackID、PackURL、Cpu 必写（无 pack 信息时保留原 PackID/PackURL 并 warning）；
 * - 若 pdsc 提供 svd/header，则同时更新 SFDFile/RegisterFile（格式 `$$Device:NAME$<路径反斜杠>`）；
 * - 目标不存在或 XML 不可解析 → 抛 Error；设备不在 catalog 中 → 抛 Error；
 * - 未变化时返回原文本（逐字节不变）；`changed` 形如
 *   `['target.device','target.vendor','target.packId','target.cpu']`。
 */
export function applyDeviceSelection(
    xml: string,
    targetName: string,
    deviceName: string,
    catalog: DeviceCatalog | undefined
): DeviceApplyResult {
    let currentXml = xml;
    let doc = parseXml(currentXml);
    let target = findTarget(doc.root, targetName);
    if (target === undefined) {
        throw new Error(`目标不存在：${targetName}`);
    }
    const entry = findDevice(catalog, deviceName);
    if (entry === undefined) {
        throw new Error(`设备不在设备清单中：${deviceName}（请刷新本机 CMSIS-Pack 设备列表）`);
    }

    const commonOptionPath = ['TargetOption', 'TargetCommonOption'];
    // `XmlEditor` computes its edits against a frozen DOM, so creating two
    // children below the same *missing* container in one pass would emit the
    // container twice. Create the container first, then write its leaves.
    if (findPath(target, commonOptionPath) === undefined) {
        const creationEditor = new XmlEditor(doc);
        creationEditor.ensureContainerAt(target, commonOptionPath);
        currentXml = creationEditor.apply();
        doc = parseXml(currentXml);
        const reparsed = findTarget(doc.root, targetName);
        if (reparsed === undefined) {
            throw new Error(`目标不存在：${targetName}`);
        }
        target = reparsed;
    }

    const warnings: string[] = [];
    const changed: string[] = [];
    const targetElement: XmlElement = target;
    const editor = new XmlEditor(doc);
    const writer: TargetFieldWriter = {
        write(id: string, tagName: string, value: string): void {
            if (editor.setTextAt(targetElement, commonOptionPath.concat(tagName), value) !== 'unchanged') {
                changed.push(id);
            }
        }
    };

    writer.write('target.device', 'Device', entry.device);
    if (entry.vendor.length > 0) {
        writer.write('target.vendor', 'Vendor', entry.vendor);
    } else {
        warnings.push(`器件 ${entry.device} 缺少厂商信息，已保留原 Vendor`);
    }
    if (entry.packId !== undefined) {
        writer.write('target.packId', 'PackID', entry.packId);
    } else {
        warnings.push(`器件 ${entry.device} 缺少 Pack 信息，已保留原 PackID`);
    }
    if (entry.packUrl !== undefined) {
        writer.write('target.packUrl', 'PackURL', entry.packUrl);
    } else {
        warnings.push(`器件 ${entry.device} 缺少 Pack 下载地址，已保留原 PackURL`);
    }

    const currentCpu = editor.textAt(target, commonOptionPath.concat('Cpu'));
    writer.write('target.cpu', 'Cpu', buildCpuString(entry, currentCpu));

    const details = readDeviceDetails(entry);
    warnings.push(...details.warnings);
    const devicePrefix = `$$Device:${entry.device}$`;
    if (details.svd !== undefined) {
        writer.write('target.sfdFile', 'SFDFile', `${devicePrefix}${details.svd.replace(/\//g, '\\')}`);
    }
    if (details.header !== undefined) {
        writer.write(
            'target.registerFile',
            'RegisterFile',
            `${devicePrefix}${details.header.replace(/\//g, '\\')}`
        );
    }

    return { xml: editor.apply(), changed, warnings };
}
