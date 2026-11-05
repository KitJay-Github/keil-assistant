import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { buildOptionsViewData } from '../project/options/viewData';
import { DeviceCatalog } from '../project/options/deviceDatabase';
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

function findField(view: ReturnType<typeof buildOptionsViewData>, id: string): OptionFieldView | undefined {
    return allFields(view.tabs).find((entry) => entry.id === id);
}

function makeCatalog(): DeviceCatalog {
    return {
        generatedAt: new Date().toISOString(),
        packRoots: ['C:\\packs'],
        packs: [
            { vendor: 'Keil', name: 'STM32F1xx_DFP', version: '2.3.0', pdscPath: 'C:\\packs\\a.pdsc', deviceCount: 2 }
        ],
        warnings: [],
        devices: [
            {
                device: 'STM32F103CB',
                vendor: 'STMicroelectronics',
                vendorId: 'STMicroelectronics:13',
                core: 'Cortex-M3',
                packVendor: 'Keil',
                packName: 'STM32F1xx_DFP',
                packVersion: '2.3.0',
                packId: 'Keil.STM32F1xx_DFP.2.3.0',
                packUrl: 'http://www.keil.com/pack/',
                pdscPath: 'C:\\packs\\a.pdsc'
            },
            {
                device: 'STM32F407VGTx',
                vendor: 'STMicroelectronics',
                vendorId: 'STMicroelectronics:13',
                core: 'Cortex-M4',
                packVendor: 'Keil',
                packName: 'STM32F4xx_DFP',
                packVersion: '2.17.1',
                packId: 'Keil.STM32F4xx_DFP.2.17.1',
                pdscPath: 'C:\\packs\\b.pdsc'
            }
        ]
    };
}

describe('Options pickers (device / debugger)', () => {
    const arm6Text = readFixture('arm-ac6.uvprojx');
    const arm6Uvopt = readFixture('arm-ac6.uvoptx');
    const toolsIni = readFixture('tools-default.ini');

    it('renders the device picker from the local pack catalog', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            deviceCatalog: makeCatalog()
        });

        const field = findField(view, 'target.deviceSelect');
        assert.ok(field, 'device picker missing');
        assert.equal(field!.type, 'enum');
        assert.equal(field!.value, 'STM32F407VGTx');
        assert.ok(field!.options && field!.options.length === 2, `expected 2 options, got ${field!.options?.length}`);
        assert.ok(field!.options!.some((option) => option.value === 'STM32F103CB'));
        assert.match(field!.hint || '', /2 个器件/);

        const targetTab = view.tabs.find((tab) => tab.id === 'target')!;
        assert.equal(targetTab.sections[0].id, 'target.mcu');
        assert.ok(targetTab.sections.some((section) => section.id === 'target.devicePicker'));
        assert.equal(
            view.warnings.some((warning) => warning.indexOf('CMSIS-Pack') !== -1),
            false,
            'catalog available: no pack warning expected'
        );
    });

    it('explains a missing or in-progress pack scan instead of hiding the picker', () => {
        const missing = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt
        });
        const missingField = findField(missing, 'target.deviceSelect');
        assert.ok(missingField, 'device picker must stay visible while scanning/missing');
        assert.equal(missingField!.value, 'STM32F407VGTx');
        assert.deepEqual((missingField!.options || []).map((option) => option.value), ['STM32F407VGTx']);
        assert.match(missingField!.hint || '', /未找到本机 CMSIS-Pack/);
        assert.ok(missing.warnings.some((warning) => warning.indexOf('CMSIS-Pack') !== -1));

        const scanning = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            deviceCatalogScanning: true
        });
        const scanningField = findField(scanning, 'target.deviceSelect')!;
        assert.match(scanningField.hint || '', /正在扫描/);
        assert.ok(scanning.warnings.some((warning) => warning.indexOf('正在扫描') !== -1));
    });

    it('renders the debugger picker from the local TOOLS.INI driver list', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            keilToolsIniText: toolsIni
        });

        const field = findField(view, 'debug.debugger');
        assert.ok(field, 'debugger picker missing');
        assert.equal(field!.type, 'enum');
        assert.equal(field!.value, '0', 'arm-ac6 fixture has nTsel=0');
        // sim + 12 Cortex-M drivers.
        assert.equal(field!.options?.length, 13, `expected 13 options, got ${field!.options?.length}`);
        assert.equal(field!.options![0].value, 'sim');
        assert.equal(field!.options![1].value, '0');
        assert.match(field!.options![1].label, /ULINK2\/ME Cortex Debugger/);
        assert.match(field!.hint || '', /ULINK2\/ME Cortex Debugger/);

        const debugTab = view.tabs.find((tab) => tab.id === 'debug')!;
        assert.equal(debugTab.sections[0].id, 'debug.debuggerPicker');
    });

    it('reports the simulator choice and hides the picker without a companion file', () => {
        const simulatorText = arm6Uvopt.replace('<uSim>0</uSim>', '<uSim>1</uSim>').replace('<uTrg>1</uTrg>', '<uTrg>0</uTrg>');
        const simulator = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            uvoptText: simulatorText,
            keilToolsIniText: toolsIni
        });
        const field = findField(simulator, 'debug.debugger')!;
        assert.equal(field.value, 'sim');
        assert.match(field.hint || '', /仿真器/);

        const withoutUvopt = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: fixturePath('arm-ac6.uvprojx'),
            uvprojxText: arm6Text,
            keilToolsIniText: toolsIni
        });
        assert.equal(findField(withoutUvopt, 'debug.debugger'), undefined);

        const c51 = buildOptionsViewData({
            projectLabel: 'C51',
            projectFile: fixturePath('c51.uvproj'),
            uvprojxText: readFixture('c51.uvproj'),
            keilToolsIniText: toolsIni
        });
        assert.equal(findField(c51, 'debug.debugger'), undefined, 'C51 keeps the picker hidden');
    });
});
