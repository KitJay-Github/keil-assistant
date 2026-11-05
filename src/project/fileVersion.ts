/**
 * Read the `FileVersion` string from a Windows PE file's VERSIONINFO resource.
 *
 * The options panel uses this to show the debugger / download algorithm /
 * uVision versions. The parser is dependency-free (only `fs` and
 * `child_process`) and defensive: every buffer read is bounds-checked and any
 * malformed file yields `undefined` instead of throwing.
 *
 * Layout walked by the parser:
 *   DOS header (`MZ`, e_lfanew @ 0x3C)
 *   -> PE signature (`PE\0\0`)
 *   -> COFF header (NumberOfSections @ +2, SizeOfOptionalHeader @ +16)
 *   -> Optional header magic (0x10B = PE32, 0x20B = PE32+)
 *   -> DataDirectory[2] = resource RVA/size
 *   -> section table (RVA -> file offset)
 *   -> resource directory tree: type id 16 (RT_VERSION) -> name -> language
 *   -> IMAGE_RESOURCE_DATA_ENTRY -> VS_VERSIONINFO blocks
 *   -> StringFileInfo -> language block -> FileVersion / ProductVersion.
 */

import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Resource type id of RT_VERSION. */
const RT_VERSION = 16;
const RESOURCE_DIRECTORY_INDEX = 2;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const PE32_DATA_DIRECTORY_OFFSET = 96;
const PE32_PLUS_DATA_DIRECTORY_OFFSET = 112;
const PE_SIGNATURE = 0x00004550;
const MAX_PE_SECTIONS = 96;
const MAX_RESOURCE_DIRECTORY_ENTRIES = 4096;
/** Total entry budget for one RT_VERSION lookup, guarding against cyclic/bogus trees. */
const MAX_RESOURCE_SEARCH_ENTRIES = 4096;
const MAX_RESOURCE_DIRECTORY_DEPTH = 4;
const MAX_VERSION_CHILDREN = 256;
const POWERSHELL_TIMEOUT_MS = 3000;

const VERSION_INFO_KEY = 'VS_VERSION_INFO';
const STRING_FILE_INFO_KEY = 'STRINGFILEINFO';
const FILE_VERSION_KEY = 'FILEVERSION';
const PRODUCT_VERSION_KEY = 'PRODUCTVERSION';

interface SectionInfo {
    virtualAddress: number;
    virtualSize: number;
    sizeOfRawData: number;
    pointerToRawData: number;
}

interface ResourceDirectoryEntry {
    /** True when the Name field points at a name string instead of a numeric id. */
    named: boolean;
    /** Numeric id (meaningful only when `named` is false). */
    id: number;
    /** True when OffsetToData is another directory instead of a data entry. */
    directory: boolean;
    /** Offset relative to the start of the resource directory tree. */
    offset: number;
}

interface ResourceSearchBudget {
    /** Remaining directory entries that may be inspected. */
    entriesLeft: number;
    /** Absolute offsets of directories already visited (cycle protection). */
    visited: Set<number>;
}

interface VersionInfoRecord {
    /** wLength: total bytes of this block, padding excluded. */
    length: number;
    /** wValueLength: bytes for binary values, UTF-16 code units for text values. */
    valueLength: number;
    /** wType: 0 = binary, 1 = text. */
    type: number;
    /** szKey decoded from UTF-16LE. */
    key: string;
    /** Absolute offset of the Value member. */
    valueOffset: number;
    /** Absolute end of the Value member (clamped to the block). */
    valueEnd: number;
    /** Absolute offset of the first child block. */
    childrenOffset: number;
    /** Absolute end of this block (clamped to the parent). */
    end: number;
}

interface VersionCacheEntry {
    mtimeMs: number;
    value: string | undefined;
}

const versionCache = new Map<string, VersionCacheEntry>();

function readUInt16LE(buffer: Buffer, offset: number): number | undefined {
    if (offset < 0 || offset + 2 > buffer.length) {
        return undefined;
    }
    return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer: Buffer, offset: number): number | undefined {
    if (offset < 0 || offset + 4 > buffer.length) {
        return undefined;
    }
    return buffer.readUInt32LE(offset);
}

