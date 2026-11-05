import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findPath, findTarget, parseXml, trimmedTextOf } from '../project/uvXml';
import {
    DeviceCatalog,
    DeviceEntry,
    applyDeviceSelection,
    buildCpuString,
    deviceOptions,
    findDevice,
    parsePdscDevices,
    readCachedCatalog,
    readDeviceDetails,
    resolvePackRoots,
    scanDeviceCatalog,
    writeCachedCatalog
} from '../project/options/deviceDatabase';

const FIXTURE_DIR = path.resolve(__dirname, '../../../src/test/fixtures');
const SAMPLE_PACK = path.join(FIXTURE_DIR, 'sample-pack.pdsc');

function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
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

/** Build a catalog from the synthetic fixture pack. */
function sampleCatalog(): DeviceCatalog {
    const parsed = parsePdscDevices(readFixture('sample-pack.pdsc'), SAMPLE_PACK);
    return {
        generatedAt: '2024-01-01T00:00:00.000Z',
        packRoots: [FIXTURE_DIR],
        devices: parsed.devices,
        packs: [parsed.pack],
        warnings: []
    };
}

/** Text of one `<TargetCommonOption>` child, read back through the XML parser. */
function fieldText(xml: string, targetName: string, tagName: string): string | undefined {
    const doc = parseXml(xml);
    const target = findTarget(doc.root, targetName);
    if (!target) {
        return undefined;
    }
    const element = findPath(target, ['TargetOption', 'TargetCommonOption', tagName]);
    return element ? trimmedTextOf(element) : undefined;
}

/** Verbatim source of one `<Target>` subtree. */
function targetBlock(xml: string, targetName: string): string | undefined {
    const doc = parseXml(xml);
    const target = findTarget(doc.root, targetName);
    return target ? doc.source.slice(target.start, target.end) : undefined;
}

/** Number of lines that differ between two documents. */
function differingLines(before: string, after: string): number {
    const beforeLines = before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    const length = Math.max(beforeLines.length, afterLines.length);
    let count = 0;
    for (let index = 0; index < length; index++) {
        if (beforeLines[index] !== afterLines[index]) {
            count++;
        }
    }
    return count;
}

/** Small throw-away pack used by the "no memory / no core" cases. */
function writeTempPack(directory: string, devicesXml: string): string {
    const file = path.join(directory, 'Test.Device_DFP.1.0.0.pdsc');
    fs.writeFileSync(
        file,
        '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<package schemaVersion="1.4.9">\n'
            + '  <vendor>Test Vendor</vendor>\n'
            + '  <name>Device_DFP</name>\n'
            + '  <releases><release version="1.0.0" date="2024-01-01">test</release></releases>\n'
            + '  <devices>\n'
            + '    <family Dfamily="TestFamily" Dvendor="Test Vendor:1">\n'
            + '      <subFamily DsubFamily="TestSub">\n'
            + `${devicesXml}\n`
            + '      </subFamily>\n'
            + '    </family>\n'
            + '  </devices>\n'
            + '</package>\n',
        'utf8'
    );
    return file;
}

