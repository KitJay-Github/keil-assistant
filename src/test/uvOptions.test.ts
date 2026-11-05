import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseXml } from '../project/uvXml';
import {
    OPTION_FIELDS,
    OPTION_TABS,
    getOptionField
} from '../project/options/uvOptionSchema';
import {
    applyTargetOptions,
    detectTargetToolchain,
    normalizeOptionValue,
    readTargetOptions,
    toolchainLabel
} from '../project/options/uvOptions';
import { OptionFieldDef, UvToolchainKind } from '../project/options/types';

function fixturePath(name: string): string {
    return path.resolve(__dirname, '../../../src/test/fixtures', name);
}

function readFixture(name: string): string {
    return fs.readFileSync(fixturePath(name), 'utf8');
}

const TOOLCHAIN_FIXTURES: Array<{ file: string; target: string; toolchain: UvToolchainKind }> = [
    { file: 'arm-ac6.uvprojx', target: 'Demo_Debug', toolchain: 'ARM6' },
    { file: 'arm-ac5.uvproj', target: 'ARM_Debug', toolchain: 'ARM' },
    { file: 'c51.uvproj', target: 'C51_Debug', toolchain: 'C51' },
    { file: 'c251.uvproj', target: 'C251_Debug', toolchain: 'C251' }
];

function collectDefinedValues(values: Record<string, string | undefined>): Record<string, string> {
    const defined: Record<string, string> = {};
    for (const id of Object.keys(values)) {
        const value = values[id];
        if (value !== undefined) {
            defined[id] = value;
        }
    }
    return defined;
}

const MINIMAL_ARM6_PROJECT = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<Project>
  <Targets>
    <Target>
      <TargetName>T1</TargetName>
      <uAC6>1</uAC6>
      <TargetOption>
        <TargetArmAds>
          <Cads>
            <VariousControls></VariousControls>
          </Cads>
        </TargetArmAds>
      </TargetOption>
    </Target>
  </Targets>