/** Round `value` up to the next 4-byte boundary. */
function align4(value: number): number {
    return (value + 3) & ~3;
}

function rvaToFileOffset(rva: number, sections: SectionInfo[]): number | undefined {
    for (const section of sections) {
        const span = Math.max(section.virtualSize, section.sizeOfRawData);
        if (rva < section.virtualAddress || rva >= section.virtualAddress + span) {
            continue;
        }
        const delta = rva - section.virtualAddress;
        if (delta >= section.sizeOfRawData) {
            // Points into the zero-filled tail of the section, which has no file data.
            return undefined;
        }
        return section.pointerToRawData + delta;
    }
    return undefined;
}

function readResourceDirectory(
    buffer: Buffer,
    directoryOffset: number,
    resourceRootOffset: number,
    resourceEnd: number
): ResourceDirectoryEntry[] | undefined {
    if (directoryOffset < resourceRootOffset || directoryOffset + 16 > resourceEnd) {
        return undefined;
    }
    const namedCount = readUInt16LE(buffer, directoryOffset + 12);
    const idCount = readUInt16LE(buffer, directoryOffset + 14);
    if (namedCount === undefined || idCount === undefined) {
        return undefined;
    }
    const entryCount = namedCount + idCount;
    if (entryCount > MAX_RESOURCE_DIRECTORY_ENTRIES) {
        return undefined;
    }
    const entries: ResourceDirectoryEntry[] = [];
    for (let index = 0; index < entryCount; index++) {
        const entryOffset = directoryOffset + 16 + index * 8;
        if (entryOffset + 8 > resourceEnd) {
            return undefined;
        }
        const nameField = readUInt32LE(buffer, entryOffset);
        const dataField = readUInt32LE(buffer, entryOffset + 4);
        if (nameField === undefined || dataField === undefined) {
            return undefined;
        }
        entries.push({
            named: (nameField & 0x80000000) !== 0,
            id: nameField & 0x7fffffff,
            directory: (dataField & 0x80000000) !== 0,
            offset: dataField & 0x7fffffff
        });
    }
    return entries;
}

/** Walk a resource directory subtree and return the first data entry found. */
function findFirstResourceData(
    buffer: Buffer,
    directoryOffset: number,
    resourceRootOffset: number,
    resourceEnd: number,
    sections: SectionInfo[],
    depth: number,
    budget: ResourceSearchBudget
): Buffer | undefined {
    if (depth > MAX_RESOURCE_DIRECTORY_DEPTH || budget.entriesLeft <= 0) {
        return undefined;
    }
    if (budget.visited.has(directoryOffset)) {
        return undefined;
    }
    budget.visited.add(directoryOffset);

    const entries = readResourceDirectory(buffer, directoryOffset, resourceRootOffset, resourceEnd);
    if (entries === undefined) {
        return undefined;
    }
    budget.entriesLeft -= entries.length;
    for (const entry of entries) {
        if (budget.entriesLeft <= 0) {
            return undefined;
        }
        if (entry.directory) {
            const nested = findFirstResourceData(
                buffer,
                resourceRootOffset + entry.offset,
                resourceRootOffset,
                resourceEnd,
                sections,
                depth + 1,
                budget
            );
            if (nested !== undefined) {
                return nested;
            }
            continue;
        }
        const dataEntryOffset = resourceRootOffset + entry.offset;
        if (dataEntryOffset + 8 > resourceEnd) {
            continue;
        }
        const dataRva = readUInt32LE(buffer, dataEntryOffset);
        const dataSize = readUInt32LE(buffer, dataEntryOffset + 4);
        if (dataRva === undefined || dataSize === undefined || dataSize === 0) {
            continue;
        }
        const fileOffset = rvaToFileOffset(dataRva, sections);
        if (fileOffset === undefined || fileOffset + dataSize > buffer.length) {
            continue;
        }
        return buffer.subarray(fileOffset, fileOffset + dataSize);
    }
    return undefined;
}

