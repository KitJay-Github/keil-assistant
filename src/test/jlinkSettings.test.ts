import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    JLINK_CLOCK_OPTIONS,
    applyJlinkSettings,
    isJlinkDriver,
    readJlinkSettings
} from '../project/options/jlinkSettings';
import { buildOptionsViewData } from '../project/options/viewData';
import { parseXml } from '../project/uvXml';

const FIXTURE_DIR = path.resolve(__dirname, '../../../src/test/fixtures');

function fixturePath(name: string): string {
    return path.join(FIXTURE_DIR, name);
}

function readFixture(name: string): string {
    return fs.readFileSync(fixturePath(name), 'utf8');
}

function jlinkFlags(xml: string): string {
    const match = /<Key>JL2CM3<\/Key>\s*<Name>([\s\S]*?)<\/Name>/.exec(xml);
    assert.ok(match, 'JL2CM3 entry missing');
    return (match as RegExpExecArray)[1];
}

describe('jlinkSettings', () => {
    const uvopt = readFixture('arm-ac6-jlink.uvoptx');

    it('detects the J-Link driver DLL names', () => {
        assert.equal(isJlinkDriver('Segger\\JL2CM3.dll'), true);
        assert.equal(isJlinkDriver('BIN/jl2cm3.DLL'), true);
        assert.equal(isJlinkDriver('Segger\\JLTAgdi.dll'), true);
        assert.equal(isJlinkDriver('BIN\\UL2CM3.DLL'), false);
        assert.equal(isJlinkDriver(''), false);
        assert.equal(isJlinkDriver(undefined), false);
    });

    it('reads the adapter settings from the registry entry', () => {
        const settings = readJlinkSettings(uvopt, 'Demo_Debug');
        assert.ok(settings, 'settings missing');
        assert.equal(settings!.driverKey, 'JL2CM3');
        assert.equal(settings!.port, 'sw');
        assert.equal(settings!.maxClockKhz, 10000);
        assert.equal(settings!.connect, 'normal');
        assert.equal(settings!.reset, 'normal');
        assert.equal(settings!.resetAfter, true);
        assert.equal(settings!.interface, 'usb');
        assert.equal(settings!.ip, '127.0.0.1');
        assert.equal(settings!.tcpPort, 0);
    });

    it('writes every adapter option and keeps the rest of the project intact', () => {
        const patch = {
            port: 'jtag' as const,
            maxClockKhz: 5000,
            connect: 'under-reset' as const,
            reset: 'connect-under-reset',
            resetAfter: false,
            interface: 'tcp' as const,
            ip: '192.168.1.20',
            tcpPort: 19020
        };
        const result = applyJlinkSettings(uvopt, 'Demo_Debug', patch);
        assert.deepEqual(result.changed.sort(), [
            'jlink.connect', 'jlink.interface', 'jlink.ip', 'jlink.maxClock',
            'jlink.port', 'jlink.reset', 'jlink.resetAfter', 'jlink.tcpPort'
        ]);
        assert.deepEqual(result.warnings, []);

        const flags = jlinkFlags(result.xml);
        assert.match(flags, /-O15\b/);
        assert.match(flags, /-S2\b/);
        assert.match(flags, /-ZTIFSpeedSel5000\b/);
        assert.match(flags, /-C2\b/);
        assert.match(flags, /-RST3\b/);
        assert.match(flags, /-JU0\b/);
        assert.match(flags, /-JI192\.168\.1\.20\b/);
        assert.match(flags, /-JP19020\b/);
        // Unrelated parts of the flag string survive.
        assert.match(flags, /-U20090928/);
        assert.match(flags, /-D00\(1BA01477\)/);
        assert.match(flags, /-FF0STM32F10x_128\.FLM/);

        parseXml(result.xml); // must stay valid XML

        const readBack = readJlinkSettings(result.xml, 'Demo_Debug');
        assert.equal(readBack!.port, 'jtag');
        assert.equal(readBack!.maxClockKhz, 5000);
        assert.equal(readBack!.connect, 'under-reset');
        assert.equal(readBack!.reset, 'connect-under-reset');
        assert.equal(readBack!.resetAfter, false);
        assert.equal(readBack!.interface, 'tcp');
        assert.equal(readBack!.ip, '192.168.1.20');
        assert.equal(readBack!.tcpPort, 19020);

        // Applying the same values again is a no-op.
        assert.equal(applyJlinkSettings(result.xml, 'Demo_Debug', patch).xml, result.xml);

        // Other targets and other registry keys are untouched.
        const otherTarget = result.xml.slice(result.xml.indexOf('<TargetName>Demo_Release</TargetName>'));
        assert.equal(otherTarget.indexOf('-ZTIFSpeedSel5000') !== -1, false);
        assert.match(result.xml, /<Key>UL2CM3<\/Key>/);
    });

    it('handles single-field changes without touching the other flags', () => {
        const speed = applyJlinkSettings(uvopt, 'Demo_Debug', { maxClockKhz: 50000 });
        assert.match(jlinkFlags(speed.xml), /-S8\b/);
        assert.match(jlinkFlags(speed.xml), /-ZTIFSpeedSel50000\b/);
        assert.match(jlinkFlags(speed.xml), /-O78\b/);
        assert.match(jlinkFlags(speed.xml), /-C0\b/);

        const connect = applyJlinkSettings(uvopt, 'Demo_Debug', { connect: 'pre-reset' });
        assert.match(jlinkFlags(connect.xml), /-C1\b/);
        assert.match(jlinkFlags(connect.xml), /-ZTIFSpeedSel10000\b/);

        const reset = applyJlinkSettings(uvopt, 'Demo_Debug', { reset: 'adi-halt-after-kernel' });
        assert.match(jlinkFlags(reset.xml), /-RST7\b/);

        const after = applyJlinkSettings(uvopt, 'Demo_Debug', { resetAfter: false });
        assert.match(jlinkFlags(after.xml), /-O79\b/);
        const afterOn = applyJlinkSettings(after.xml, 'Demo_Debug', { resetAfter: true });
        assert.match(jlinkFlags(afterOn.xml), /-O78\b/);

        const tcp = applyJlinkSettings(uvopt, 'Demo_Debug', { interface: 'tcp' });
        assert.match(jlinkFlags(tcp.xml), /-JU0\b/);
        const usb = applyJlinkSettings(tcp.xml, 'Demo_Debug', { interface: 'usb' });
        assert.match(jlinkFlags(usb.xml), /-JU1\b/);
    });

    it('exposes the full clock list', () => {
        assert.equal(JLINK_CLOCK_OPTIONS.length, 11);
        assert.equal(JLINK_CLOCK_OPTIONS[0].khz, 50000);
        assert.equal(JLINK_CLOCK_OPTIONS[JLINK_CLOCK_OPTIONS.length - 1].khz, 200);
        const codes = new Set(JLINK_CLOCK_OPTIONS.map((option) => option.code));
        assert.equal(codes.size, JLINK_CLOCK_OPTIONS.length);
    });

    it('warns instead of modifying a project without a J-Link registry entry', () => {
        const withoutRegistry = readFixture('arm-ac6.uvoptx');
        assert.equal(readJlinkSettings(withoutRegistry, 'Demo_Debug'), undefined);
        const result = applyJlinkSettings(withoutRegistry, 'Demo_Debug', { port: 'jtag' });
        assert.equal(result.xml, withoutRegistry);
        assert.deepEqual(result.changed, []);
        assert.ok(result.warnings[0].indexOf('J-Link 驱动记录') !== -1);
    });

    it('throws for unknown targets', () => {
        assert.throws(() => applyJlinkSettings(uvopt, 'Missing', { port: 'jtag' }), /目标不存在/);
    });

    it('renders the J-Link section in the Options panel only when the entry exists', () => {
        const withEntry = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: readFixture('arm-ac6.uvprojx'),
            uvoptText: uvopt
        });
        const debugTab = withEntry.tabs.find((tab) => tab.id === 'debug')!;
        const section = debugTab.sections.find((entry) => entry.id === 'debug.jlink');
        assert.ok(section, 'J-Link section missing');
        assert.equal(section!.fields.length, 8);
        const port = section!.fields.find((field) => field.id === 'jlink.port')!;
        assert.equal(port.type, 'enum');
        assert.equal(port.value, 'sw');
        assert.ok(port.options && port.options.length === 2);
        const speed = section!.fields.find((field) => field.id === 'jlink.maxClock')!;
        assert.equal(speed.value, '10000');
        const after = section!.fields.find((field) => field.id === 'jlink.resetAfter')!;
        assert.equal(after.type, 'bool');
        assert.equal(after.value, '1');

        const withoutEntry = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: readFixture('arm-ac6.uvprojx'),
            uvoptText: readFixture('arm-ac6.uvoptx')
        });
        const debugTab2 = withoutEntry.tabs.find((tab) => tab.id === 'debug')!;
        assert.equal(debugTab2.sections.some((entry) => entry.id === 'debug.jlink'), false);
    });
});
