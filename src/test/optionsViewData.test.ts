import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { OPTION_FIELDS } from '../project/options/uvOptionSchema';
import { applyTargetOptions } from '../project/options/uvOptions';
import { applyUvoptOptions } from '../project/options/uvoptFile';
import {
    UVOPT_MISSING_REASON,
    buildOptionsViewData,
    splitValuesByFile
} from '../project/options/viewData';
import { OptionFieldView, OptionTabView } from '../project/options/types';

function fixturePath(name: string): string {
    return path.resolve(__dirname, '../../../src/test/fixtures', name);
}

function readFixture(name: string): string {
    return fs.readFileSync(fixturePath(name), 'utf8');
}

function allFields(tabs: OptionTabView[]): OptionFieldView[] {
    return tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fields));
}

function findField(view: ReturnType<typeof buildOptionsViewData>, id: string): OptionFieldView {
    const field = allFields(view.tabs).find((entry) => entry.id === id);
    assert.ok(field, `field ${id} not rendered`);
    return field as OptionFieldView;
}

describe('OptionsViewData', () => {
    const arm6Project = fixturePath('arm-ac6.uvprojx');
    const arm6Text = readFixture('arm-ac6.uvprojx');
    const arm6Uvopt = readFixture('arm-ac6.uvoptx');

    it('builds the seven tabs with all schema fields', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt
        });
        assert.deepEqual(
            view.tabs.map((tab) => tab.id),
            ['target', 'output', 'ccpp', 'asm', 'linker', 'debug', 'utilities']
        );
        for (const tab of view.tabs) {
            assert.ok(tab.title.length > 0);
            assert.ok(tab.sections.length > 0);
            for (const section of tab.sections) {
                assert.ok(section.fields.length > 0);
            }
        }
        const schemaFieldIds = new Set(OPTION_FIELDS.map((field) => field.id));
        const renderedFields = allFields(view.tabs);
        for (const schemaField of OPTION_FIELDS) {
            assert.ok(
                renderedFields.some((entry) => entry.id === schemaField.id),
                `missing schema field ${schemaField.id}`
            );
        }
        // The panel additionally renders generated fields (MCU info rows, driver
        // meaning row, device/debugger pickers); they must not replace schema fields.
        const generatedFields = renderedFields.filter((entry) => !schemaFieldIds.has(entry.id));
        assert.ok(generatedFields.length > 0, 'expected generated fields');
        for (const generated of generatedFields) {
            assert.ok(
                ['info', 'enum', 'bool', 'string', 'number'].indexOf(generated.type) !== -1,
                `generated field ${generated.id} has unexpected type ${generated.type}`
            );
        }
        assert.equal(view.readonly, false);
        assert.equal(view.readonlyReason, undefined);
        assert.equal(view.projectLabel, 'Demo');
        assert.equal(view.projectFile, arm6Project);
        assert.deepEqual(view.targets, ['Demo_Debug', 'Demo_Release']);
        assert.equal(view.activeTarget, 'Demo_Debug');
        assert.equal(view.toolchain, 'ARM (AC6)');
        assert.equal(view.uvoptFile, fixturePath('arm-ac6.uvoptx'));
    });

    it('maps the four toolchains to human readable labels', () => {
        const cases = [
            { file: 'arm-ac5.uvproj', target: 'ARM_Debug', label: 'ARM (AC5)' },
            { file: 'c51.uvproj', target: 'C51_Debug', label: 'C51' },
            { file: 'c251.uvproj', target: 'C251_Debug', label: 'C251' }
        ];
        for (const item of cases) {
            const view = buildOptionsViewData({
                projectLabel: item.file,
                projectFile: fixturePath(item.file),
                uvprojxText: readFixture(item.file),
                activeTarget: item.target
            });
            assert.equal(view.toolchain, item.label, item.file);
            assert.equal(view.activeTarget, item.target, item.file);
        }
    });

    it('honours the requested target and falls back to the first one', () => {
        const requested = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            activeTarget: 'Demo_Release'
        });
        assert.equal(requested.activeTarget, 'Demo_Release');
        assert.equal(findField(requested, 'ccpp.optimArm6').value, '3');

        const unknown = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt,
            activeTarget: 'NoSuchTarget'
        });
        assert.equal(unknown.activeTarget, 'Demo_Debug');
    });

    it('renders parsed project values and companion file values', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt
        });
        assert.equal(findField(view, 'target.device').value, 'STM32F407VGTx');
        assert.equal(findField(view, 'target.packId').value, 'Keil.STM32F4xx_DFP.2.17.1');
        assert.equal(findField(view, 'output.outputName').value, 'Demo');
        assert.equal(findField(view, 'output.createHexFile').value, '1');
        assert.equal(findField(view, 'ccpp.define').value, 'DEBUG,USE_HAL_DRIVER,STM32F407xx');
        assert.equal(findField(view, 'ccpp.optimArm6').value, '1');
        assert.equal(findField(view, 'linker.scatterFile').value, '.\\Objects\\Demo.sct');
        assert.equal(findField(view, 'target.xtal').value, '8000000');
        assert.equal(findField(view, 'target.xtal').unavailable, undefined);
        assert.equal(findField(view, 'debug.uvoptRunTarget').value, '1');
        assert.equal(findField(view, 'debug.uvoptMonitor').value, 'BIN\\CMSIS_AGDI.dll');
        assert.equal(findField(view, 'output.uvoptListingPath').value, '.\\Listings\\');
        // Enum fields expose their real option values.
        const hexFormat = findField(view, 'output.hexFormatSelection');
        assert.ok(hexFormat.options && hexFormat.options.length === 2);
        assert.deepEqual(
            (hexFormat.options || []).map((entry) => entry.value),
            ['1', '0']
        );
        assert.equal(findField(view, 'target.deviceId').readonly, true);
    });

    it('marks fields unsupported by the active toolchain as unavailable', () => {
        const arm6 = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt
        });
        const c51Optim = findField(arm6, 'ccpp.optimizeC51');
        assert.equal(c51Optim.unavailable, true);
        assert.ok((c51Optim.unavailableReason || '').includes('不支持'));
        assert.equal(findField(arm6, 'linker.lxMiscControls').unavailable, true);
        assert.equal(findField(arm6, 'ccpp.optimArm6').unavailable, undefined);

        const c51 = buildOptionsViewData({
            projectLabel: 'c51',
            projectFile: fixturePath('c51.uvproj'),
            uvprojxText: readFixture('c51.uvproj')
        });
        assert.equal(findField(c51, 'ccpp.optimArm6').unavailable, true);
        assert.equal(findField(c51, 'ccpp.optimizeC51').unavailable, undefined);
        assert.equal(findField(c51, 'ccpp.optimizeC51').value, '8');
        assert.equal(findField(c51, 'target.memoryModel').value, '0');
        assert.ok(c51.warnings.some((warning) => warning.includes('不可用')));
    });

    it('marks every .uvopt field unavailable when the file is missing', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text
        });
        assert.equal(view.uvoptFile, undefined);
        const xtal = findField(view, 'target.xtal');
        assert.equal(xtal.unavailable, true);
        assert.equal(xtal.unavailableReason, UVOPT_MISSING_REASON);
        assert.equal(findField(view, 'debug.uvoptRunTarget').unavailable, true);
        assert.equal(findField(view, 'output.uvoptListingPath').unavailable, true);
        assert.ok(view.warnings.includes(UVOPT_MISSING_REASON));
        // The project file fields stay available.
        assert.equal(findField(view, 'output.outputName').unavailable, undefined);
        assert.equal(findField(view, 'output.outputName').value, 'Demo');
    });

    it('marks .uvopt fields unavailable when the companion file is unparsable', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text,
            uvoptText: '<ProjectOpt><Target>'
        });
        const xtal = findField(view, 'target.xtal');
        assert.equal(xtal.unavailable, true);
        assert.ok((xtal.unavailableReason || '').includes('无法解析'));
        assert.ok(view.warnings.some((warning) => warning.includes('无法解析')));
        assert.equal(view.readonly, false);
    });

    it('switches to a read only panel when the project file is broken', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Broken',
            projectFile: arm6Project,
            uvprojxText: '<Project><Targets>'
        });
        assert.equal(view.readonly, true);
        assert.ok((view.readonlyReason || '').includes('解析失败'));
        assert.ok(view.warnings.length > 0);
        assert.deepEqual(view.targets, []);
        assert.deepEqual(view.tabs, []);
        assert.equal(view.toolchain, '未知');
    });

    it('handles projects without targets', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Empty',
            projectFile: arm6Project,
            uvprojxText: '<?xml version="1.0" encoding="UTF-8"?><Project><Targets></Targets></Project>'
        });
        assert.deepEqual(view.targets, []);
        assert.equal(view.activeTarget, '');
        assert.equal(view.toolchain, '未知');
        assert.ok(view.warnings.some((warning) => warning.includes('未找到任何目标')));
        assert.equal(findField(view, 'output.outputName').unavailable, true);
    });

    it('panel style round-trip over the fixtures produces no edits', () => {
        const cases = [
            {
                project: 'arm-ac6.uvprojx',
                uvopt: 'arm-ac6.uvoptx',
                target: 'Demo_Debug'
            },
            {
                project: 'arm-ac5.uvproj',
                uvopt: 'arm-ac5.uvopt',
                target: 'ARM_Debug'
            },
            { project: 'c51.uvproj', uvopt: undefined, target: 'C51_Debug' },
            { project: 'c251.uvproj', uvopt: undefined, target: 'C251_Debug' }
        ];
        for (const item of cases) {
            const projectText = readFixture(item.project);
            const uvoptText = item.uvopt === undefined ? undefined : readFixture(item.uvopt);
            const view = buildOptionsViewData({
                projectLabel: item.project,
                projectFile: fixturePath(item.project),
                uvprojxText: projectText,
                ...(uvoptText !== undefined ? { uvoptText } : {}),
                activeTarget: item.target
            });
            const fields = allFields(view.tabs).filter((field) => !field.unavailable);
            const split = splitValuesByFile(fields);
            const projectValues: Record<string, string> = {};
            for (const id of split.uvprojx) {
                projectValues[id] = findField(view, id).value;
            }
            const projectResult = applyTargetOptions(projectText, item.target, projectValues);
            assert.equal(projectResult.changed.length, 0, item.project);
            assert.equal(projectResult.xml, projectText, `${item.project} must not change`);

            if (uvoptText !== undefined) {
                const uvoptValues: Record<string, string> = {};
                for (const id of split.uvopt) {
                    uvoptValues[id] = findField(view, id).value;
                }
                const uvoptResult = applyUvoptOptions(uvoptText, item.target, uvoptValues);
                assert.equal(uvoptResult.changed.length, 0, String(item.uvopt));
                assert.equal(uvoptResult.xml, uvoptText, `${item.uvopt} must not change`);
            }
        }
    });

    it('splits rendered field ids by the file that owns them', () => {
        const view = buildOptionsViewData({
            projectLabel: 'Demo',
            projectFile: arm6Project,
            uvprojxText: arm6Text,
            uvoptText: arm6Uvopt
        });
        const fields = allFields(view.tabs);
        const split = splitValuesByFile(fields);
        assert.equal(split.uvprojx.length + split.uvopt.length, fields.length);
        assert.ok(split.uvopt.includes('target.xtal'));
        assert.ok(split.uvopt.includes('debug.uvoptMonitor'));
        assert.ok(split.uvopt.includes('output.uvoptPageWidth'));
        assert.ok(split.uvprojx.includes('output.outputName'));
        assert.ok(split.uvprojx.includes('ccpp.define'));
        assert.equal(split.uvprojx.includes('target.xtal'), false);
        assert.equal(split.uvopt.includes('output.outputName'), false);

        // Unknown ids (defensive) are treated as project file values.
        const defensive = splitValuesByFile([{ id: 'unknown.field', label: 'x', type: 'string', value: '' }]);
        assert.deepEqual(defensive, { uvprojx: ['unknown.field'], uvopt: [] });
    });
});