/** Locate the raw RT_VERSION resource payload of a PE image. */
function locateVersionResource(buffer: Buffer): Buffer | undefined {
    if (buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
        return undefined;
    }
    const peOffset = readUInt32LE(buffer, 0x3c);
    if (peOffset === undefined || peOffset < 4 || peOffset + 24 > buffer.length) {
        return undefined;
    }
    if (readUInt32LE(buffer, peOffset) !== PE_SIGNATURE) {
        return undefined;
    }
    const coffOffset = peOffset + 4;
    const numberOfSections = readUInt16LE(buffer, coffOffset + 2);
    const sizeOfOptionalHeader = readUInt16LE(buffer, coffOffset + 16);
    if (numberOfSections === undefined || sizeOfOptionalHeader === undefined) {
        return undefined;
    }
    if (numberOfSections === 0 || numberOfSections > MAX_PE_SECTIONS) {
        return undefined;
    }

    const optionalOffset = coffOffset + 20;
    const magic = readUInt16LE(buffer, optionalOffset);
    let dataDirectoryOffset: number;
    if (magic === PE32_MAGIC) {
        dataDirectoryOffset = PE32_DATA_DIRECTORY_OFFSET;
    } else if (magic === PE32_PLUS_MAGIC) {
        dataDirectoryOffset = PE32_PLUS_DATA_DIRECTORY_OFFSET;
    } else {
        return undefined;
    }
    const resourceEntryOffset = dataDirectoryOffset + RESOURCE_DIRECTORY_INDEX * 8;
    if (sizeOfOptionalHeader < resourceEntryOffset + 8) {
        return undefined;
    }
    if (optionalOffset + sizeOfOptionalHeader > buffer.length) {
        return undefined;
    }
    const resourceRva = readUInt32LE(buffer, optionalOffset + resourceEntryOffset);
    const resourceSize = readUInt32LE(buffer, optionalOffset + resourceEntryOffset + 4);
    if (resourceRva === undefined || resourceSize === undefined || resourceRva === 0 || resourceSize === 0) {
        return undefined;
    }

    const sectionTableOffset = optionalOffset + sizeOfOptionalHeader;
    if (sectionTableOffset + numberOfSections * 40 > buffer.length) {
        return undefined;
    }
    const sections: SectionInfo[] = [];
    for (let index = 0; index < numberOfSections; index++) {
        const sectionOffset = sectionTableOffset + index * 40;
        const virtualSize = readUInt32LE(buffer, sectionOffset + 8);
        const virtualAddress = readUInt32LE(buffer, sectionOffset + 12);
        const sizeOfRawData = readUInt32LE(buffer, sectionOffset + 16);
        const pointerToRawData = readUInt32LE(buffer, sectionOffset + 20);
        if (
            virtualSize === undefined ||
            virtualAddress === undefined ||
            sizeOfRawData === undefined ||
            pointerToRawData === undefined
        ) {
            return undefined;
        }
        sections.push({ virtualAddress, virtualSize, sizeOfRawData, pointerToRawData });
    }

    const resourceRootOffset = rvaToFileOffset(resourceRva, sections);
    if (resourceRootOffset === undefined || resourceRootOffset + 16 > buffer.length) {
        return undefined;
    }
    const resourceEnd = Math.min(resourceRootOffset + resourceSize, buffer.length);
    const rootEntries = readResourceDirectory(buffer, resourceRootOffset, resourceRootOffset, resourceEnd);
    if (rootEntries === undefined) {
        return undefined;
    }
    const searchBudget: ResourceSearchBudget = {
        entriesLeft: MAX_RESOURCE_SEARCH_ENTRIES,
        visited: new Set<number>()
    };
    for (const entry of rootEntries) {
        if (entry.named || !entry.directory || entry.id !== RT_VERSION) {
            continue;
        }
        const versionData = findFirstResourceData(
            buffer,
            resourceRootOffset + entry.offset,
            resourceRootOffset,
            resourceEnd,
            sections,
            0,
            searchBudget
        );
        if (versionData !== undefined) {
            return versionData;
        }
    }
    return undefined;
}

