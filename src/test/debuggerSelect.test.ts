import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { KeilToolsIni, parseToolsIni } from '../project/options/keilInstall';
import {
    SIMULATOR_VALUE,
    applyDebuggerChoice,
    debuggerList,
    debuggerOptions,
    readDebuggerChoice
} from '../project/options/debuggerSelect';
import { childElements, findPath, parseXml, targetNameOf, textOf } from '../project/uvXml';

const FIXTURE_DIR = path.resolve(__dirname, '../../../src/test/fixtures');

function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/** Trimmed text of one `TargetOption/DebugOpt` field of a `.uvopt` target. */
function debugOptField(xml: string, targetName: string, field: string): string | undefined {
    const doc = parseXml(xml);
    const target = childElements(doc.root, 'Target').find((element) => targetNameOf(element) === targetName);
    if (!target) {
        assert.fail(`未找到目标 ${targetName}`);
    }
    const element = findPath(target, ['TargetOption', 'DebugOpt', field]);
    return element ? textOf(element).trim() : undefined;
}

/** Line indexes that differ between two versions of the same document. */
function changedLineIndexes(before: string, after: string): number[] {
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    assert.equal(afterLines.length, beforeLines.length, '写入不应增加或删除行');
    const changed: number[] = [];
    for (let index = 0; index < beforeLines.length; index++) {
        if (beforeLines[index] !== afterLines[index]) {
            changed.push(index);
        }
    }
    return changed;
}

function lineAt(source: string, index: number): string {
    return source.split('\n')[index].trim();
}

function bareUvopt(inner: string): string {
    return [
        '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
        '<ProjectOpt>',
        '  <Target>',
        inner,
        '  </Target>',
        '</ProjectOpt>',
        ''
    ].join('\n');
}