</Project>
`;

describe('uvOptionSchema', () => {
    it('declares the seven option tabs in dialog order', () => {
        assert.deepEqual(
            OPTION_TABS.map((tab) => tab.id),
            ['target', 'output', 'ccpp', 'asm', 'linker', 'debug', 'utilities']
        );
        for (const tab of OPTION_TABS) {
            assert.ok(tab.title.length > 0, `${tab.id} needs a title`);
            assert.ok(tab.sections.length > 0, `${tab.id} needs sections`);
        }
    });

    it('uses stable <tab>.<name> field ids and Chinese labels with English hints', () => {
        const ids = new Set<string>();
        for (const tab of OPTION_TABS) {
            for (const section of tab.sections) {
                assert.ok(section.fields.length > 0, `${section.id} needs fields`);
                for (const optionField of section.fields) {
                    assert.equal(ids.has(optionField.id), false, `duplicated field id ${optionField.id}`);
                    ids.add(optionField.id);
                    assert.ok(
                        optionField.id.startsWith(`${tab.id}.`),
                        `${optionField.id} must start with ${tab.id}.`
                    );
                    assert.match(optionField.label, /[\u4e00-\u9fa5]/, `${optionField.id} label must be Chinese`);
                    assert.ok(optionField.hint, `${optionField.id} needs an English hint`);
                    assert.match(optionField.hint || '', /^[\x20-\x7E]+$/, `${optionField.id} hint must be ASCII`);
                }
            }
        }
        assert.equal(OPTION_FIELDS.length, ids.size);
    });

    it('only declares toolchains that really emit the element', () => {
        const validToolchains: UvToolchainKind[] = ['ARM', 'ARM6', 'C51', 'C251'];
        for (const optionField of OPTION_FIELDS) {
            const keys = Object.keys(optionField.path);
            assert.ok(keys.length > 0, `${optionField.id} declares no toolchain path`);
            for (const key of keys) {
                assert.ok(validToolchains.includes(key as UvToolchainKind), `${optionField.id}: ${key}`);
                const segments = optionField.path[key as UvToolchainKind];
                assert.ok(segments && segments.length > 0, `${optionField.id}: empty path for ${key}`);
            }
            assert.equal(optionField.file === 'uvprojx' || optionField.file === 'uvopt', true);
        }
    });

    it('declares enum values for enum fields and keeps bool values implicit', () => {
        for (const optionField of OPTION_FIELDS) {
            if (optionField.type === 'enum') {
                assert.ok(optionField.enumValues && optionField.enumValues.length > 0, optionField.id);
                const values = (optionField.enumValues || []).map((entry) => entry.value);
                assert.equal(new Set(values).size, values.length, `${optionField.id} has duplicate enum values`);
            }
            if (optionField.type === 'bool') {
                assert.equal(optionField.enumValues, undefined, `${optionField.id} bool should not have enumValues`);
            }
            if (optionField.type === 'number') {
                assert.ok(optionField.numeric, `${optionField.id} number should declare numeric bounds`);
            }
        }
    });

    it('covers the required design fields', () => {
        const required = [
            'target.device',
            'target.vendor',
            'target.packId',
            'target.cpu',
            'target.sfdFile',
            'target.flashDriverDll',
            'target.xtal',
            'target.memoryModel',
            'output.outputName',
            'output.outputDirectory',
            'output.listingPath',
            'output.createExecutable',
            'output.createLib',
            'output.createHexFile',
            'output.hexFormatSelection',
            'output.debugInformation',
            'output.browseInformation',
            'output.createBatchFile',
            'output.merge32K',
            'output.beforeMakeRunUserProg1',
            'output.beforeMakeUserProg1Name',
            'output.afterMakeRunUserProg1',
            'output.afterMakeUserProg1Name',
            'ccpp.define',
            'ccpp.undefine',
            'ccpp.includePath',
            'ccpp.miscControls',
            'ccpp.optim',
            'ccpp.optimArm6',
            'ccpp.optimizeC51',
            'ccpp.optimC251',
            'ccpp.wLevel',
            'ccpp.wLevelArm6',
            'ccpp.warningLevelC51',
            'ccpp.wLevelC251',
            'ccpp.c99Arm6',
            'ccpp.gnuArm6',
            'asm.define',
            'asm.undefine',
            'asm.includePath',
            'asm.miscControls',
            'asm.thumbArm',
            'asm.useStandard',
            'linker.scatterFile',
            'linker.ldMisc',
            'linker.textAddressRange',
            'linker.dataAddressRange',
            'linker.includeLibs',
            'linker.ropi',
            'linker.rwpi',
            'linker.noStLib',
            'linker.lxMiscControls',
            'linker.linkerCmdFile',
            'linker.lxWarningLevel',
            'linker.dataOverlaying',
            'linker.useFile',
            'linker.linkonly',
            'linker.stack',
            'linker.codeBaseAddress',
            'debug.simDllName',
            'debug.simDlgDll',
            'debug.targetDllName',
            'debug.targetDlgDll',
            'debug.hexSelection',
            'debug.uvoptRunSim',
            'debug.uvoptRunTarget',
            'debug.uvoptSimLoadApp',
            'debug.uvoptSimGomain',
            'debug.uvoptTargetLoadApp',
            'debug.uvoptTargetGomain',
            'debug.uvoptSimRbreak',
            'debug.uvoptTargetRbreak',
            'debug.uvoptSimDll',
            'debug.uvoptTargetDll',
            'debug.uvoptTargetDlgDll',
            'debug.uvoptMonitor',
            'debug.uvoptOptRunSim',
            'debug.uvoptOptRunTarget',
            'debug.uvoptOptBeepAtEnd',
            'utilities.useTargetDll',
            'utilities.useExternalTool',
            'utilities.runIndependent',
            'utilities.updateFlashBeforeDebugging',
            'utilities.capability',
            'utilities.driverSelection',
            'utilities.flash2',
            'utilities.bUseTDR',
            'utilities.fcArmLst'
        ];
        for (const id of required) {
            assert.ok(getOptionField(id), `missing required field ${id}`);
        }
    });

    it('marks Xtal, listing and debug run options as .uvopt fields', () => {
        for (const id of [
            'target.xtal',
            'output.uvoptListingPath',
            'debug.uvoptRunSim',
            'debug.uvoptOptRunTarget'
        ]) {
            const optionField = getOptionField(id) as OptionFieldDef;
            assert.equal(optionField.file, 'uvopt', id);
        }
        assert.equal((getOptionField('output.outputName') as OptionFieldDef).file, 'uvprojx');
    });
});

describe('uvOptions', () => {
    it('detects the toolchain of every corpus fixture', () => {
        for (const item of TOOLCHAIN_FIXTURES) {
            assert.equal(detectTargetToolchain(readFixture(item.file), item.target), item.toolchain, item.file);
        }
    });

    it('exposes human readable toolchain labels', () => {
        assert.equal(toolchainLabel('ARM'), 'ARM (AC5)');
        assert.equal(toolchainLabel('ARM6'), 'ARM (AC6)');
        assert.equal(toolchainLabel('C51'), 'C51');
        assert.equal(toolchainLabel('C251'), 'C251');
    });

    it('reads ARM6 (AC6) options', () => {
        const result = readTargetOptions(readFixture('arm-ac6.uvprojx'), 'Demo_Debug');
        assert.equal(result.toolchain, 'ARM6');
        assert.equal(result.values['target.device'], 'STM32F407VGTx');
        assert.equal(result.values['target.vendor'], 'STMicroelectronics');
        assert.equal(result.values['target.packId'], 'Keil.STM32F4xx_DFP.2.17.1');
        assert.equal(result.values['output.outputName'], 'Demo');
        assert.equal(result.values['output.outputDirectory'], '.\\Objects\\');
        assert.equal(result.values['output.createHexFile'], '1');
        assert.equal(result.values['output.hexFormatSelection'], '1');
        assert.equal(result.values['ccpp.optimArm6'], '1');
        assert.equal(result.values['ccpp.wLevelArm6'], '1');
        assert.equal(result.values['ccpp.define'], 'DEBUG,USE_HAL_DRIVER,STM32F407xx');
        assert.equal(result.values['ccpp.undefine'], 'NDEBUG');
        assert.equal(result.values['ccpp.includePath'], '.\\Application;.\\Drivers;.\\Drivers\\CMSIS');
        assert.equal(result.values['asm.thumbArm'], '0');
        assert.equal(result.values['linker.scatterFile'], '.\\Objects\\Demo.sct');
        assert.equal(result.values['debug.simDllName'], 'SARMCM3.DLL');
        assert.equal(result.values['debug.targetDlgDll'], 'TARMCM1.DLL');
        assert.equal(result.values['utilities.useTargetDll'], '1');
        assert.equal(result.values['utilities.driverSelection'], '4096');
        assert.equal(result.values['utilities.flash2'], 'BIN\\CMSIS_AGDI.dll');
        // Toolchain specific / companion file fields are not part of the uvprojx read result.
        assert.equal(result.values['ccpp.optimizeC51'], undefined);
        assert.equal(result.values['target.memoryModel'], undefined);
        assert.equal(result.values['target.xtal'], undefined);
        assert.equal(result.values['debug.uvoptRunSim'], undefined);
    });

    it('reads ARM (AC5) options including the full DebugOption subtree', () => {
        const result = readTargetOptions(readFixture('arm-ac5.uvproj'), 'ARM_Debug');
        assert.equal(result.toolchain, 'ARM');
        assert.equal(result.values['target.device'], 'STM32F103VE');
        assert.equal(result.values['target.flashDriverDll'], 'UL2CM3(-S0 -C0 -P0 -FD20000000 -FC1000)');
        assert.equal(result.values['ccpp.optim'], '2');
        assert.equal(result.values['ccpp.wLevel'], '2');
        assert.equal(result.values['ccpp.c99'], '0');
        assert.equal(result.values['ccpp.define'], 'USE_STDPERIPH_DRIVER,STM32F10X_HD');
        assert.equal(result.values['ccpp.miscControls'], '--c99');
        assert.equal(result.values['debug.useSimulator'], '0');
        assert.equal(result.values['debug.useTarget'], '1');
        assert.equal(result.values['debug.simRunToMain'], '1');
        assert.equal(result.values['debug.targetDllDriver'], 'BIN\\UL2CM3.DLL');
        assert.equal(result.values['debug.targetSelection'], '1');
        assert.equal(result.values['debug.hexSelection'], '1');
        assert.equal(result.values['utilities.driverSelection'], '4096');
        assert.equal(result.values['linker.scatterFile'], '.\\Objects\\ARM_Debug.sct');
        assert.equal(result.values['output.createHexFile'], '0');
    });

    it('reads C51 options with the C51 specific Optimize/WarningLevel elements', () => {
        const result = readTargetOptions(readFixture('c51.uvproj'), 'C51_Debug');
        assert.equal(result.toolchain, 'C51');
        assert.equal(result.values['target.device'], 'AT89C51');
        assert.equal(result.values['target.memoryModel'], '0');
        assert.equal(result.values['ccpp.optimizeC51'], '8');
        assert.equal(result.values['ccpp.warningLevelC51'], '2');
        assert.equal(result.values['ccpp.sizeSpeedC51'], '1');
        assert.equal(result.values['ccpp.define'], 'DEBUG');
        assert.equal(result.values['ccpp.includePath'], '.\\Source;.\\INC');
        assert.equal(result.values['asm.useStandard'], '1');
        assert.equal(result.values['asm.includePath'], '.\\Startup');
        assert.equal(result.values['linker.lxWarningLevel'], '2');
        assert.equal(result.values['linker.dataOverlaying'], '1');
        assert.equal(result.values['linker.useFile'], '0');
        assert.equal(result.values['utilities.useTargetDll'], '0');
        assert.equal(result.values['target.packId'], undefined);
        assert.equal(result.values['ccpp.optim'], undefined);
    });

    it('reads C251 options with the C251 specific Optim/wLevel elements', () => {
        const result = readTargetOptions(readFixture('c251.uvproj'), 'C251_Debug');
        assert.equal(result.toolchain, 'C251');
        assert.equal(result.values['target.device'], '8xC251SB');
        assert.equal(result.values['target.memoryModel'], '0');
        assert.equal(result.values['ccpp.optimC251'], '6');
        assert.equal(result.values['ccpp.wLevelC251'], '2');
        assert.equal(result.values['linker.lxWarningLevel'], '2');
        assert.equal(result.values['asm.useStandard'], '1');
        assert.equal(result.values['ccpp.optimizeC51'], undefined);
    });

    it('throws for unknown targets and unknown toolchains', () => {
        const text = readFixture('arm-ac6.uvprojx');
        assert.throws(() => readTargetOptions(text, 'NoSuchTarget'), /NoSuchTarget/);
        assert.throws(() => applyTargetOptions(text, 'NoSuchTarget', {}), /NoSuchTarget/);

        const unknownToolchain = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<Project>
  <Targets>
    <Target>
      <TargetName>Legacy</TargetName>
      <TargetOption>
        <TargetArm>
          <Carm></Carm>
        </TargetArm>
      </TargetOption>
    </Target>
  </Targets>
</Project>`;
        assert.throws(() => readTargetOptions(unknownToolchain, 'Legacy'), /工具链/);
        assert.throws(() => applyTargetOptions(unknownToolchain, 'Legacy', {}), /工具链/);
    });

    it('writes values back and reads the same values again', () => {
        const original = readFixture('arm-ac6.uvprojx');
        const result = applyTargetOptions(original, 'Demo_Debug', {
            'target.device': 'STM32F429ZITx',
            'output.outputName': 'DemoApp',
            'ccpp.define': 'A,B',
            'output.createHexFile': '0',
            'ccpp.optimArm6': '6',
            'ccpp.oTimeArm6': '1',
            'utilities.driverSelection': '4101'
        });
        assert.equal(result.warnings.length, 0);
        assert.deepEqual(
            [...result.changed].sort(),
            [
                'ccpp.define',
                'ccpp.oTimeArm6',
                'ccpp.optimArm6',
                'output.createHexFile',
                'output.outputName',
                'target.device',
                'utilities.driverSelection'
            ]
        );
        // The result must stay well formed XML for the offset based editor round-trip.
        parseXml(result.xml);
        const reread = readTargetOptions(result.xml, 'Demo_Debug');
        assert.equal(reread.values['target.device'], 'STM32F429ZITx');
        assert.equal(reread.values['output.outputName'], 'DemoApp');
        assert.equal(reread.values['ccpp.define'], 'A,B');
        assert.equal(reread.values['output.createHexFile'], '0');
        assert.equal(reread.values['ccpp.optimArm6'], '6');
        assert.equal(reread.values['ccpp.oTimeArm6'], '1');
        assert.equal(reread.values['utilities.driverSelection'], '4101');
        // The other target of the same project must not be touched.
        const other = readTargetOptions(result.xml, 'Demo_Release');
        assert.equal(other.values['ccpp.define'], 'USE_HAL_DRIVER,STM32F407xx');
        assert.equal(other.values['ccpp.optimArm6'], '3');
    });

    it('does not create any edit when every value is unchanged', () => {
        for (const item of TOOLCHAIN_FIXTURES) {
            const text = readFixture(item.file);
            const read = readTargetOptions(text, item.target);
            const result = applyTargetOptions(text, item.target, collectDefinedValues(read.values));
            assert.equal(result.xml, text, `${item.file} must be byte identical`);
            assert.deepEqual(result.changed, []);
            assert.deepEqual(result.warnings, []);
        }
    });

    it('creates missing elements and keeps the XML parseable', () => {
        const result = applyTargetOptions(MINIMAL_ARM6_PROJECT, 'T1', {
            'target.packId': 'Vendor.Device.1.0.0',
            'output.outputName': 'NewName',
            'output.createHexFile': 'true',
            'ccpp.define': 'X'
        });
        assert.deepEqual(result.warnings, []);
        assert.equal(result.changed.length, 4);
        parseXml(result.xml);
        // Sibling creations must share one container, never duplicate it.
        assert.equal(result.xml.match(/<TargetCommonOption>/g)?.length, 1);
        const read = readTargetOptions(result.xml, 'T1');
        assert.equal(read.values['target.packId'], 'Vendor.Device.1.0.0');
        assert.equal(read.values['output.outputName'], 'NewName');
        assert.equal(read.values['output.createHexFile'], '1');
        assert.equal(read.values['ccpp.define'], 'X');
    });

    it('does not create missing elements for empty or default values', () => {
        const result = applyTargetOptions(MINIMAL_ARM6_PROJECT, 'T1', {
            'output.outputName': '',
            'output.createHexFile': '0',
            'ccpp.define': ''
        });
        assert.equal(result.xml, MINIMAL_ARM6_PROJECT);
        assert.deepEqual(result.changed, []);
        assert.deepEqual(result.warnings, []);
    });

    it('creates the whole path when the target option subtree is missing', () => {
        const minimal = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<Project>
  <Targets>
    <Target>
      <TargetName>Bare</TargetName>
      <TargetOption>
        <TargetArmAds>
          <Cads></Cads>
        </TargetArmAds>
      </TargetOption>
    </Target>
  </Targets>
</Project>
`;
        const result = applyTargetOptions(minimal, 'Bare', {
            'output.outputName': 'Bare',
            'ccpp.includePath': '.\\Inc'
        });
        parseXml(result.xml);
        const read = readTargetOptions(result.xml, 'Bare');
        assert.equal(read.values['output.outputName'], 'Bare');
        assert.equal(read.values['ccpp.includePath'], '.\\Inc');
    });

    it('ignores companion file and unknown fields when writing the project file', () => {
        const text = readFixture('arm-ac6.uvprojx');
        const result = applyTargetOptions(text, 'Demo_Debug', {
            'target.xtal': '16000000',
            'debug.uvoptRunTarget': '0',
            'not.a.field': 'x'
        });
        assert.equal(result.xml, text);
        assert.deepEqual(result.changed, []);
        assert.ok(result.warnings.some((warning) => warning.includes('not.a.field')));
    });

    it('reports fields that are unavailable for the active toolchain', () => {
        const text = readFixture('c51.uvproj');
        const result = applyTargetOptions(text, 'C51_Debug', { 'ccpp.optim': '1' });
        assert.equal(result.xml, text);
        assert.deepEqual(result.changed, []);
        assert.ok(result.warnings[0].includes('不可用'));
    });

    it('skips read only fields', () => {
        const text = readFixture('arm-ac6.uvprojx');
        const result = applyTargetOptions(text, 'Demo_Debug', { 'target.deviceId': '42' });
        assert.equal(result.xml, text);
        assert.deepEqual(result.changed, []);
    });

    it('normalizes bool, number and enum values before writing', () => {
        const text = readFixture('arm-ac6.uvprojx');
        const result = applyTargetOptions(text, 'Demo_Debug', {
            'output.createHexFile': 'true',
            'output.createExecutable': 'false',
            'ccpp.optimArm6': ' 5 '
        });
        const read = readTargetOptions(result.xml, 'Demo_Debug');
        assert.equal(read.values['output.createHexFile'], '1');
        assert.equal(read.values['output.createExecutable'], '0');
        assert.equal(read.values['ccpp.optimArm6'], '5');
    });

    it('normalizes option values with warnings for invalid input', () => {
        const warnings: string[] = [];
        const boolField = getOptionField('output.createHexFile') as OptionFieldDef;
        assert.equal(normalizeOptionValue(boolField, '1', warnings), '1');
        assert.equal(normalizeOptionValue(boolField, 'true', warnings), '1');
        assert.equal(normalizeOptionValue(boolField, '0', warnings), '0');
        assert.equal(normalizeOptionValue(boolField, 'false', warnings), '0');
        assert.equal(normalizeOptionValue(boolField, '', warnings), '0');
        assert.equal(normalizeOptionValue(boolField, 'maybe', warnings), undefined);
        assert.equal(warnings.length, 1);

        const numberField = getOptionField('target.xtal') as OptionFieldDef;
        assert.equal(normalizeOptionValue(numberField, ' 8000000 ', warnings), '8000000');
        assert.equal(normalizeOptionValue(numberField, 'abc', warnings), undefined);
        assert.equal(warnings.length, 2);

        const multilineField = getOptionField('ccpp.define') as OptionFieldDef;
        assert.equal(normalizeOptionValue(multilineField, 'A, B', warnings), 'A, B');
    });
});
