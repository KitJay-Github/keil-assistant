import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { buildOptionsViewData } from '../project/options/viewData';
import { OptionFieldView, OptionTabView } from '../project/options/types';

const FIXTURE_DIR = path.resolve(__dirname, '../../../src/test/fixtures');

function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function fixturePath(name: string): string {
    return path.join(FIXTURE_DIR, name);
}

function allFields(tabs: OptionTabView[]): OptionFieldView[] {
    return tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fields));
}

function findField(view: ReturnType<typeof buildOptionsViewData>, id: string): OptionFieldView {
    const field = allFields(view.tabs).find((entry) => entry.id === id);
    assert.ok(field, `field ${id} not rendered`);
    return field as OptionFieldView;
}

function findSection(view: ReturnType<typeof buildOptionsViewData>, tabId: string, sectionId: string) {
    const tab = view.tabs.find((entry) => entry.id === tabId);
    assert.ok(tab, `tab ${tabId} missing`);
    const section = tab!.sections.find((entry) => entry.id === sectionId);
    assert.ok(section, `section ${sectionId} missing in tab ${tabId}`);
    return section!;
}

describe('Options info sections (MCU / debugger / driver list)', () => {
    const arm6Text = readFixture('arm-ac6.uvprojx');
    const arm6Uvopt = readFixture('arm-ac6.uvoptx');
    const toolsIni = readFixture('tools-default.ini');

    it('renders a read-only MCU information section on the target tab', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt
        });

        const targetTab = view.tabs.find((tab) => tab.id === 'target')!;
        assert.equal(targetTab.sections[0].id, 'target.mcu');
        assert.match(targetTab.sections[0].title, /MCU 信息/);

        assert.equal(findField(view, 'mcu.device').value, 'STM32F407VGTx');
        assert.match(findField(view, 'mcu.core').value, /Cortex-M4/);
        assert.match(findField(view, 'mcu.flash').value, /1 MB/);
        assert.match(findField(view, 'mcu.flash').value, /0x08000000/);
        assert.match(findField(view, 'mcu.ram').value, /128 KB/);
        assert.match(findField(view, 'mcu.clock').value, /12 MHz/);
        assert.match(findField(view, 'mcu.features').value, /FPU/);

        // Every generated MCU row is a read-only info field.
        for (const section of targetTab.sections.filter((entry) => entry.id === 'target.mcu')) {
            for (const field of section.fields) {
                assert.equal(field.type, 'info');
                assert.equal(field.readonly, true);
            }
        }
    });

    it('lists the drivers of the local installation and explains the stored number', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            keilToolsIniText: toolsIni
        });

        const selection = findField(view, 'utilities.driverSelection');
        assert.equal(selection.type, 'enum');
        assert.ok(selection.options && selection.options.length === 14, `expected 14 options, got ${selection.options?.length}`);
        const first = selection.options![2];
        assert.equal(first.value, '4096');
        assert.match(first.label, /ULINK2\/ME Cortex Debugger/);

        // The fixture stores DriverSelection=4096, so the info row must resolve it.
        const meaning = findField(view, 'info.utilities.driverSelection');
        assert.equal(meaning.type, 'info');
        assert.match(meaning.value, /4096/);
        assert.match(meaning.value, /ULINK2\/ME Cortex Debugger/);

        // Without a local TOOLS.INI the fallback list is used and a warning is emitted.
        const fallback = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt
        });
        const fallbackSelection = findField(fallback, 'utilities.driverSelection');
        assert.ok(fallbackSelection.options && fallbackSelection.options.length >= 14);
        assert.ok(
            fallback.warnings.some((warning) => warning.indexOf('TOOLS.INI') !== -1),
            'expected a TOOLS.INI warning'
        );
    });

    it('renders resolved debugger and flash driver information on the debug tab', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            keilToolsIniText: toolsIni,
            debuggerInfo: {
                uvisionPath: 'C:\\Keil_v5\\UV4\\UV4.exe',
                uvisionVersion: '5.36.0.0',
                driverName: 'CMSIS-DAP Debugger',
                driverDll: 'BIN\\CMSIS_AGDI.dll',
                driverVersion: '2.5.0.0',
                driverSource: '.uvoptx（DebugOpt/pMon）',
                flashDll: 'BIN\\CMSIS_AGDI.dll',
                flashVersion: '2.5.0.0'
            }
        });

        const debugTab = view.tabs.find((tab) => tab.id === 'debug')!;
        const section = debugTab.sections[debugTab.sections.length - 1];
        assert.equal(section.id, 'debug.hardware');
        assert.match(section.title, /调试器/);

        assert.equal(findField(view, 'info.debugger.name').value, 'CMSIS-DAP Debugger');
        assert.equal(findField(view, 'info.debugger.dll').value, 'BIN\\CMSIS_AGDI.dll');
        assert.equal(findField(view, 'info.debugger.version').value, '2.5.0.0');
        assert.equal(findField(view, 'info.debugger.flashDll').value, 'BIN\\CMSIS_AGDI.dll');
        assert.equal(findField(view, 'info.debugger.flashVersion').value, '2.5.0.0');
        assert.equal(findField(view, 'info.debugger.uvision').value, '5.36.0.0');
    });

    it('describes a missing debugger configuration instead of hiding the section', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            debuggerInfo: {}
        });
        const placeholder = findField(view, 'info.debugger.none');
        assert.equal(placeholder.value, '—');
        assert.ok(placeholder.hint && placeholder.hint.length > 0);
    });

    it('renders C51 MCU information and keeps the driver list minimal', () => {
        const view = buildOptionsViewData({
            projectLabel: 'C51',
            projectFile: fixturePath('c51.uvproj'),
            uvprojxText: readFixture('c51.uvproj'),
            activeTarget: 'C51_Debug',
            keilToolsIniText: toolsIni
        });

        const targetTab = view.tabs.find((tab) => tab.id === 'target')!;
        assert.equal(targetTab.sections[0].id, 'target.mcu');
        assert.match(findField(view, 'mcu.core').value, /MCS-51/);
        assert.match(findField(view, 'mcu.flash').value, /4 KB/);
        assert.match(findField(view, 'mcu.ram').value, /128 B/);
        // C51 projects must not expose ARM debugger entries.
        const selection = findField(view, 'utilities.driverSelection');
        assert.deepEqual((selection.options || []).map((option) => option.value), ['-1', '0']);
        // ARM-only rows are not rendered for C51.
        assert.equal(allFields(view.tabs).some((field) => field.id === 'mcu.svdFile'), false);
    });

    it('keeps the section out of the way when the target is unknown', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Broken',
            projectFile: 'X:\\broken.uvprojx',
            uvprojxText: '<Project><Targets/></Project>',
            debuggerInfo: { uvisionVersion: '5.36.0.0' }
        });
        assert.equal(view.tabs.length, 7);
        assert.equal(allFields(view.tabs).some((field) => field.id === 'mcu.device'), false);
        assert.equal(allFields(view.tabs).some((field) => field.id === 'info.utilities.driverSelection'), false);
    });
});