describe('debuggerSelect', () => {
    let tools: KeilToolsIni;
    let uvoptText: string;

    before(() => {
        tools = parseToolsIni(readFixture('tools-default.ini'));
        uvoptText = readFixture('arm-ac6.uvoptx');
    });

    describe('debuggerList', () => {
        it('lists the Cortex-M adapters of the local TOOLS.INI in dropdown order', () => {
            const list = debuggerList(tools, 'cortex-m');

            assert.equal(list.length, 12);
            assert.deepEqual(list.map((entry) => entry.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
            assert.equal(list[0].name, 'ULINK2/ME Cortex Debugger');
            assert.equal(list[0].dll, 'BIN\\UL2CM3.DLL');
            assert.equal(list[4].name, 'J-LINK / J-TRACE Cortex');
            assert.equal(list[4].dll, 'Segger\\JL2CM3.dll');
            assert.equal(list[11].name, 'TI XDS Debugger');
            assert.equal(list[11].dll, 'TI_XDS\\XDS2CM3.dll');
        });

        it('lists the ARMv8-M adapters of the CPUDLL3 group (position, not TDRV id)', () => {
            const list = debuggerList(tools, 'armv8-m');

            assert.equal(list.length, 9);
            assert.deepEqual(list.map((entry) => entry.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
            assert.equal(list[0].name, 'ULINKplus Debugger');
            assert.equal(list[1].name, 'J-LINK / J-TRACE Cortex');
            assert.equal(list[5].name, 'ULINK Pro ARMv8-M Debugger');
            assert.equal(list[5].dll, 'BIN\\ULP2V8M.DLL');
            assert.equal(list[8].name, 'Models ARMv8-M Debugger');
        });

        it('lists the ARM7 adapters of the CPUDLL0 group', () => {
            const list = debuggerList(tools, 'arm7');

            assert.equal(list.length, 3);
            assert.equal(list[0].name, 'ULINK2/ME ARM Debugger');
            assert.equal(list[2].name, 'J-LINK / J-TRACE ARM');
            assert.equal(list[2].dll, 'Segger\\JLTAgdi.dll');
        });

        it('uses the single driver list of a C51 section', () => {
            const c51Tools = parseToolsIni(
                [
                    '[C51]',
                    'CPUDLL0=S8051.DLL(TDRV0,TDRV1)',
                    'TDRV0=BIN\\STCMON.DLL("STC Monitor-51 Driver")',
                    'TDRV1=BIN\\KEILMON.DLL("Keil Monitor-51 Driver")'
                ].join('\n')
            );

            const list = debuggerList(c51Tools, 'c51');
            assert.equal(list.length, 2);
            assert.equal(list[0].name, 'STC Monitor-51 Driver');
            assert.equal(list[1].dll, 'BIN\\KEILMON.DLL');
        });

        it('falls back to the built-in default list without a TOOLS.INI', () => {
            const list = debuggerList(undefined, 'cortex-m');

            assert.equal(list.length, 12);
            assert.equal(list[0].name, 'ULINK2/ME Cortex Debugger');
            assert.equal(list[4].name, 'J-LINK / J-TRACE Cortex');
            assert.equal(list[4].dll, 'Segger\\JL2CM3.dll');
            assert.equal(list[11].name, 'TI XDS Debugger');
            assert.equal(debuggerList(undefined, 'armv8-m').length, 9);
            assert.equal(debuggerList(undefined, 'arm7').length, 3);
            assert.deepEqual(debuggerList(undefined, 'c51'), []);
            // A TOOLS.INI that declares no [ARM] section behaves like no install.
            assert.equal(debuggerList(parseToolsIni(''), 'cortex-m').length, 12);
        });
    });

    describe('debuggerOptions', () => {
        it('builds the panel dropdown: simulator first, then one entry per adapter', () => {
            const options = debuggerOptions(tools, 'cortex-m');

            assert.equal(options.length, 13);
            assert.equal(options[0].value, SIMULATOR_VALUE);
            assert.match(options[0].label, /仿真/);
            assert.equal(options[1].value, '0');
            assert.match(options[1].label, /ULINK2\/ME Cortex Debugger/);
            assert.equal(options[5].value, '4');
            assert.match(options[5].label, /J-LINK \/ J-TRACE Cortex/);
            assert.equal(options[12].value, '11');
            assert.match(options[12].label, /TI XDS Debugger/);

            const list = debuggerList(tools, 'cortex-m');
            assert.deepEqual(options.slice(1).map((option) => option.value), list.map((entry) => String(entry.index)));

            // Without a local installation the default list is offered.
            const defaults = debuggerOptions(undefined, 'cortex-m');
            assert.equal(defaults.length, 13);
            assert.match(defaults[5].label, /J-LINK/);

            // A C51 project on an ARM-only TOOLS.INI only offers the simulator.
            assert.deepEqual(debuggerOptions(tools, 'c51').map((option) => option.value), [SIMULATOR_VALUE]);
        });
    });

    describe('readDebuggerChoice', () => {
        it('reads the target debugger of a real .uvoptx target', () => {
            const choice = readDebuggerChoice(uvoptText, 'Demo_Debug', tools, 'cortex-m');

            assert.equal(choice.mode, 'target');
            assert.equal(choice.value, '0');
            assert.equal(choice.index, 0);
            assert.match(choice.name || '', /ULINK2\/ME Cortex Debugger/);
            assert.equal(choice.dll, 'BIN\\UL2CM3.DLL');
            // The second target of the fixture carries the same values.
            assert.equal(readDebuggerChoice(uvoptText, 'Demo_Release', tools, 'cortex-m').value, '0');
        });

        it('reports the simulator when uSim=1 (even with a stale uTrg=1)', () => {
            const simulatorText = uvoptText.replace('<uSim>0</uSim>', '<uSim>1</uSim>');
            const choice = readDebuggerChoice(simulatorText, 'Demo_Debug', tools, 'cortex-m');

            assert.equal(choice.mode, 'simulator');
            assert.equal(choice.value, 'sim');
            assert.equal(choice.index, undefined);
            assert.equal(choice.name, undefined);
            assert.equal(choice.dll, undefined);
        });

        it('resolves the adapter by its 0-based nTsel position', () => {
            const jlinkText = uvoptText.replace('<nTsel>0</nTsel>', '<nTsel>4</nTsel>');
            const choice = readDebuggerChoice(jlinkText, 'Demo_Debug', tools, 'cortex-m');

            assert.equal(choice.mode, 'target');
            assert.equal(choice.value, '4');
            assert.equal(choice.index, 4);
            assert.match(choice.name || '', /J-LINK \/ J-TRACE Cortex/);
            assert.equal(choice.dll, 'Segger\\JL2CM3.dll');
        });

        it('keeps an out-of-list index but reports no adapter name for it', () => {
            const oddText = uvoptText.replace('<nTsel>0</nTsel>', '<nTsel>99</nTsel>');
            const choice = readDebuggerChoice(oddText, 'Demo_Debug', tools, 'cortex-m');

            assert.equal(choice.mode, 'target');
            assert.equal(choice.value, '99');
            assert.equal(choice.index, 99);
            assert.equal(choice.name, undefined);
            assert.equal(choice.dll, undefined);
        });

        it('returns unknown for missing text, missing target and missing DebugOpt', () => {
            const unknown = { mode: 'unknown', value: 'unknown' };
            assert.deepEqual(readDebuggerChoice(undefined, 'Demo_Debug', tools, 'cortex-m'), unknown);
            assert.deepEqual(readDebuggerChoice('', 'Demo_Debug', tools, 'cortex-m'), unknown);
            assert.deepEqual(readDebuggerChoice('  \n\t ', 'Demo_Debug', tools, 'cortex-m'), unknown);
            assert.deepEqual(readDebuggerChoice('not xml', 'Demo_Debug', tools, 'cortex-m'), unknown);
            assert.deepEqual(readDebuggerChoice(uvoptText, 'NoSuchTarget', tools, 'cortex-m'), unknown);

            const noDebugOpt = bareUvopt(
                [
                    '    <TargetName>Bare</TargetName>',
                    '    <TargetOption>',
                    '      <CLKADS>8000000</CLKADS>',
                    '    </TargetOption>'
                ].join('\n')
            );
            assert.deepEqual(readDebuggerChoice(noDebugOpt, 'Bare', tools, 'cortex-m'), unknown);
        });

        it('returns unknown when neither uSim nor uTrg selects a mode', () => {
            const neither = uvoptText.replace('<uTrg>1</uTrg>', '<uTrg>0</uTrg>');
            assert.deepEqual(readDebuggerChoice(neither, 'Demo_Debug', tools, 'cortex-m'), {
                mode: 'unknown',
                value: 'unknown'
            });
        });
    });

    describe('applyDebuggerChoice', () => {
        it('writes uSim/uTrg/nTsel/pMon for a target adapter', () => {
            const result = applyDebuggerChoice(uvoptText, 'Demo_Debug', '4', tools, 'cortex-m');

            assert.deepEqual(result.changed, ['debug.debugger']);
            assert.deepEqual(result.warnings, []);
            assert.notEqual(result.xml, uvoptText);
            assert.match(result.xml, /<uSim>0<\/uSim>/);
            assert.match(result.xml, /<uTrg>1<\/uTrg>/);
            assert.match(result.xml, /<nTsel>4<\/nTsel>/);
            assert.match(result.xml, /<pMon>Segger\\JL2CM3\.dll<\/pMon>/);
            assert.ok(parseXml(result.xml).root, '结果必须仍是合法 XML');

            const reread = readDebuggerChoice(result.xml, 'Demo_Debug', tools, 'cortex-m');
            assert.equal(reread.mode, 'target');
            assert.equal(reread.value, '4');
            assert.match(reread.name || '', /J-LINK \/ J-TRACE Cortex/);
        });

        it('touches only the four DebugOpt lines of the fixture', () => {
            const targetResult = applyDebuggerChoice(uvoptText, 'Demo_Debug', '4', tools, 'cortex-m');
            const targetDiff = changedLineIndexes(uvoptText, targetResult.xml);
            assert.equal(targetDiff.length, 2);
            assert.deepEqual(
                targetDiff.map((index) => lineAt(uvoptText, index)),
                ['<nTsel>0</nTsel>', '<pMon>BIN\\CMSIS_AGDI.dll</pMon>']
            );

            const simResult = applyDebuggerChoice(targetResult.xml, 'Demo_Debug', 'sim', tools, 'cortex-m');
            const simDiff = changedLineIndexes(targetResult.xml, simResult.xml);
            assert.equal(simDiff.length, 2);
            assert.deepEqual(
                simDiff.map((index) => lineAt(targetResult.xml, index)),
                ['<uSim>0</uSim>', '<uTrg>1</uTrg>']
            );

            // Target selection + simulator selection change exactly four lines.
            assert.equal(changedLineIndexes(uvoptText, simResult.xml).length, 4);
            // The other target of the file stays untouched.
            assert.equal(debugOptField(simResult.xml, 'Demo_Release', 'nTsel'), '0');
            assert.equal(debugOptField(simResult.xml, 'Demo_Release', 'pMon'), 'BIN\\CMSIS_AGDI.dll');
            assert.equal((simResult.xml.match(/<nTsel>4<\/nTsel>/g) || []).length, 1);
        });

        it('selects the simulator and keeps nTsel/pMon of the target adapter', () => {
            const targetResult = applyDebuggerChoice(uvoptText, 'Demo_Debug', '4', tools, 'cortex-m');
            const simResult = applyDebuggerChoice(targetResult.xml, 'Demo_Debug', 'sim', tools, 'cortex-m');

            assert.equal(debugOptField(simResult.xml, 'Demo_Debug', 'uSim'), '1');
            assert.equal(debugOptField(simResult.xml, 'Demo_Debug', 'uTrg'), '0');
            assert.equal(debugOptField(simResult.xml, 'Demo_Debug', 'nTsel'), '4');
            assert.equal(debugOptField(simResult.xml, 'Demo_Debug', 'pMon'), 'Segger\\JL2CM3.dll');

            const choice = readDebuggerChoice(simResult.xml, 'Demo_Debug', tools, 'cortex-m');
            assert.equal(choice.mode, 'simulator');
            assert.equal(choice.value, 'sim');
        });

        it('returns the input byte for byte when the value does not change anything', () => {
            const targetResult = applyDebuggerChoice(uvoptText, 'Demo_Debug', '4', tools, 'cortex-m');
            const targetAgain = applyDebuggerChoice(targetResult.xml, 'Demo_Debug', '4', tools, 'cortex-m');
            assert.equal(targetAgain.xml, targetResult.xml);
            assert.deepEqual(targetAgain.changed, ['debug.debugger']);

            const simResult = applyDebuggerChoice(uvoptText, 'Demo_Debug', 'sim', tools, 'cortex-m');
            const simAgain = applyDebuggerChoice(simResult.xml, 'Demo_Debug', 'sim', tools, 'cortex-m');
            assert.equal(simAgain.xml, simResult.xml);
        });

        it('throws an error containing the target name for a missing target or broken XML', () => {
            assert.throws(
                () => applyDebuggerChoice(uvoptText, 'NoSuchTarget', '4', tools, 'cortex-m'),
                /NoSuchTarget/
            );
            assert.throws(
                () => applyDebuggerChoice('<ProjectOpt><Target>', 'Demo_Debug', '4', tools, 'cortex-m'),
                /Demo_Debug/
            );
            assert.throws(() => applyDebuggerChoice('', 'Demo_Debug', 'sim', tools, 'cortex-m'), /Demo_Debug/);
        });

        it('writes an out-of-list index and warns instead of inventing a driver DLL', () => {
            const result = applyDebuggerChoice(uvoptText, 'Demo_Debug', '13', tools, 'cortex-m');

            assert.equal(debugOptField(result.xml, 'Demo_Debug', 'nTsel'), '13');
            assert.equal(debugOptField(result.xml, 'Demo_Debug', 'pMon'), 'BIN\\CMSIS_AGDI.dll');
            assert.ok(result.warnings.length > 0);
            assert.match(result.warnings[0], /13/);
            assert.ok(parseXml(result.xml).root);
        });

        it('ignores an unparsable value and reports it as a warning', () => {
            const result = applyDebuggerChoice(uvoptText, 'Demo_Debug', 'unknown', tools, 'cortex-m');

            assert.equal(result.xml, uvoptText);
            assert.ok(result.warnings.length > 0);
            assert.match(result.warnings[0], /unknown/);
        });

        it('creates a missing DebugOpt block', () => {
            const bare = bareUvopt(
                [
                    '    <TargetName>Bare</TargetName>',
                    '    <TargetOption>',
                    '      <CLKADS>8000000</CLKADS>',
                    '    </TargetOption>'
                ].join('\n')
            );

            const result = applyDebuggerChoice(bare, 'Bare', '3', tools, 'cortex-m');

            assert.equal(debugOptField(result.xml, 'Bare', 'uSim'), '0');
            assert.equal(debugOptField(result.xml, 'Bare', 'uTrg'), '1');
            assert.equal(debugOptField(result.xml, 'Bare', 'nTsel'), '3');
            assert.equal(debugOptField(result.xml, 'Bare', 'pMon'), 'BIN\\CMSIS_AGDI.dll');
            assert.ok(result.warnings.some((warning) => /缺少 DebugOpt/.test(warning)));
            assert.match(result.xml, /<CLKADS>8000000<\/CLKADS>/);
            assert.ok(parseXml(result.xml).root);

            const choice = readDebuggerChoice(result.xml, 'Bare', tools, 'cortex-m');
            assert.equal(choice.mode, 'target');
            assert.equal(choice.value, '3');
            assert.match(choice.name || '', /CMSIS-DAP/);
        });

        it('creates TargetOption and DebugOpt when both are missing', () => {
            const empty = bareUvopt('    <TargetName>Empty</TargetName>');

            const result = applyDebuggerChoice(empty, 'Empty', 'sim', tools, 'cortex-m');

            assert.equal(debugOptField(result.xml, 'Empty', 'uSim'), '1');
            assert.equal(debugOptField(result.xml, 'Empty', 'uTrg'), '0');
            assert.ok(parseXml(result.xml).root);

            const choice = readDebuggerChoice(result.xml, 'Empty', tools, 'cortex-m');
            assert.equal(choice.mode, 'simulator');
        });
    });
});