describe('deviceDatabase', () => {
    const tempDirs: string[] = [];

    function tempDir(prefix: string): string {
        const directory = makeTempDir(prefix);
        tempDirs.push(directory);
        return directory;
    }

    after(() => {
        tempDirs.forEach(removeDir);
    });

    // -----------------------------------------------------------------------
    // parsePdscDevices
    // -----------------------------------------------------------------------
    describe('parsePdscDevices', () => {
        it('parses the synthetic fixture pack and its devices', () => {
            const parsed = parsePdscDevices(readFixture('sample-pack.pdsc'), SAMPLE_PACK);

            assert.equal(parsed.pack.vendor, 'Keil');
            assert.equal(parsed.pack.name, 'Sample_DFP');
            assert.equal(parsed.pack.version, '1.0.0');
            assert.equal(parsed.pack.url, 'https://example.com/packs/');
            assert.equal(parsed.pack.pdscPath, SAMPLE_PACK);
            assert.equal(parsed.pack.deviceCount, 3);
            assert.equal(parsed.devices.length, 3);
            assert.deepEqual(
                parsed.devices.map((entry) => entry.device),
                ['SAMPLEDEV1', 'SAMPLEDEV2', 'SAMPLEDEV3']
            );

            const first = parsed.devices[0];
            assert.equal(first.vendor, 'Sample Semiconductor', 'Dvendor is split at the colon');
            assert.equal(first.vendorId, 'Sample Semiconductor:99');
            assert.equal(first.core, 'Cortex-M4');
            assert.equal(first.family, 'SampleFamily', 'Dfamily inherited from <family>');
            assert.equal(first.subFamily, 'SampleA', 'DsubFamily inherited from <subFamily>');
            assert.equal(first.packVendor, 'Keil');
            assert.equal(first.packName, 'Sample_DFP');
            assert.equal(first.packVersion, '1.0.0');
            assert.equal(first.packId, 'Keil.Sample_DFP.1.0.0');
            assert.equal(first.packUrl, 'https://example.com/packs/');
            assert.equal(first.pdscPath, SAMPLE_PACK);

            const third = parsed.devices[2];
            assert.equal(third.device, 'SAMPLEDEV3');
            assert.equal(third.core, 'Cortex-M3');
            assert.equal(third.subFamily, 'SampleB');
            assert.equal(third.vendor, 'Sample Semiconductor', 'Dvendor inherited from the family');
        });

        it('parses the CMSIS-Pack 1.4 layout (child elements + inherited core)', () => {
            const text = '<?xml version="1.0" encoding="UTF-8"?>\n'
                + '<package schemaVersion="1.4.0" xmlns:xs="http://www.w3.org/2001/XMLSchema-instance">\n'
                + '  <vendor>Keil</vendor>\n'
                + '  <url>http://www.keil.com/pack/</url>\n'
                + '  <name>STM32F1xx_DFP</name>\n'
                + '  <releases>\n'
                + '    <release version="2.3.0" date="2018-11-05">notes</release>\n'
                + '  </releases>\n'
                + '  <devices>\n'
                + '    <family Dfamily="STM32F1 Series" Dvendor="STMicroelectronics:13">\n'
                + '      <processor Dcore="Cortex-M3" DcoreVersion="r1p1"/>\n'
                + '      <subFamily DsubFamily="STM32F103">\n'
                + '        <device Dname="STM32F103CB">\n'
                + '          <memory id="IROM1" start="0x08000000" size="0x00020000"/>\n'
                + '          <memory id="IRAM1" start="0x20000000" size="0x00005000"/>\n'
                + '          <debug svd="SVD/STM32F103xx.svd"/>\n'
                + '          <compile header="Device/Include/stm32f10x.h"/>\n'
                + '        </device>\n'
                + '      </subFamily>\n'
                + '    </family>\n'
                + '  </devices>\n'
                + '</package>';
            const pdscPath = 'C:\\packs\\Keil\\STM32F1xx_DFP\\2.3.0\\Keil.STM32F1xx_DFP.pdsc';

            const parsed = parsePdscDevices(text, pdscPath);
            assert.equal(parsed.pack.vendor, 'Keil');
            assert.equal(parsed.pack.name, 'STM32F1xx_DFP');
            assert.equal(parsed.pack.version, '2.3.0', 'version comes from the newest <release>');
            assert.equal(parsed.pack.url, 'http://www.keil.com/pack/');
            assert.equal(parsed.devices.length, 1);

            const device = parsed.devices[0];
            assert.equal(device.device, 'STM32F103CB');
            assert.equal(device.core, 'Cortex-M3', 'Dcore inherited from the family <processor>');
            assert.equal(device.vendor, 'STMicroelectronics');
            assert.equal(device.vendorId, 'STMicroelectronics:13');
            assert.equal(device.family, 'STM32F1 Series');
            assert.equal(device.subFamily, 'STM32F103');
            assert.equal(device.packId, 'Keil.STM32F1xx_DFP.2.3.0');
        });

        it('falls back to the installed directory and the pdsc file name', () => {
            const installed = parsePdscDevices(
                '<package schemaVersion="1.4.9"><vendor>Keil</vendor><name>STM32F1xx_DFP</name></package>',
                'C:\\packs\\Keil\\STM32F1xx_DFP\\2.3.0\\Keil.STM32F1xx_DFP.pdsc'
            );
            assert.equal(installed.pack.version, '2.3.0', 'version from the <version> directory');

            // uVision caches downloaded pack descriptions as
            // `.Download/<Vendor>.<Name>.<Version>.pdsc`.
            const downloaded = parsePdscDevices(
                '<package schemaVersion="1.4.9"><vendor>ARM</vendor><name>CMSIS-Driver</name></package>',
                'C:\\packs\\.Download\\ARM.CMSIS-Driver.2.6.1.pdsc'
            );
            assert.equal(downloaded.pack.version, '2.6.1', 'version from the file name');
        });

        it('tolerates empty, truncated and unrelated content', () => {
            const inputs = [
                '',
                '   ',
                '<package',
                'this is not xml at all',
                '<package vendor="X" name="Y"><devices><family Dfamily="F"><subFamily DsubFamily="S"><device Dname="D">'
            ];
            for (const input of inputs) {
                const parsed = parsePdscDevices(input, 'C:\\missing\\broken.pdsc');
                assert.ok(Array.isArray(parsed.devices));
                assert.equal(parsed.pack.pdscPath, 'C:\\missing\\broken.pdsc');
            }

            const empty = parsePdscDevices('', 'C:\\empty\\empty.pdsc');
            assert.equal(empty.pack.vendor, '');
            assert.equal(empty.pack.name, '');
            assert.equal(empty.pack.deviceCount, 0);
            assert.deepEqual(empty.devices, []);

            // A device tag that is never closed is still reported.
            const truncated = parsePdscDevices(
                '<package vendor="X" name="Y"><devices><device Dname="D1"></devices>',
                'C:\\x.pdsc'
            );
            assert.deepEqual(truncated.devices.map((entry) => entry.device), ['D1']);
            assert.equal(truncated.pack.vendor, 'X');
        });
    });

    // -----------------------------------------------------------------------
    // resolvePackRoots
    // -----------------------------------------------------------------------
    describe('resolvePackRoots', () => {
        const originalLocalAppData = process.env.LOCALAPPDATA;

        afterEach(() => {
            if (originalLocalAppData === undefined) {
                delete process.env.LOCALAPPDATA;
            } else {
                process.env.LOCALAPPDATA = originalLocalAppData;
            }
        });

        it('reads RTEPATH from TOOLS.INI, keeps the order and filters missing paths', () => {
            const base = tempDir('device-roots-');
            const first = path.join(base, 'Keil', 'ARM', 'PACK');
            const second = path.join(base, 'local', 'Arm', 'Packs');
            fs.mkdirSync(first, { recursive: true });
            fs.mkdirSync(second, { recursive: true });
            const missing = path.join(base, 'does-not-exist');
            const toolsIni = '[UV2]\nORGANIZATION=""\nRTEPATH="' + second + ';' + missing + ';' + first + '"\nSocketPort=0\n';

            assert.deepEqual(resolvePackRoots(toolsIni, undefined), [second, first]);
        });

        it('expands environment variables written into RTEPATH', () => {
            const base = tempDir('device-roots-env-');
            const localAppData = path.join(base, 'local');
            const packs = path.join(localAppData, 'Arm', 'Packs');
            fs.mkdirSync(packs, { recursive: true });
            process.env.LOCALAPPDATA = localAppData;

            const toolsIni = 'RTEPATH="%LOCALAPPDATA%\\Arm\\Packs"\n';
            assert.deepEqual(resolvePackRoots(toolsIni, undefined), [packs]);
        });

        it('falls back to %LOCALAPPDATA%\\Arm\\Packs and <keilRoot>\\PACK', () => {
            const base = tempDir('device-roots-fallback-');
            const localAppData = path.join(base, 'local');
            const localPacks = path.join(localAppData, 'Arm', 'Packs');
            const keilRoot = path.join(base, 'keil');
            const keilPacks = path.join(keilRoot, 'PACK');
            fs.mkdirSync(localPacks, { recursive: true });
            fs.mkdirSync(keilPacks, { recursive: true });
            process.env.LOCALAPPDATA = localAppData;

            // No RTEPATH at all.
            assert.deepEqual(resolvePackRoots('[UV2]\nARMSEL=1\n', keilRoot), [localPacks, keilPacks]);

            // An RTEPATH that does not exist is ignored as well.
            const ghostIni = 'RTEPATH="' + path.join(base, 'ghost') + '"\n';
            assert.deepEqual(resolvePackRoots(ghostIni, keilRoot), [localPacks, keilPacks]);

            // Neither fallback exists.
            process.env.LOCALAPPDATA = path.join(base, 'nowhere');
            fs.rmSync(keilPacks, { recursive: true, force: true });
            assert.deepEqual(resolvePackRoots('RTEPATH="' + path.join(base, 'ghost') + '"\n', undefined), []);
        });
    });

    // -----------------------------------------------------------------------
    // scanDeviceCatalog
    // -----------------------------------------------------------------------
    describe('scanDeviceCatalog', () => {
        it('scans nested packs, dedupes devices and reports progress', async () => {
            const base = tempDir('device-scan-');
            const installedV1 = path.join(base, 'Keil', 'Sample_DFP', '1.0.0');
            const installedV2 = path.join(base, 'Keil', 'Sample_DFP', '2.0.0');
            fs.mkdirSync(installedV1, { recursive: true });
            fs.mkdirSync(installedV2, { recursive: true });
            fs.copyFileSync(SAMPLE_PACK, path.join(installedV1, 'Keil.Sample_DFP.pdsc'));
            fs.writeFileSync(
                path.join(installedV2, 'Keil.Sample_DFP.pdsc'),
                readFixture('sample-pack.pdsc').replace('version="1.0.0"', 'version="2.0.0"'),
                'utf8'
            );
            fs.writeFileSync(
                path.join(base, 'Other.Other_DFP.0.9.0.pdsc'),
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                    + '<package schemaVersion="1.4.9">\n'
                    + '  <vendor>Other Vendor</vendor>\n'
                    + '  <name>Other_DFP</name>\n'
                    + '  <releases><release version="0.9.0">first</release></releases>\n'
                    + '  <devices>\n'
                    + '    <family Dfamily="OtherFamily" Dvendor="Other Vendor:42">\n'
                    + '      <device Dname="OTHERDEV1" Dcore="Cortex-M0"/>\n'
                    + '    </family>\n'
                    + '  </devices>\n'
                    + '</package>\n',
                'utf8'
            );
            fs.writeFileSync(path.join(base, 'empty.pdsc'), '', 'utf8');

            const missingRoot = path.join(base, 'missing-root');
            const progress: Array<[number, number]> = [];
            const catalog = await scanDeviceCatalog([base, missingRoot], (done, total) => {
                progress.push([done, total]);
            });

            assert.equal(catalog.devices.length, 4);
            assert.equal(catalog.packs.length, 3);
            assert.deepEqual(
                catalog.devices.map((entry) => entry.device).sort(),
                ['OTHERDEV1', 'SAMPLEDEV1', 'SAMPLEDEV2', 'SAMPLEDEV3']
            );
            assert.ok(!Number.isNaN(Date.parse(catalog.generatedAt)));
            assert.deepEqual(catalog.packRoots, [path.resolve(base), path.resolve(missingRoot)]);

            // SAMPLEDEV1 exists in the 1.0.0 and the 2.0.0 pack: the newer one wins.
            const latest = findDevice(catalog, 'sampledev1');
            assert.ok(latest);
            assert.equal(latest.packVersion, '2.0.0');
            assert.equal(latest.packId, 'Keil.Sample_DFP.2.0.0');
            assert.ok(latest.pdscPath.indexOf('2.0.0') !== -1, latest.pdscPath);

            const other = findDevice(catalog, 'OTHERDEV1');
            assert.ok(other);
            assert.equal(other.vendor, 'Other Vendor');
            assert.equal(other.core, 'Cortex-M0');
            assert.equal(other.packId, 'Other Vendor.Other_DFP.0.9.0');

            assert.deepEqual(
                catalog.packs.map((pack) => `${pack.vendor}.${pack.name}.${pack.version}`),
                ['Keil.Sample_DFP.1.0.0', 'Keil.Sample_DFP.2.0.0', 'Other Vendor.Other_DFP.0.9.0']
            );

            // A missing root and an unparsable pdsc are warnings, never errors.
            assert.ok(catalog.warnings.some((warning) => warning.indexOf(missingRoot) !== -1));
            assert.ok(catalog.warnings.some((warning) => warning.indexOf('empty.pdsc') !== -1));

            // Progress: initial event, one event per file, 4 pdsc files in total.
            assert.deepEqual(progress[0], [0, 4]);
            assert.deepEqual(progress[progress.length - 1], [4, 4]);
            assert.equal(progress.length, 5);
            assert.ok(progress.every((event) => event[1] === 4));
        });

        it('prefers installed packs over the .Web / .Download caches', async () => {
            const base = tempDir('device-scan-cache-');
            const installed = path.join(base, 'Keil', 'Sample_DFP', '1.0.0');
            fs.mkdirSync(installed, { recursive: true });
            fs.copyFileSync(SAMPLE_PACK, path.join(installed, 'Keil.Sample_DFP.pdsc'));

            // uVision's `.Web` cache describes the newest *available* version,
            // which must not replace the installed (and therefore usable) pack.
            const web = path.join(base, '.Web');
            fs.mkdirSync(web, { recursive: true });
            fs.writeFileSync(
                path.join(web, 'Keil.Sample_DFP.pdsc'),
                readFixture('sample-pack.pdsc').replace('version="1.0.0"', 'version="9.9.9"'),
                'utf8'
            );

            const catalog = await scanDeviceCatalog([base]);
            const device = findDevice(catalog, 'SAMPLEDEV1');
            assert.ok(device);
            assert.equal(device.packVersion, '1.0.0');
            assert.equal(device.packId, 'Keil.Sample_DFP.1.0.0');
            assert.ok(device.pdscPath.indexOf('.Web') === -1, device.pdscPath);
            // Both descriptions are listed, but the installed one is not shadowed.
            assert.equal(catalog.packs.length, 2);
            const installedPack = catalog.packs.find((pack) => pack.version === '1.0.0');
            assert.ok(installedPack);
            assert.ok(installedPack.pdscPath.indexOf('.Web') === -1, installedPack.pdscPath);
        });

        it('never throws when a root cannot be scanned', async () => {
            const catalog = await scanDeviceCatalog([SAMPLE_PACK]);
            assert.deepEqual(catalog.devices, []);
            assert.deepEqual(catalog.packs, []);
            assert.deepEqual(catalog.packRoots, [path.resolve(SAMPLE_PACK)]);
            assert.ok(catalog.warnings.some((warning) => warning.indexOf(SAMPLE_PACK) !== -1));

            const empty = await scanDeviceCatalog([]);
            assert.deepEqual(empty.devices, []);
            assert.deepEqual(empty.warnings, []);
        });
    });

    // -----------------------------------------------------------------------
    // cache
    // -----------------------------------------------------------------------
    describe('cached catalog', () => {
        it('round-trips a catalog through the cache file', () => {
            const base = tempDir('device-cache-');
            const cacheFile = path.join(base, 'nested', 'keil-device-catalog.json');
            const catalog = sampleCatalog();
            catalog.warnings = ['one warning'];

            writeCachedCatalog(cacheFile, catalog);
            const loaded = readCachedCatalog(cacheFile);
            assert.ok(loaded);
            assert.deepEqual(loaded, catalog);
            assert.deepEqual(fs.readdirSync(path.dirname(cacheFile)), ['keil-device-catalog.json']);

            // The temporary-file + rename strategy replaces an existing cache.
            const updated = sampleCatalog();
            updated.warnings = ['replaced'];
            writeCachedCatalog(cacheFile, updated);
            const replaced = readCachedCatalog(cacheFile);
            assert.ok(replaced);
            assert.deepEqual(replaced, updated);
            assert.deepEqual(fs.readdirSync(path.dirname(cacheFile)), ['keil-device-catalog.json']);
        });

        it('returns undefined for missing or corrupted cache files', () => {
            const base = tempDir('device-cache-broken-');
            assert.equal(readCachedCatalog(path.join(base, 'missing.json')), undefined);

            const brokenFile = path.join(base, 'broken.json');
            fs.writeFileSync(brokenFile, '{ not json', 'utf8');
            assert.equal(readCachedCatalog(brokenFile), undefined);

            const shapes = ['null', '[]', '"text"', '{}', '{"devices":[],"packs":[]}', '{"generatedAt":1,"devices":[],"packs":[]}'];
            shapes.forEach((shape, index) => {
                const file = path.join(base, `shape-${index}.json`);
                fs.writeFileSync(file, shape, 'utf8');
                assert.equal(readCachedCatalog(file), undefined, shape);
            });
        });

        it('drops malformed device entries but keeps a usable catalog', () => {
            const base = tempDir('device-cache-entries-');
            const cacheFile = path.join(base, 'catalog.json');
            fs.writeFileSync(
                cacheFile,
                JSON.stringify({
                    generatedAt: '2024-01-01T00:00:00.000Z',
                    packRoots: ['C:\\packs'],
                    warnings: [],
                    packs: [{ vendor: 'Keil', name: 'Sample_DFP', pdscPath: 'C:\\a.pdsc', deviceCount: 1 }],
                    devices: [
                        { device: 'OKDEV', vendor: 'Vendor', pdscPath: 'C:\\a.pdsc' },
                        { vendor: 'Vendor', pdscPath: 'C:\\a.pdsc' },
                        'garbage'
                    ]
                }),
                'utf8'
            );
            const loaded = readCachedCatalog(cacheFile);
            assert.ok(loaded);
            assert.deepEqual(loaded.devices.map((entry) => entry.device), ['OKDEV']);
        });
    });

    // -----------------------------------------------------------------------
    // deviceOptions / findDevice
    // -----------------------------------------------------------------------
    describe('deviceOptions', () => {
        it('lists the catalog devices sorted by vendor and device', () => {
            const catalog = sampleCatalog();
            const options = deviceOptions(catalog, 'SAMPLEDEV2');
            assert.deepEqual(
                options.map((option) => option.value),
                ['SAMPLEDEV1', 'SAMPLEDEV2', 'SAMPLEDEV3']
            );
            assert.equal(
                options[0].label,
                'SAMPLEDEV1（Sample Semiconductor / Keil.Sample_DFP）'
            );
            assert.equal(options.length, 3, 'the current device is not duplicated');
        });

        it('sorts by vendor first and keeps the current device', () => {
            const synthetic: DeviceCatalog = {
                generatedAt: '2024-01-01T00:00:00.000Z',
                packRoots: [],
                packs: [],
                warnings: [],
                devices: [
                    { device: 'ZDEV', vendor: 'Zeta', pdscPath: 'C:\\z.pdsc' },
                    { device: 'ADEV2', vendor: 'Alpha', pdscPath: 'C:\\a.pdsc' },
                    { device: 'ADEV1', vendor: 'Alpha', pdscPath: 'C:\\a.pdsc' }
                ]
            };
            assert.deepEqual(
                deviceOptions(synthetic).map((option) => option.value),
                ['ADEV1', 'ADEV2', 'ZDEV']
            );

            const withUnknownCurrent = deviceOptions(synthetic, 'MYSTERY');
            assert.equal(withUnknownCurrent.length, 4);
            assert.equal(withUnknownCurrent[0].value, 'MYSTERY');
            assert.match(withUnknownCurrent[0].label, /当前型号/);
        });

        it('keeps the stored device when no catalog is available', () => {
            assert.deepEqual(deviceOptions(undefined, 'STM32F407VGTx'), [
                { value: 'STM32F407VGTx', label: 'STM32F407VGTx（当前型号）' }
            ]);
            assert.deepEqual(deviceOptions(undefined), []);
            assert.deepEqual(deviceOptions(undefined, '   '), []);
        });

        it('truncates huge catalogs and appends a hint entry', () => {
            const deviceCount = 20001;
            const devices: DeviceEntry[] = [];
            for (let index = 0; index < deviceCount; index++) {
                const suffix = (`00000${index}`).slice(-5);
                devices.push({ device: `DEV${suffix}`, vendor: 'Vendor', pdscPath: 'C:\\a.pdsc' });
            }
            const catalog: DeviceCatalog = {
                generatedAt: '2024-01-01T00:00:00.000Z',
                packRoots: [],
                packs: [],
                warnings: [],
                devices
            };
            const options = deviceOptions(catalog);
            assert.equal(options.length, 20001, '20000 devices plus the hint entry');
            assert.equal(options[0].value, 'DEV00000');
            assert.equal(options[19999].value, 'DEV19999');

            const hint = options[options.length - 1];
            assert.match(hint.label, /仅显示前 20000 个/);
            assert.match(hint.label, /共 20001 个/);
            assert.ok(
                devices.some((entry) => entry.device === hint.value),
                'the hint entry must keep a device name as value'
            );
        });
    });

    // -----------------------------------------------------------------------
    // findDevice
    // -----------------------------------------------------------------------
    describe('findDevice', () => {
        it('looks devices up case-insensitively', () => {
            const catalog = sampleCatalog();
            const found = findDevice(catalog, 'sampledev1');
            assert.ok(found);
            assert.equal(found.device, 'SAMPLEDEV1');
            assert.equal(findDevice(catalog, '  SAMPLEDEV3 '), findDevice(catalog, 'SAMPLEDEV3'));
            assert.equal(findDevice(catalog, 'NOPE'), undefined);
            assert.equal(findDevice(undefined, 'SAMPLEDEV1'), undefined);
            assert.equal(findDevice(catalog, undefined), undefined);
            assert.equal(findDevice(catalog, '  '), undefined);
        });
    });

    // -----------------------------------------------------------------------
    // readDeviceDetails
    // -----------------------------------------------------------------------
    describe('readDeviceDetails', () => {
        it('reads memory, SVD and header from the pdsc', () => {
            const catalog = sampleCatalog();
            const device = findDevice(catalog, 'SAMPLEDEV1');
            assert.ok(device);

            const details = readDeviceDetails(device);
            assert.deepEqual(details.flash, { start: 0x08000000, size: 0x00100000 });
            assert.deepEqual(details.ram, { start: 0x20000000, size: 0x00020000 });
            assert.equal(details.svd, 'SVD/SAMPLEDEV1.svd');
            assert.equal(details.header, 'Device/Include/sampledev1.h');
            assert.deepEqual(details.warnings, []);
        });

        it('returns warnings instead of throwing for missing files and devices', () => {
            const base = tempDir('device-details-');
            const missing = readDeviceDetails({
                device: 'MISSING',
                vendor: 'Vendor',
                pdscPath: path.join(base, 'missing.pdsc')
            });
            assert.equal(missing.flash, undefined);
            assert.equal(missing.ram, undefined);
            assert.equal(missing.svd, undefined);
            assert.equal(missing.header, undefined);
            assert.equal(missing.warnings.length, 1);
            assert.match(missing.warnings[0], /无法读取设备描述文件/);

            const unknownDevice = readDeviceDetails({
                device: 'NOT_IN_PACK',
                vendor: 'Vendor',
                pdscPath: SAMPLE_PACK
            });
            assert.equal(unknownDevice.flash, undefined);
            assert.equal(unknownDevice.warnings.length, 1);
            assert.match(unknownDevice.warnings[0], /未找到/);
        });

        it('caches the parsed details without exposing the cached arrays', () => {
            const catalog = sampleCatalog();
            const device = findDevice(catalog, 'SAMPLEDEV2');
            assert.ok(device);

            const first = readDeviceDetails(device);
            assert.ok(first.flash);
            first.flash.start = 0;
            first.warnings.push('mutated');

            const second = readDeviceDetails(device);
            assert.ok(second.flash);
            assert.equal(second.flash.start, 0x08000000);
            assert.deepEqual(second.warnings, []);
        });
    });

    // -----------------------------------------------------------------------
    // buildCpuString
    // -----------------------------------------------------------------------
    describe('buildCpuString', () => {
        const arm6Cpu = 'IRAM(0x20000000,0x00020000) IROM(0x08000000,0x00100000) '
            + 'CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE';

        it('rebuilds the memory map of a Cortex-M4 device', () => {
            const catalog = sampleCatalog();
            const device = findDevice(catalog, 'SAMPLEDEV1');
            assert.ok(device);
            assert.equal(
                buildCpuString(device, arm6Cpu),
                'IRAM(0x20000000-0x2001ffff) IROM(0x8000000-0x80fffff) '
                    + 'CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE'
            );
            assert.equal(
                buildCpuString(device, undefined),
                'IRAM(0x20000000-0x2001ffff) IROM(0x8000000-0x80fffff) '
                    + 'CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE',
                'default CLOCK is 12000000'
            );
        });

        it('keeps the current CLOCK and does not add FPU/DSP/TZ for Cortex-M3', () => {
            const catalog = sampleCatalog();
            const device = findDevice(catalog, 'SAMPLEDEV3');
            assert.ok(device);
            const currentCpu = 'IRAM(0x20000000-0x20004FFF) IROM(0x8000000-0x801FFFF)  '
                + 'CLOCK(8000000) CPUTYPE("Cortex-M3") TZ';
            assert.equal(
                buildCpuString(device, currentCpu),
                'IRAM(0x20000000-0x2000ffff) IROM(0x8000000-0x807ffff) '
                    + 'CPUTYPE("Cortex-M3") CLOCK(8000000) ELITTLE'
            );
        });

        it('adds FPU2/DSP/TZ for a Cortex-M33 device', () => {
            const catalog = sampleCatalog();
            const device = findDevice(catalog, 'SAMPLEDEV2');
            assert.ok(device);
            assert.equal(
                buildCpuString(device, 'CLOCK(16000000)'),
                'IRAM(0x20000000-0x2003ffff) IROM(0x8000000-0x81fffff) '
                    + 'CPUTYPE("Cortex-M33") FPU2 DSP TZ CLOCK(16000000) ELITTLE'
            );
        });

        it('reuses the IRAM/IROM of the current Cpu when the pdsc has no memory', () => {
            const base = tempDir('device-cpu-');
            const pdscPath = writeTempPack(
                base,
                '        <device Dname="NOMEMDEV" Dcore="Cortex-M0"/>'
            );
            const parsed = parsePdscDevices(fs.readFileSync(pdscPath, 'utf8'), pdscPath);
            const device = parsed.devices[0];
            assert.equal(device.device, 'NOMEMDEV');
            assert.equal(
                buildCpuString(
                    device,
                    'IRAM(0x10000000-0x10000FFF) IROM(0x0-0xFFFF) CLOCK(4000000) CPUTYPE("Cortex-M0")'
                ),
                'IRAM(0x10000000-0x10000FFF) IROM(0x0-0xFFFF) '
                    + 'CPUTYPE("Cortex-M0") CLOCK(4000000) ELITTLE'
            );
        });

        it('falls back to the CPUTYPE of the current Cpu when the pdsc has no core', () => {
            const base = tempDir('device-cpu-core-');
            const pdscPath = writeTempPack(
                base,
                '        <device Dname="NOCOREDEV">\n'
                    + '          <memory name="IROM1" type="flash" start="0x0" size="0x10000"/>\n'
                    + '        </device>'
            );
            const parsed = parsePdscDevices(fs.readFileSync(pdscPath, 'utf8'), pdscPath);
            const device = parsed.devices[0];
            assert.equal(device.core, undefined);
            assert.equal(
                buildCpuString(device, 'CPUTYPE("Cortex-M3") CLOCK(8000000)'),
                'IROM(0x0-0xffff) CPUTYPE("Cortex-M3") CLOCK(8000000) ELITTLE'
            );
        });
    });

    // -----------------------------------------------------------------------
    // applyDeviceSelection
    // -----------------------------------------------------------------------
    describe('applyDeviceSelection', () => {
        it('updates only the selected target of arm-ac6.uvprojx', () => {
            const project = readFixture('arm-ac6.uvprojx');
            const result = applyDeviceSelection(project, 'Demo_Debug', 'SAMPLEDEV1', sampleCatalog());

            assert.deepEqual(result.changed, [
                'target.device',
                'target.vendor',
                'target.packId',
                'target.packUrl',
                'target.cpu',
                'target.sfdFile',
                'target.registerFile'
            ]);
            assert.deepEqual(result.warnings, []);
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'Device'), 'SAMPLEDEV1');
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'Vendor'), 'Sample Semiconductor');
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'PackID'), 'Keil.Sample_DFP.1.0.0');
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'PackURL'), 'https://example.com/packs/');
            assert.equal(
                fieldText(result.xml, 'Demo_Debug', 'Cpu'),
                'IRAM(0x20000000-0x2001ffff) IROM(0x8000000-0x80fffff) '
                    + 'CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE'
            );
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'SFDFile'), '$$Device:SAMPLEDEV1$SVD\\SAMPLEDEV1.svd');
            assert.equal(
                fieldText(result.xml, 'Demo_Debug', 'RegisterFile'),
                '$$Device:SAMPLEDEV1$Device\\Include\\sampledev1.h'
            );

            // The second target and every other byte stay untouched.
            assert.equal(targetBlock(result.xml, 'Demo_Release'), targetBlock(project, 'Demo_Release'));
            assert.ok(targetBlock(result.xml, 'Demo_Debug') !== targetBlock(project, 'Demo_Debug'));
            assert.ok(differingLines(project, result.xml) <= 8, 'diff must stay small');

            // The result is still valid XML.
            assert.ok(parseXml(result.xml).root);
        });

        it('creates a missing TargetCommonOption subtree exactly once', () => {
            const minimal = '<?xml version="1.0" encoding="UTF-8"?>\n'
                + '<Project>\n'
                + '  <Targets>\n'
                + '    <Target>\n'
                + '      <TargetName>Fresh</TargetName>\n'
                + '    </Target>\n'
                + '  </Targets>\n'
                + '</Project>\n';
            const result = applyDeviceSelection(minimal, 'Fresh', 'SAMPLEDEV1', sampleCatalog());

            assert.equal((result.xml.match(/<TargetOption>/g) || []).length, 1);
            assert.equal((result.xml.match(/<TargetCommonOption>/g) || []).length, 1);
            assert.deepEqual(result.changed, [
                'target.device',
                'target.vendor',
                'target.packId',
                'target.packUrl',
                'target.cpu',
                'target.sfdFile',
                'target.registerFile'
            ]);
            assert.equal(fieldText(result.xml, 'Fresh', 'Device'), 'SAMPLEDEV1');
            assert.equal(fieldText(result.xml, 'Fresh', 'PackID'), 'Keil.Sample_DFP.1.0.0');
            assert.ok(parseXml(result.xml).root);
        });

        it('is idempotent when the same device is applied twice', () => {
            const project = readFixture('arm-ac6.uvprojx');
            const catalog = sampleCatalog();
            const first = applyDeviceSelection(project, 'Demo_Debug', 'SAMPLEDEV1', catalog);
            const second = applyDeviceSelection(first.xml, 'Demo_Debug', 'SAMPLEDEV1', catalog);
            assert.equal(second.xml, first.xml);
            assert.deepEqual(second.changed, []);
        });

        it('rejects unknown targets, unknown devices and broken XML', () => {
            const project = readFixture('arm-ac6.uvprojx');
            const catalog = sampleCatalog();
            assert.throws(
                () => applyDeviceSelection(project, 'Missing_Target', 'SAMPLEDEV1', catalog),
                /目标不存在/
            );
            assert.throws(
                () => applyDeviceSelection(project, 'Demo_Debug', 'NOPE', catalog),
                /不在设备清单/
            );
            assert.throws(
                () => applyDeviceSelection(project, 'Demo_Debug', 'SAMPLEDEV1', undefined),
                /不在设备清单/
            );
            assert.throws(
                () => applyDeviceSelection('<Project><Targets>', 'Demo_Debug', 'SAMPLEDEV1', catalog),
                /Invalid XML/
            );
        });

        it('keeps the old PackID/PackURL when the device has no pack information', () => {
            const base = tempDir('device-apply-bare-');
            const project = readFixture('arm-ac6.uvprojx');
            const bareCatalog: DeviceCatalog = {
                generatedAt: '2024-01-01T00:00:00.000Z',
                packRoots: [],
                packs: [],
                warnings: [],
                devices: [
                    {
                        device: 'BARE',
                        vendor: 'Bare Vendor',
                        pdscPath: path.join(base, 'missing.pdsc')
                    }
                ]
            };
            const result = applyDeviceSelection(project, 'Demo_Debug', 'BARE', bareCatalog);

            // The fallback Cpu string is identical to the stored one, so no Cpu edit is emitted.
            assert.deepEqual(result.changed, ['target.device', 'target.vendor']);
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'PackID'), 'Keil.STM32F4xx_DFP.2.17.1');
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'PackURL'), 'https://www.keil.com/pack/');
            assert.equal(fieldText(result.xml, 'Demo_Debug', 'SFDFile'), '$$Device:STM32F407VGTx$Device\\STM32F4xx.svd');
            assert.equal(
                fieldText(result.xml, 'Demo_Debug', 'Cpu'),
                'IRAM(0x20000000,0x00020000) IROM(0x08000000,0x00100000) '
                    + 'CPUTYPE("Cortex-M4") FPU2 CLOCK(12000000) ELITTLE'
            );
            assert.ok(result.warnings.some((warning) => warning.indexOf('PackID') !== -1));
            assert.ok(result.warnings.some((warning) => warning.indexOf('PackURL') !== -1));
            assert.ok(result.warnings.some((warning) => warning.indexOf('无法读取设备描述文件') !== -1));
        });
    });

    // -----------------------------------------------------------------------
    // Real local installation (slow; only runs when packs are present)
    // -----------------------------------------------------------------------
    describe('local installation', () => {
        it('scans the real CMSIS-Pack installation when present', async function () {
            this.timeout(240000);
            const localAppData = process.env.LOCALAPPDATA;
            if (!localAppData) {
                this.skip();
                return;
            }
            const expectedPacks = path.join(localAppData, 'Arm', 'Packs');
            if (!fs.existsSync(expectedPacks)) {
                this.skip();
                return;
            }

            const toolsIniFile = 'C:\\Keil_v5\\TOOLS.INI';
            const toolsIniText = fs.existsSync(toolsIniFile)
                ? fs.readFileSync(toolsIniFile, 'utf8')
                : undefined;
            const roots = resolvePackRoots(toolsIniText, 'C:\\Keil_v5');
            assert.ok(roots.length > 0, 'expected at least one local pack root');

            const started = Date.now();
            const catalog = await scanDeviceCatalog(roots);
            const elapsed = Date.now() - started;
            // Mocha prints this line; it documents the real numbers of the machine.
            console.log(
                `[deviceDatabase] real scan: ${catalog.devices.length} devices / `
                    + `${catalog.packs.length} packs / ${catalog.warnings.length} warnings in ${elapsed} ms`
            );

            assert.ok(catalog.devices.length > 1000, `expected > 1000 devices, got ${catalog.devices.length}`);
            const device = findDevice(catalog, 'STM32F103CB');
            assert.ok(device, 'STM32F103CB must be found');
            assert.equal(device.core, 'Cortex-M3');
            assert.equal(device.vendor, 'STMicroelectronics');
            assert.match(device.packId || '', /^Keil\.STM32F1xx_DFP\./);

            const cpu = buildCpuString(device, undefined);
            assert.match(cpu, /CPUTYPE\("Cortex-M3"\)/);

            const cacheFile = path.join(tempDir('device-real-cache-'), 'catalog.json');
            writeCachedCatalog(cacheFile, catalog);
            const cached = readCachedCatalog(cacheFile);
            assert.ok(cached);
            assert.equal(cached.devices.length, catalog.devices.length);
            const cachedDevice = findDevice(cached, 'STM32F103CB');
            assert.ok(cachedDevice);
            assert.equal(cachedDevice.device, 'STM32F103CB');
        });
    });
});
