import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseXml } from '../project/uvXml';
import {
    applyUvoptOptions,
    findUvoptFileForProject,
    isUvoptFileName,
    readUvoptOptions
} from '../project/options/uvoptFile';

function fixturePath(name: string): string {
    return path.resolve(__dirname, '../../../src/test/fixtures', name);
}

function readFixture(name: string): string {
    return fs.readFileSync(fixturePath(name), 'utf8');
}

function definedValues(values: Record<string, string | undefined>): Record<string, string> {
    const defined: Record<string, string> = {};
    for (const id of Object.keys(values)) {
        const value = values[id];
        if (value !== undefined) {
            defined[id] = value;
        }
    }
    return defined;
}

const MINIMAL_UVOPT = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<ProjectOpt>
  <Target>
    <TargetName>Debug</TargetName>
    <TargetOption>
      <OPTTT>
        <RunTarget>1</RunTarget>
      </OPTTT>
      <DebugOpt>
        <uTrg>1</uTrg>
      </DebugOpt>
    </TargetOption>
  </Target>
</ProjectOpt>
`;

describe('uvoptFile', () => {
    it('recognizes .uvopt and .uvoptx file names', () => {
        assert.equal(isUvoptFileName('Demo.uvopt'), true);
        assert.equal(isUvoptFileName('Demo.uvoptx'), true);
        assert.equal(isUvoptFileName('C:\\work\\Demo.UVOPTX'), true);
        assert.equal(isUvoptFileName('Demo.uvprojx'), false);
        assert.equal(isUvoptFileName('Demo.uvproj'), false);
        assert.equal(isUvoptFileName('uvopt'), false);
        assert.equal(isUvoptFileName('Demo.uvopt.bak'), false);
    });

    it('finds the companion options file of the fixtures', () => {
        assert.equal(
            findUvoptFileForProject(fixturePath('arm-ac6.uvprojx')),
            fixturePath('arm-ac6.uvoptx')
        );
        assert.equal(
            findUvoptFileForProject(fixturePath('arm-ac5.uvproj')),
            fixturePath('arm-ac5.uvopt')
        );
        assert.equal(findUvoptFileForProject(fixturePath('no-such-project.uvprojx')), undefined);
    });

    it('prefers .uvoptx over .uvopt and falls back to .uvopt', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keil-uvopt-'));
        const projectFile = path.join(tempDir, 'Demo.uvprojx');
        try {
            fs.writeFileSync(projectFile, '<Project></Project>', 'utf8');
            fs.writeFileSync(path.join(tempDir, 'Demo.uvopt'), '<ProjectOpt></ProjectOpt>', 'utf8');
            fs.writeFileSync(path.join(tempDir, 'Demo.uvoptx'), '<ProjectOpt></ProjectOpt>', 'utf8');
            assert.equal(findUvoptFileForProject(projectFile), path.join(tempDir, 'Demo.uvoptx'));

            fs.unlinkSync(path.join(tempDir, 'Demo.uvoptx'));
            assert.equal(findUvoptFileForProject(projectFile), path.join(tempDir, 'Demo.uvopt'));

            fs.unlinkSync(path.join(tempDir, 'Demo.uvopt'));
            assert.equal(findUvoptFileForProject(projectFile), undefined);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('reads Xtal, listing, debug and run options from a .uvoptx file', () => {
        const text = readFixture('arm-ac6.uvoptx');
        const values = readUvoptOptions(text, 'Demo_Debug');
        assert.equal(values['target.xtal'], '8000000');
        assert.equal(values['output.uvoptListingPath'], '.\\Listings\\');
        assert.equal(values['output.uvoptPageWidth'], '79');
        assert.equal(values['output.uvoptPageLength'], '66');
        assert.equal(values['output.uvoptTabStop'], '8');
        assert.equal(values['debug.uvoptRunSim'], '0');
        assert.equal(values['debug.uvoptRunTarget'], '1');
        assert.equal(values['debug.uvoptSimLoadApp'], '1');
        assert.equal(values['debug.uvoptSimGomain'], '0');
        assert.equal(values['debug.uvoptTargetLoadApp'], '1');
        assert.equal(values['debug.uvoptTargetGomain'], '1');
        assert.equal(values['debug.uvoptSimRbreak'], '1');
        assert.equal(values['debug.uvoptTargetRbreak'], '1');
        assert.equal(values['debug.uvoptMonitor'], 'BIN\\CMSIS_AGDI.dll');
        assert.equal(values['debug.uvoptOptRunSim'], '0');
        assert.equal(values['debug.uvoptOptRunTarget'], '1');
        assert.equal(values['debug.uvoptOptBeepAtEnd'], '1');
        // Values are read per target.
        const release = readUvoptOptions(text, 'Demo_Release');
        assert.equal(release['target.xtal'], '8000000');
        assert.equal(release['debug.uvoptMonitor'], 'BIN\\CMSIS_AGDI.dll');
    });

    it('reads the legacy .uvopt dialect as well', () => {
        const text = readFixture('arm-ac5.uvopt');
        const values = readUvoptOptions(text, 'ARM_Debug');
        assert.equal(values['target.xtal'], '12000000');
        assert.equal(values['debug.uvoptRunTarget'], '1');
        assert.equal(values['debug.uvoptMonitor'], 'BIN\\UL2CM3.DLL');
        assert.equal(values['output.uvoptPageWidth'], '79');
    });

    it('returns undefined values for a missing target without throwing', () => {
        const text = readFixture('arm-ac6.uvoptx');
        const values = readUvoptOptions(text, 'NoSuchTarget');
        assert.equal(values['target.xtal'], undefined);
        assert.equal(values['debug.uvoptRunTarget'], undefined);
        assert.equal(values['output.uvoptListingPath'], undefined);
    });

    it('returns undefined values for unparsable XML and wrong root elements', () => {
        assert.equal(readUvoptOptions('<ProjectOpt><Target>', 'Debug')['target.xtal'], undefined);
        assert.equal(
            readUvoptOptions(readFixture('arm-ac6.uvprojx'), 'Demo_Debug')['target.xtal'],
            undefined
        );
    });

    it('writes values back and reads the same values again', () => {
        const original = readFixture('arm-ac6.uvoptx');
        const result = applyUvoptOptions(original, 'Demo_Debug', {
            'target.xtal': '16000000',
            'debug.uvoptRunSim': '1',
            'debug.uvoptOptRunTarget': '0',
            'debug.uvoptMonitor': 'BIN\\UL2CM3.DLL',
            'output.uvoptListingPath': '.\\List\\'
        });
        assert.deepEqual(result.warnings, []);
        assert.deepEqual(
            [...result.changed].sort(),
            [
                'debug.uvoptMonitor',
                'debug.uvoptOptRunTarget',
                'debug.uvoptRunSim',
                'output.uvoptListingPath',
                'target.xtal'
            ]
        );
        parseXml(result.xml);
        const reread = readUvoptOptions(result.xml, 'Demo_Debug');
        assert.equal(reread['target.xtal'], '16000000');
        assert.equal(reread['debug.uvoptRunSim'], '1');
        assert.equal(reread['debug.uvoptOptRunTarget'], '0');
        assert.equal(reread['debug.uvoptMonitor'], 'BIN\\UL2CM3.DLL');
        assert.equal(reread['output.uvoptListingPath'], '.\\List\\');
        // The sibling target keeps its values.
        const release = readUvoptOptions(result.xml, 'Demo_Release');
        assert.equal(release['target.xtal'], '8000000');
        assert.equal(release['debug.uvoptRunSim'], '0');
    });

    it('does not create any edit when every value is unchanged', () => {
        for (const item of [
            { file: 'arm-ac6.uvoptx', target: 'Demo_Debug' },
            { file: 'arm-ac5.uvopt', target: 'ARM_Debug' }
        ]) {
            const text = readFixture(item.file);
            const result = applyUvoptOptions(text, item.target, definedValues(readUvoptOptions(text, item.target)));
            assert.equal(result.xml, text, `${item.file} must be byte identical`);
            assert.deepEqual(result.changed, []);
            assert.deepEqual(result.warnings, []);
        }
    });

    it('keeps missing fields and missing targets unchanged with a warning', () => {
        const missingField = applyUvoptOptions(MINIMAL_UVOPT, 'Debug', {
            'target.xtal': '16000000',
            'debug.uvoptOptRunTarget': '0'
        });
        assert.deepEqual(missingField.changed, ['debug.uvoptOptRunTarget']);
        // Only the existing element was rewritten, CLKADS was not invented.
        parseXml(missingField.xml);
        assert.ok(missingField.xml.includes('<RunTarget>0</RunTarget>'));
        assert.equal(missingField.xml.includes('<CLKADS>'), false);
        assert.equal(missingField.warnings.length, 1);
        assert.ok(missingField.warnings[0].includes('target.xtal'));

        const missingTarget = applyUvoptOptions(MINIMAL_UVOPT, 'Release', { 'target.xtal': '1' });
        assert.equal(missingTarget.xml, MINIMAL_UVOPT);
        assert.deepEqual(missingTarget.changed, []);
        assert.equal(missingTarget.warnings.length, 1);
        assert.ok(missingTarget.warnings[0].includes('Release'));
    });

    it('rejects unparsable documents and wrong root elements without throwing', () => {
        const broken = applyUvoptOptions('<ProjectOpt><Target>', 'Debug', { 'target.xtal': '1' });
        assert.equal(broken.xml, '<ProjectOpt><Target>');
        assert.deepEqual(broken.changed, []);
        assert.ok(broken.warnings[0].includes('解析'));

        const wrongRoot = applyUvoptOptions('<Project></Project>', 'Debug', { 'target.xtal': '1' });
        assert.equal(wrongRoot.xml, '<Project></Project>');
        assert.deepEqual(wrongRoot.changed, []);
        assert.ok(wrongRoot.warnings[0].includes('ProjectOpt'));
    });

    it('ignores project file field ids', () => {
        const text = readFixture('arm-ac6.uvoptx');
        const result = applyUvoptOptions(text, 'Demo_Debug', { 'output.outputName': 'Renamed' });
        assert.equal(result.xml, text);
        assert.deepEqual(result.changed, []);
        assert.deepEqual(result.warnings, []);
    });
});
