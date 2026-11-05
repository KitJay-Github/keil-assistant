import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    DRIVER_SELECTION_BASE,
    KeilToolsIni,
    cpuFamilyOf,
    driverSelectionOptions,
    findDriverByDll,
    parseToolsIni,
    readToolsIni,
    resolveDriverDllPath
} from '../project/options/keilInstall';

const FIXTURE_DIR = path.resolve(__dirname, '../../../src/test/fixtures');

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

function optionValues(options: Array<{ value: string; label: string }>): string[] {
    return options.map((option) => option.value);
}

describe('keilInstall', () => {
    const tempDirs: string[] = [];

    after(() => {
        tempDirs.forEach(removeDir);
    });

    it('parses the [ARM] section of a real TOOLS.INI', () => {
        const tools = parseToolsIni(readFixture('tools-default.ini'));
        assert.ok(tools.arm, 'expected an [ARM] section');
        const arm = tools.arm!;

        assert.equal(arm.version, '5.36');
        assert.equal(arm.installPath, 'C:\\Keil_v5\\ARM\\');
        assert.equal(arm.drivers.length, 19);
        assert.equal(arm.groups.length, 4);

        const cortexM = arm.groups.find((group) => group.cpuDll === 'SARMCM3.DLL');
        assert.ok(cortexM);
        assert.deepEqual(cortexM!.driverIds, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert.match(cortexM!.comment || '', /Cortex-M/);

        const ulink2 = arm.drivers.find((driver) => driver.tdrvId === 0);
        assert.ok(ulink2);
        assert.equal(ulink2!.dll, 'BIN\\UL2CM3.DLL');
        assert.equal(ulink2!.name, 'ULINK2/ME Cortex Debugger');

        const jlink = arm.drivers.find((driver) => driver.tdrvId === 4);
        assert.ok(jlink);
        assert.equal(jlink!.name, 'J-LINK / J-TRACE Cortex');

        // No C51 / C251 sections in the fixture.
        assert.equal(tools.c51, undefined);
        assert.equal(tools.c251, undefined);
    });

    it('derives the CPU family from Cpu strings and the toolchain', () => {
        const cortexM3 = 'IRAM(0x20000000,0x00020000) IROM(0x08000000,0x00100000) CPUTYPE("Cortex-M3") CLOCK(12000000)';
        const cortexM4 = 'IRAM(0x20000000,0x00020000) IROM(0x08000000,0x00100000) CPUTYPE("Cortex-M4") FPU2 CLOCK(168000000) ELITTLE';
        const cortexM33 = 'IRAM(0x20000000,0x00020000) IROM(0x08000000,0x00100000) CPUTYPE("Cortex-M33") FPU2 DSP TZ CLOCK(16000000)';
        const cortexR4 = 'IRAM(0x20000000,0x00020000) IROM(0x08000000,0x00100000) CPUTYPE("Cortex-R4") CLOCK(12000000)';
        const arm7 = 'CLOCK(12000000) CPUTYPE("ARM7TDMI")';
        const armNoCore = 'IRAM(0-0x7F) IROM(0-0xFFF) CLOCK(12000000)';

        assert.equal(cpuFamilyOf(cortexM3, 'ARM'), 'cortex-m');
        assert.equal(cpuFamilyOf(cortexM4, 'ARM6'), 'cortex-m');
        assert.equal(cpuFamilyOf(cortexM33, 'ARM6'), 'armv8-m');
        assert.equal(cpuFamilyOf(cortexR4, 'ARM'), 'cortex-r');
        assert.equal(cpuFamilyOf(arm7, 'ARM'), 'arm7');
        assert.equal(cpuFamilyOf(armNoCore, 'ARM'), 'cortex-m');
        assert.equal(cpuFamilyOf(undefined, 'C51'), 'c51');
        assert.equal(cpuFamilyOf(undefined, 'C251'), 'c251');
    });

    it('builds the DriverSelection list from the local installation', () => {
        const tools = parseToolsIni(readFixture('tools-default.ini'));

        const cortexMOptions = driverSelectionOptions(tools, 'cortex-m');
        // -1, 0 + 12 Cortex-M drivers.
        assert.equal(cortexMOptions.length, 14);
        assert.equal(cortexMOptions[0].value, '-1');
        assert.equal(cortexMOptions[1].value, '0');
        assert.equal(cortexMOptions[2].value, String(DRIVER_SELECTION_BASE));
        assert.match(cortexMOptions[2].label, /ULINK2\/ME Cortex Debugger/);
        assert.equal(cortexMOptions[6].value, String(DRIVER_SELECTION_BASE + 4));
        assert.match(cortexMOptions[6].label, /J-LINK/);
        assert.equal(cortexMOptions[cortexMOptions.length - 1].value, String(DRIVER_SELECTION_BASE + 11));
        assert.match(cortexMOptions[cortexMOptions.length - 1].label, /TI XDS/);

        const v8mOptions = driverSelectionOptions(tools, 'armv8-m');
        // -1, 0 + 9 ARMv8-M drivers; index 5/6 are the ARMv8-M ULINK variants.
        assert.equal(v8mOptions.length, 11);
        assert.equal(v8mOptions[7].value, String(DRIVER_SELECTION_BASE + 5));
        assert.match(v8mOptions[7].label, /ULINK Pro ARMv8-M/);
        assert.match(v8mOptions[8].label, /ULINK2\/ME ARMv8-M/);

        const arm7Options = driverSelectionOptions(tools, 'arm7');
        assert.equal(arm7Options.length, 5);
        assert.match(arm7Options[2].label, /ULINK2\/ME ARM Debugger/);

        // The fixture has no [C51] section: only the two stable entries.
        const c51Options = driverSelectionOptions(tools, 'c51');
        assert.deepEqual(optionValues(c51Options), ['-1', '0']);
    });

    it('falls back to the default MDK driver names without a local TOOLS.INI', () => {
        const options = driverSelectionOptions(undefined, 'cortex-m');
        // -1, 0 + 12 default names + one "other driver" entry.
        assert.equal(options.length, 15);
        assert.match(options[2].label, /ULINK2\/ME Cortex Debugger/);
        assert.match(options[13].label, /TI XDS Debugger/);
        assert.match(options[14].label, /其他驱动/);

        assert.deepEqual(optionValues(driverSelectionOptions(undefined, 'c51')), ['-1', '0']);
    });

    it('resolves a driver definition from a DLL path written in a project', () => {
        const tools = parseToolsIni(readFixture('tools-default.ini'));

        assert.equal(findDriverByDll(tools, 'BIN\\UL2CM3.DLL')!.name, 'ULINK2/ME Cortex Debugger');
        assert.equal(findDriverByDll(tools, 'segger/jl2cm3.dll')!.name, 'J-LINK / J-TRACE Cortex');
        assert.equal(findDriverByDll(tools, 'BIN\\CMSIS_AGDI_V8M.DLL')!.name, 'CMSIS-DAP ARMv8-M Debugger');
        assert.equal(findDriverByDll(tools, 'STLink\\ST-LINKIII-KEIL_SWO.dll')!.name, 'ST-Link Debugger');
        assert.equal(findDriverByDll(tools, 'BIN\\lmidk-agdi.dll'), undefined);
        assert.equal(findDriverByDll(tools, ''), undefined);
        assert.equal(findDriverByDll(undefined, 'BIN\\UL2CM3.DLL'), undefined);
    });

    it('reads TOOLS.INI from an installation root', () => {
        const dir = makeTempDir('keil-tools-');
        tempDirs.push(dir);
        fs.writeFileSync(path.join(dir, 'TOOLS.INI'), readFixture('tools-default.ini'), 'utf8');

        const tools: KeilToolsIni | undefined = readToolsIni(dir);
        assert.ok(tools);
        assert.equal(tools!.arm!.version, '5.36');
        assert.equal(readToolsIni(path.join(dir, 'missing')), undefined);
        assert.equal(readToolsIni(undefined), undefined);
    });

    it('resolves driver DLL paths against the installation layout', () => {
        const dir = makeTempDir('keil-drivers-');
        tempDirs.push(dir);

        const armBin = path.join(dir, 'ARM', 'BIN');
        const c51Bin = path.join(dir, 'C51', 'BIN');
        fs.mkdirSync(armBin, { recursive: true });
        fs.mkdirSync(c51Bin, { recursive: true });
        fs.writeFileSync(path.join(armBin, 'UL2CM3.DLL'), 'x');
        fs.writeFileSync(path.join(c51Bin, 'STCMON.DLL'), 'x');
        fs.writeFileSync(path.join(dir, 'Root.DLL'), 'x');

        assert.equal(
            resolveDriverDllPath(dir, 'ARM', 'BIN\\UL2CM3.DLL'),
            path.join(armBin, 'UL2CM3.DLL')
        );
        assert.equal(
            resolveDriverDllPath(dir, 'C51', 'BIN\\STCMON.DLL'),
            path.join(c51Bin, 'STCMON.DLL')
        );
        assert.equal(resolveDriverDllPath(dir, 'ARM', 'Root.DLL'), path.join(dir, 'Root.DLL'));
        assert.equal(resolveDriverDllPath(dir, 'ARM', 'BIN\\MISSING.DLL'), undefined);
        assert.equal(resolveDriverDllPath(undefined, 'ARM', 'BIN\\UL2CM3.DLL'), undefined);
        assert.equal(resolveDriverDllPath(dir, 'ARM', ''), undefined);

        const absolute = path.join(armBin, 'UL2CM3.DLL');
        assert.equal(resolveDriverDllPath(dir, 'ARM', absolute), absolute);
        assert.equal(resolveDriverDllPath(dir, 'ARM', path.join(dir, 'missing.dll')), undefined);
    });

    it('works with the real local Keil installation when present', () => {
        const keilRoot = 'C:\\Keil_v5';
        if (!fs.existsSync(path.join(keilRoot, 'TOOLS.INI'))) {
            return;
        }
        const tools = readToolsIni(keilRoot);
        assert.ok(tools);
        const options = driverSelectionOptions(tools, 'cortex-m');
        assert.ok(options.length >= 14, `expected a full Cortex-M list, got ${options.length}`);
        assert.equal(
            resolveDriverDllPath(keilRoot, 'ARM', 'BIN\\UL2CM3.DLL'),
            path.join(keilRoot, 'ARM', 'BIN', 'UL2CM3.DLL')
        );
    });
});