/** Parse one VS_VERSIONINFO-style block (`wLength`, `wValueLength`, `wType`, `szKey`, value, children). */
function readVersionInfoRecord(buffer: Buffer, offset: number, limit: number): VersionInfoRecord | undefined {
    if (offset < 0 || offset + 6 > limit) {
        return undefined;
    }
    const length = readUInt16LE(buffer, offset);
    const valueLength = readUInt16LE(buffer, offset + 2);
    const type = readUInt16LE(buffer, offset + 4);
    if (length === undefined || valueLength === undefined || type === undefined || length < 6) {
        return undefined;
    }
    const end = Math.min(offset + length, limit);

    // szKey is a null-terminated UTF-16LE string that starts right after the header.
    let cursor = offset + 6;
    let keyEnd = -1;
    while (cursor + 1 < end) {
        if (buffer[cursor] === 0 && buffer[cursor + 1] === 0) {
            keyEnd = cursor;
            break;
        }
        cursor += 2;
    }
    if (keyEnd < 0) {
        return undefined;
    }
    const key = buffer.toString('utf16le', offset + 6, keyEnd);

    let valueOffset = align4(keyEnd + 2);
    if (valueOffset > end) {
        valueOffset = end;
    }
    const valueBytes = type === 1 ? valueLength * 2 : valueLength;
    const valueEnd = Math.min(valueOffset + valueBytes, end);
    const childrenOffset = Math.min(align4(valueEnd), end);

    return { length, valueLength, type, key, valueOffset, valueEnd, childrenOffset, end };
}

/** Read all direct children of a version block. Stops safely on malformed padding. */
function readVersionInfoChildren(buffer: Buffer, parent: VersionInfoRecord): VersionInfoRecord[] {
    const children: VersionInfoRecord[] = [];
    let offset = parent.childrenOffset;
    while (offset + 6 <= parent.end && children.length < MAX_VERSION_CHILDREN) {
        const child = readVersionInfoRecord(buffer, offset, parent.end);
        if (child === undefined) {
            break;
        }
        children.push(child);
        const nextOffset = align4(offset + child.length);
        if (nextOffset <= offset) {
            break;
        }
        offset = nextOffset;
    }
    return children;
}

/** Decode a version string value: UTF-16LE up to the first NUL, trimmed. */
function decodeVersionString(buffer: Buffer, record: VersionInfoRecord): string | undefined {
    if (record.valueOffset >= record.end) {
        return undefined;
    }
    const raw = buffer.toString('utf16le', record.valueOffset, record.end);
    const terminator = raw.indexOf('\u0000');
    const text = (terminator === -1 ? raw : raw.slice(0, terminator)).trim();
    return text.length > 0 ? text : undefined;
}

/** Parse the `VS_VERSIONINFO` payload and return FileVersion, falling back to ProductVersion. */
function parseVersionInfo(data: Buffer): string | undefined {
    const root = readVersionInfoRecord(data, 0, data.length);
    if (root === undefined || root.key.toUpperCase() !== VERSION_INFO_KEY) {
        return undefined;
    }
    const stringFileInfo = readVersionInfoChildren(data, root).find(
        (child) => child.key.toUpperCase() === STRING_FILE_INFO_KEY
    );
    if (stringFileInfo === undefined) {
        return undefined;
    }

    let productVersion: string | undefined;
    for (const language of readVersionInfoChildren(data, stringFileInfo)) {
        let fileVersion: string | undefined;
        for (const field of readVersionInfoChildren(data, language)) {
            const key = field.key.toUpperCase();
            if (key === FILE_VERSION_KEY && fileVersion === undefined) {
                fileVersion = decodeVersionString(data, field);
            } else if (key === PRODUCT_VERSION_KEY && productVersion === undefined) {
                productVersion = decodeVersionString(data, field);
            }
        }
        if (fileVersion !== undefined) {
            return fileVersion;
        }
    }
    return productVersion;
}

