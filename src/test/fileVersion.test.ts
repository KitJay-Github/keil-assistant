import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    readFileVersion,
    readFileVersionCached,
    readFileVersionSync
} from '../project/fileVersion';

/** `__dirname` is `dist/src/test`, so the repository root is three levels up. */
const repoRoot = path.resolve(__dirname, '../../../');
const UV4_PATH = 'C:\\Keil_v5\\UV4\\UV4.exe';
const UL2CM3_PATH = 'C:\\Keil_v5\\ARM\\BIN\\UL2CM3.DLL';

function align4(value: number): number {
    return (value + 3) & ~3;
}

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best effort cleanup.
    }
}

/** Build one VS_VERSIONINFO style block (header + UTF-16 key + value + children). */
function buildVersionBlock(key: string, type: number, value: Buffer, valueLength: number, children: Buffer): Buffer {
    const keyBytes = Buffer.concat([Buffer.from(key, 'utf16le'), Buffer.alloc(2)]);
    const valueOffset = align4(6 + keyBytes.length);
    const childrenOffset = align4(valueOffset + value.length);
    const block = Buffer.alloc(childrenOffset + children.length);
    block.writeUInt16LE(block.length, 0);
    block.writeUInt16LE(valueLength, 2);
    block.writeUInt16LE(type, 4);
    keyBytes.copy(block, 6);
    value.copy(block, valueOffset);
    children.copy(block, childrenOffset);
    return block;
}

/** Build a VS_VERSIONINFO payload with a StringFileInfo table. */
function buildVersionInfo(fileVersion: string | undefined, productVersion: string | undefined): Buffer {
    const fields: Buffer[] = [];
    if (fileVersion !== undefined) {
        const value = Buffer.from(`${fileVersion}\u0000`, 'utf16le');
        fields.push(buildVersionBlock('FileVersion', 1, value, value.length / 2, Buffer.alloc(0)));
    }
    if (productVersion !== undefined) {
        const value = Buffer.from(`${productVersion}\u0000`, 'utf16le');
        fields.push(buildVersionBlock('ProductVersion', 1, value, value.length / 2, Buffer.alloc(0)));
    }
    const language = buildVersionBlock('040904b0', 1, Buffer.alloc(0), 0, Buffer.concat(fields));
    const stringFileInfo = buildVersionBlock('StringFileInfo', 1, Buffer.alloc(0), 0, language);
    const fixedFileInfo = Buffer.alloc(52);
    fixedFileInfo.writeUInt32LE(0xfeef04bd, 0);
    fixedFileInfo.writeUInt32LE(0x00010000, 4);
    return buildVersionBlock('VS_VERSION_INFO', 0, fixedFileInfo, 52, stringFileInfo);
}

/**
 * Build a minimal PE image (one `.rsrc` section) that carries `versionData` as
 * its RT_VERSION resource, so the parser can be exercised without Keil installed.
 */
function buildSyntheticPe(versionData: Buffer, pe32Plus: boolean): Buffer {
    const peOffset = 0x80;
    const coffOffset = peOffset + 4;
    const optionalSize = pe32Plus ? 240 : 224;
    const optionalOffset = coffOffset + 20;
    const sectionTableOffset = optionalOffset + optionalSize;
    const sectionRawPointer = 0x200;
    const sectionRawSize = 0x400;
    const versionDataOffset = sectionRawPointer + 0x100;
    const versionDataRva = 0x1000 + (versionDataOffset - sectionRawPointer);

    const buffer = Buffer.alloc(sectionRawPointer + sectionRawSize);
    buffer[0] = 0x4d; // 'M'
    buffer[1] = 0x5a; // 'Z'
    buffer.writeUInt32LE(peOffset, 0x3c);
    buffer.writeUInt32LE(0x00004550, peOffset); // 'PE\0\0'
    buffer.writeUInt16LE(0x14c, coffOffset); // IMAGE_FILE_MACHINE_I386
    buffer.writeUInt16LE(1, coffOffset + 2); // NumberOfSections
    buffer.writeUInt16LE(optionalSize, coffOffset + 16);
    buffer.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, optionalOffset);
    const dataDirectoryOffset = optionalOffset + (pe32Plus ? 112 : 96);
    buffer.writeUInt32LE(0x1000, dataDirectoryOffset + 16); // DataDirectory[2] RVA
    buffer.writeUInt32LE(sectionRawSize, dataDirectoryOffset + 20); // DataDirectory[2] size

    buffer.write('.rsrc', sectionTableOffset, 'latin1');
    buffer.writeUInt32LE(sectionRawSize, sectionTableOffset + 8);
    buffer.writeUInt32LE(0x1000, sectionTableOffset + 12);
    buffer.writeUInt32LE(sectionRawSize, sectionTableOffset + 16);
    buffer.writeUInt32LE(sectionRawPointer, sectionTableOffset + 20);

    const resourceRoot = sectionRawPointer;
    const writeDirectory = (offset: number, entries: Array<{ name: number; data: number }>): void => {
        buffer.writeUInt16LE(0, offset + 12);
        buffer.writeUInt16LE(entries.length, offset + 14);
        entries.forEach((entry, index) => {
            buffer.writeUInt32LE(entry.name, offset + 16 + index * 8);
            buffer.writeUInt32LE(entry.data, offset + 16 + index * 8 + 4);
        });
    };
    writeDirectory(resourceRoot, [{ name: 16, data: 0x80000018 }]);
    writeDirectory(resourceRoot + 0x18, [{ name: 1, data: 0x80000030 }]);
    writeDirectory(resourceRoot + 0x30, [{ name: 0x409, data: 0x50 }]);
    const dataEntryOffset = resourceRoot + 0x50;
    buffer.writeUInt32LE(versionDataRva, dataEntryOffset);
    buffer.writeUInt32LE(versionData.length, dataEntryOffset + 4);
    buffer.writeUInt32LE(0x4e4, dataEntryOffset + 8); // language / code page
    versionData.copy(buffer, versionDataOffset);
    return buffer;
}