function parseVersionFromPeBuffer(buffer: Buffer): string | undefined {
    try {
        const versionData = locateVersionResource(buffer);
        if (versionData === undefined) {
            return undefined;
        }
        return parseVersionInfo(versionData);
    } catch {
        return undefined;
    }
}

function readPeVersionSync(filePath: string): string | undefined {
    try {
        return parseVersionFromPeBuffer(fs.readFileSync(filePath));
    } catch {
        return undefined;
    }
}

async function readPeVersion(filePath: string): Promise<string | undefined> {
    try {
        return parseVersionFromPeBuffer(await fs.promises.readFile(filePath));
    } catch {
        return undefined;
    }
}

/** PowerShell one-liner used as a fallback when PE parsing finds nothing. */
function buildPowerShellVersionCommand(filePath: string): string {
    // Wrap the path in single quotes (PowerShell literal string); embedded
    // single quotes are escaped by doubling them.
    const escapedPath = filePath.replace(/'/g, "''");
    return `(Get-Item -LiteralPath '${escapedPath}' -ErrorAction Stop).VersionInfo.FileVersion`;
}

function normalizePowerShellVersion(output: string | undefined): string | undefined {
    if (output === undefined) {
        return undefined;
    }
    for (const line of output.split(/\r?\n/)) {
        const trimmed = line.replace(/^\uFEFF/, '').trim();
        if (trimmed.length > 0) {
            return trimmed;
        }
    }
    return undefined;
}

const POWERSHELL_ARGUMENTS = ['-NoProfile', '-NonInteractive', '-Command'] as const;

function readPowerShellVersionSync(filePath: string): string | undefined {
    try {
        const stdout = childProcess.execFileSync(
            'powershell.exe',
            [...POWERSHELL_ARGUMENTS, buildPowerShellVersionCommand(filePath)],
            {
                timeout: POWERSHELL_TIMEOUT_MS,
                windowsHide: true,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }
        );
        return normalizePowerShellVersion(stdout);
    } catch {
        return undefined;
    }
}

function readPowerShellVersion(filePath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        try {
            childProcess.execFile(
                'powershell.exe',
                [...POWERSHELL_ARGUMENTS, buildPowerShellVersionCommand(filePath)],
                { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
                (error, stdout) => {
                    resolve(error ? undefined : normalizePowerShellVersion(stdout));
                }
            );
        } catch {
            resolve(undefined);
        }
    });
}

function cacheKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Read the VERSIONINFO `FileVersion` (falling back to `ProductVersion`) of a PE
 * file. Returns `undefined` for missing files, directories, non-PE files and
 * any malformed data; never throws.
 */
export function readFileVersionSync(filePath: string): string | undefined {
    return readPeVersionSync(filePath) ?? readPowerShellVersionSync(filePath);
}

/**
 * Asynchronous variant of {@link readFileVersionSync}: tries the PE parser
 * first and falls back to PowerShell's `VersionInfo.FileVersion`.
 */
export async function readFileVersion(filePath: string): Promise<string | undefined> {
    const peVersion = await readPeVersion(filePath);
    if (peVersion !== undefined) {
        return peVersion;
    }
    return readPowerShellVersion(filePath);
}

/**
 * Cached variant of {@link readFileVersion}. The cache entry is keyed by the
 * resolved path and invalidated when the file modification time changes. Only
 * successful results are cached so a temporarily unreadable file is retried.
 */
export async function readFileVersionCached(filePath: string): Promise<string | undefined> {
    const key = cacheKey(filePath);
    let mtimeMs: number;
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
            versionCache.delete(key);
            return undefined;
        }
        mtimeMs = stats.mtimeMs;
    } catch {
        versionCache.delete(key);
        return undefined;
    }

    const cached = versionCache.get(key);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
        return cached.value;
    }

    const value = await readFileVersion(filePath);
    if (value === undefined) {
        versionCache.delete(key);
        return undefined;
    }
    versionCache.set(key, { mtimeMs, value });
    return value;
}