describe('fileVersion', () => {
    const tempDirs: string[] = [];

    after(() => {
        tempDirs.forEach(removeDir);
    });

    function newTempDir(prefix: string): string {
        const dir = makeTempDir(prefix);
        tempDirs.push(dir);
        return dir;
    }

    it('returns undefined for a missing file', () => {
        const missingPath = path.join(repoRoot, 'missing-file-for-fileVersion-test.exe');
        assert.equal(fs.existsSync(missingPath), false);
        assert.equal(readFileVersionSync(missingPath), undefined);
    });

    it('returns undefined for a directory', () => {
        assert.equal(fs.statSync(repoRoot).isDirectory(), true);
        assert.equal(readFileVersionSync(repoRoot), undefined);
    });

    it('returns undefined for a non-PE text file', async () => {
        const dir = newTempDir('keil-version-text-');
        const textPath = path.join(dir, 'not a PE 文本 file.txt');
        fs.writeFileSync(textPath, 'This file has no VERSIONINFO resource.\n', 'utf8');

        assert.equal(readFileVersionSync(textPath), undefined);
        assert.equal(await readFileVersion(textPath), undefined);
    });

    it('returns undefined for truncated and forged MZ headers without throwing', () => {
        const dir = newTempDir('keil-version-forged-');

        const truncatedPath = path.join(dir, 'truncated-mz.exe');
        fs.writeFileSync(truncatedPath, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
        assert.equal(readFileVersionSync(truncatedPath), undefined);

        const badOffsetPath = path.join(dir, 'bad-e-lfanew.exe');
        const badOffset = Buffer.alloc(0x40);
        badOffset[0] = 0x4d;
        badOffset[1] = 0x5a;
        badOffset.writeUInt32LE(0x1000, 0x3c); // e_lfanew points past the end
        fs.writeFileSync(badOffsetPath, badOffset);
        assert.equal(readFileVersionSync(badOffsetPath), undefined);

        const noSignaturePath = path.join(dir, 'no-pe-signature.exe');
        const noSignature = Buffer.alloc(0x100);
        noSignature[0] = 0x4d;
        noSignature[1] = 0x5a;
        noSignature.writeUInt32LE(0x40, 0x3c); // points inside the buffer, but no `PE\0\0`
        fs.writeFileSync(noSignaturePath, noSignature);
        assert.equal(readFileVersionSync(noSignaturePath), undefined);
    });

    it('reads FileVersion from a synthetic PE32 image with spaces and Chinese in the path', async () => {
        const dir = newTempDir('keil-version-pe32-');
        const fixturePath = path.join(dir, '版本 fixture with space.exe');
        fs.writeFileSync(fixturePath, buildSyntheticPe(buildVersionInfo('9.8.7.6', '1.2.3.4'), false));

        assert.equal(readFileVersionSync(fixturePath), '9.8.7.6');
        assert.equal(await readFileVersion(fixturePath), '9.8.7.6');
    });

    it('reads FileVersion from a synthetic PE32+ image', () => {
        const dir = newTempDir('keil-version-pe32plus-');
        const fixturePath = path.join(dir, 'fixture-x64.exe');
        fs.writeFileSync(fixturePath, buildSyntheticPe(buildVersionInfo('6.5.4.3', '6.5.4.3'), true));

        assert.equal(readFileVersionSync(fixturePath), '6.5.4.3');
    });

    it('falls back to ProductVersion when FileVersion is absent', () => {
        const dir = newTempDir('keil-version-product-');
        const fixturePath = path.join(dir, 'product-only.exe');
        fs.writeFileSync(fixturePath, buildSyntheticPe(buildVersionInfo(undefined, '3.4.5.6'), false));

        assert.equal(readFileVersionSync(fixturePath), '3.4.5.6');
    });

    it('caches by path and mtime, and refreshes after the file changes', async () => {
        const dir = newTempDir('keil-version-cache-');
        const fixturePath = path.join(dir, 'cached.exe');
        fs.writeFileSync(fixturePath, buildSyntheticPe(buildVersionInfo('1.0.0.0', undefined), false));

        assert.equal(await readFileVersionCached(fixturePath), '1.0.0.0');
        assert.equal(await readFileVersionCached(fixturePath), '1.0.0.0');

        fs.writeFileSync(fixturePath, buildSyntheticPe(buildVersionInfo('2.0.0.0', undefined), false));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(fixturePath, future, future);
        assert.equal(await readFileVersionCached(fixturePath), '2.0.0.0');
    });

    it('does not cache missing files permanently', async () => {
        const dir = newTempDir('keil-version-missing-cache-');
        const fixturePath = path.join(dir, 'appears-later.exe');

        assert.equal(await readFileVersionCached(fixturePath), undefined);

        fs.writeFileSync(fixturePath, buildSyntheticPe(buildVersionInfo('7.0.0.0', undefined), false));
        assert.equal(await readFileVersionCached(fixturePath), '7.0.0.0');
    });

    it('shares the cache entry for differently cased Windows paths', async () => {
        if (process.platform !== 'win32') {
            return;
        }
        const dir = newTempDir('keil-version-case-');
        const fixturePath = path.join(dir, 'VersionCase.exe');
        fs.writeFileSync(fixturePath, buildSyntheticPe(buildVersionInfo('4.3.2.1', undefined), false));

        assert.equal(await readFileVersionCached(fixturePath), '4.3.2.1');
        assert.equal(await readFileVersionCached(fixturePath.toUpperCase()), '4.3.2.1');
        assert.equal(await readFileVersionCached(fixturePath.toLowerCase()), '4.3.2.1');
    });

    it('reads the installed uVision UV4.exe version when available', async () => {
        if (!fs.existsSync(UV4_PATH)) {
            return;
        }
        const syncVersion = readFileVersionSync(UV4_PATH);
        assert.ok(syncVersion !== undefined, `expected a version for ${UV4_PATH}`);
        assert.match(syncVersion, /^\d+\.\d+/);
        assert.equal(await readFileVersion(UV4_PATH), syncVersion);

        const cachedFirst = await readFileVersionCached(UV4_PATH);
        assert.equal(cachedFirst, syncVersion);
        const cachedSecond = await readFileVersionCached(UV4_PATH);
        assert.equal(cachedSecond, cachedFirst);
    });

    it('reads the installed ULINK2/ME UL2CM3.DLL version when available', async () => {
        if (!fs.existsSync(UL2CM3_PATH)) {
            return;
        }
        const syncVersion = readFileVersionSync(UL2CM3_PATH);
        assert.ok(syncVersion !== undefined, `expected a version for ${UL2CM3_PATH}`);
        assert.match(syncVersion, /^\d+\.\d+/);
        assert.equal(await readFileVersion(UL2CM3_PATH), syncVersion);

        const cachedFirst = await readFileVersionCached(UL2CM3_PATH);
        assert.equal(cachedFirst, syncVersion);
        const cachedSecond = await readFileVersionCached(UL2CM3_PATH);
        assert.equal(cachedSecond, cachedFirst);
    });
});
