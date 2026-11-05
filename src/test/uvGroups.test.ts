import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    UvGroupEntry,
    addFiles,
    addGroup,
    detectToolchainOfTarget,
    fileTypeForPath,
    fromUvProjectPath,
    listTargets,
    moveFile,
    readTargetGroups,
    removeFile,
    removeGroup,
    renameGroup,
    setFileInBuild,
    setGroupInBuild,
    toUvProjectPath
} from '../project/uvGroups';

// `__dirname` is `dist/src/test` after compilation.
const FIXTURES_DIR = path.resolve(__dirname, '../../../src/test/fixtures');

function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

function targetSlice(xml: string, targetName: string): string {
    const marker = `<TargetName>${targetName}</TargetName>`;
    const index = xml.indexOf(marker);
    assert.notEqual(index, -1, `target ${targetName} should exist in the fixture`);
    return xml.slice(index);
}

/** Text of one target only: from its `<TargetName>` up to the next target (if any). */
function targetBlock(xml: string, targetName: string): string {
    const marker = `<TargetName>${targetName}</TargetName>`;
    const start = xml.indexOf(marker);
    assert.notEqual(start, -1, `target ${targetName} should exist in the fixture`);
    const next = xml.indexOf('<TargetName>', start + marker.length);
    return next === -1 ? xml.slice(start) : xml.slice(start, next);
}

function groupsOf(xml: string, targetName: string): UvGroupEntry[] {
    const groups = readTargetGroups(xml, targetName);
    assert.ok(groups, `target ${targetName} should exist`);
    return groups;
}

function names(groups: UvGroupEntry[]): string[] {
    return groups.map((group) => group.name);
}

// ---------------------------------------------------------------------------
// Minimal hand-written projects for edge cases that the fixtures do not cover.
// ---------------------------------------------------------------------------

function miniProject(groupsXml: string): string {
    return [
        '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
        '<Project>',
        '  <Targets>',
        '    <Target>',
        '      <TargetName>Debug</TargetName>',
        '      <ToolsetName>ARM-ADS</ToolsetName>',
        '      <uAC6>1</uAC6>',
        '      <TargetOption>',
        '        <TargetArmAds></TargetArmAds>',
        '      </TargetOption>',
        groupsXml,
        '    </Target>',
        '  </Targets>',
        '</Project>',
        ''
    ].join('\n');
}

const PROJECT_WITHOUT_GROUPS = miniProject('');

const PROJECT_WITH_EMPTY_GROUPS = miniProject('      <Groups/>');

const PROJECT_WITH_GROUP_WITHOUT_FILES = miniProject(
    [
        '      <Groups>',
        '        <Group>',
        '          <GroupName>Empty</GroupName>',
        '        </Group>',
        '      </Groups>'
    ].join('\n')
);

const PROJECT_WITH_SELF_CLOSING_FILES = miniProject(
    [
        '      <Groups>',
        '        <Group>',
        '          <GroupName>Empty</GroupName>',
        '          <Files/>',
        '        </Group>',
        '      </Groups>'
    ].join('\n')
);

/** Two groups; the file in `App` carries a FileOption that must survive a move. */
const PROJECT_WITH_FILE_OPTION = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no" ?>',
    '<Project>',
    '  <Targets>',
    '    <Target>',
    '      <TargetName>Debug</TargetName>',
    '      <ToolsetName>ARM-ADS</ToolsetName>',
    '      <uAC6>0</uAC6>',
    '      <TargetOption>',
    '        <TargetArmAds></TargetArmAds>',
    '      </TargetOption>',
    '      <Groups>',
    '        <Group>',
    '          <GroupName>App</GroupName>',
    '          <Files>',
    '            <File>',
    '              <FileName>main.c</FileName>',
    '              <FileType>1</FileType>',
    '              <FilePath>.\\App\\main.c</FilePath>',
    '              <FileOption>',
    '                <CommonProperty>',
    '                  <IncludeInBuild>0</IncludeInBuild>',
    '                </CommonProperty>',
    '              </FileOption>',
    '            </File>',
    '          </Files>',
    '        </Group>',
    '        <Group>',
    '          <GroupName>Lib</GroupName>',
    '          <Files></Files>',
    '        </Group>',
    '      </Groups>',
    '    </Target>',
    '  </Targets>',
    '</Project>',
    ''
].join('\n');

describe('uvGroups listTargets / toolchain detection', () => {
    it('reads every target of the ARMv6 project with its group and file counts', () => {
        const xml = readFixture('arm-ac6.uvprojx');

        assert.deepEqual(listTargets(xml), [
            { name: 'Demo_Debug', toolchain: 'ARM6', groupCount: 4, fileCount: 7 },
            { name: 'Demo_Release', toolchain: 'ARM6', groupCount: 4, fileCount: 7 }
        ]);
        assert.equal(detectToolchainOfTarget(xml, 'Demo_Debug'), 'ARM6');
        assert.equal(detectToolchainOfTarget(xml, 'Demo_Release'), 'ARM6');
        assert.equal(detectToolchainOfTarget(xml, 'Missing'), undefined);
    });

    it('reads the ARMv5 project', () => {
        const xml = readFixture('arm-ac5.uvproj');

        assert.deepEqual(listTargets(xml), [
            { name: 'ARM_Debug', toolchain: 'ARM', groupCount: 3, fileCount: 4 }
        ]);
        assert.equal(detectToolchainOfTarget(xml, 'ARM_Debug'), 'ARM');
    });

    it('detects C51 and C251 from ToolsetName', () => {
        const c51 = readFixture('c51.uvproj');
        assert.deepEqual(listTargets(c51), [
            { name: 'C51_Debug', toolchain: 'C51', groupCount: 4, fileCount: 5 },
            { name: 'C51_Release', toolchain: 'C51', groupCount: 4, fileCount: 5 }
        ]);
        assert.equal(detectToolchainOfTarget(c51, 'C51_Release'), 'C51');

        const c251 = readFixture('c251.uvproj');
        assert.deepEqual(listTargets(c251), [
            { name: 'C251_Debug', toolchain: 'C251', groupCount: 3, fileCount: 4 },
            { name: 'C251_Release', toolchain: 'C251', groupCount: 3, fileCount: 4 }
        ]);
        assert.equal(detectToolchainOfTarget(c251, 'C251_Debug'), 'C251');
    });

    it('supports a project without any <Targets> element', () => {
        assert.deepEqual(listTargets('<Project></Project>'), []);
    });
});

describe('uvGroups readTargetGroups', () => {
    it('reads groups, files and FileTypes of the ARMv6 fixture', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const groups = groupsOf(xml, 'Demo_Debug');

        assert.deepEqual(names(groups), ['Application', 'Drivers', 'Documentation', 'Library']);
        assert.deepEqual(
            groups[0].files.map((file) => [file.fileName, file.fileType, file.filePath, file.includeInBuild]),
            [
                ['main.c', 1, '.\\Application\\main.c', true],
                ['app.c', 1, '.\\Application\\app.c', true],
                ['app.h', 5, '.\\Application\\app.h', true]
            ]
        );
        assert.equal(groups[0].includeInBuild, true);
        assert.deepEqual(
            groups[1].files.map((file) => file.fileName),
            ['stm32f4xx_hal.c', 'system_stm32f4xx.c']
        );
        assert.deepEqual(
            groups[3].files.map((file) => [file.fileName, file.fileType]),
            [['libdemo.lib', 4]]
        );
    });

    it('returns undefined for an unknown target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.equal(readTargetGroups(xml, 'NoSuchTarget'), undefined);
    });

    it('reads C51 and C251 startup/library file types', () => {
        const c51 = groupsOf(readFixture('c51.uvproj'), 'C51_Debug');
        assert.deepEqual(
            c51.map((group) => group.name),
            ['Source', 'Startup', 'Library', 'Documentation']
        );
        assert.equal(c51[1].files[0].fileName, 'STARTUP.A51');
        assert.equal(c51[1].files[0].fileType, 2);
        assert.equal(c51[2].files[0].fileType, 4);

        const c251 = groupsOf(readFixture('c251.uvproj'), 'C251_Release');
        assert.deepEqual(
            c251.map((group) => group.name),
            ['Source', 'Startup', 'Library']
        );
    });
});

describe('uvGroups addGroup', () => {
    it('appends the new group and keeps the existing groups intact', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = addGroup(xml, 'Demo_Debug', 'Tests');

        assert.notEqual(updated, xml);
        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(names(groups), ['Application', 'Drivers', 'Documentation', 'Library', 'Tests']);
        assert.deepEqual(groups[4].files, []);
        assert.deepEqual(groups.slice(0, 4), groupsOf(xml, 'Demo_Debug'));

        // Only the edited target changed; the document header is untouched.
        assert.equal(
            updated.slice(0, updated.indexOf('<Targets>')),
            xml.slice(0, xml.indexOf('<Targets>'))
        );
        assert.equal(targetSlice(updated, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('is idempotent for an existing group', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.equal(addGroup(xml, 'Demo_Debug', 'Application'), xml);

        const once = addGroup(xml, 'Demo_Debug', 'Tests');
        assert.equal(addGroup(once, 'Demo_Debug', 'Tests'), once);
    });

    it('matches group names case-sensitively', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = addGroup(xml, 'Demo_Debug', 'application');
        assert.deepEqual(names(groupsOf(updated, 'Demo_Debug')), [
            'Application',
            'Drivers',
            'Documentation',
            'Library',
            'application'
        ]);
    });

    it('creates <Groups> when the target has none', () => {
        const updated = addGroup(PROJECT_WITHOUT_GROUPS, 'Debug', 'Core');
        assert.deepEqual(names(groupsOf(updated, 'Debug')), ['Core']);
        assert.ok(updated.includes('\n      <Groups>'));
        assert.ok(updated.includes('\n        <Group>\n          <GroupName>Core</GroupName>'));
    });

    it('expands a self-closing <Groups/>', () => {
        const updated = addGroup(PROJECT_WITH_EMPTY_GROUPS, 'Debug', 'Core');
        assert.deepEqual(names(groupsOf(updated, 'Debug')), ['Core']);
        assert.ok(!updated.includes('<Groups/>'));
    });

    it('works for C51 / C251 / ARMv5 projects', () => {
        const c51 = readFixture('c51.uvproj');
        const c51Updated = addGroup(c51, 'C51_Release', 'Extra');
        assert.deepEqual(names(groupsOf(c51Updated, 'C51_Release')), [
            'Source',
            'Startup',
            'Library',
            'Documentation',
            'Extra'
        ]);
        assert.deepEqual(groupsOf(c51Updated, 'C51_Release'), [
            ...groupsOf(c51, 'C51_Release').slice(0, 4),
            { name: 'Extra', includeInBuild: true, files: [] }
        ]);
        assert.deepEqual(groupsOf(c51Updated, 'C51_Debug'), groupsOf(c51, 'C51_Debug'));

        const c251 = readFixture('c251.uvproj');
        assert.deepEqual(names(groupsOf(addGroup(c251, 'C251_Debug', 'Extra'), 'C251_Debug')).length, 4);

        const arm5 = readFixture('arm-ac5.uvproj');
        assert.deepEqual(names(groupsOf(addGroup(arm5, 'ARM_Debug', 'Extra'), 'ARM_Debug')), [
            'Source',
            'Startup',
            'Library',
            'Extra'
        ]);
    });

    it('throws for an unknown target and names it in the message', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.throws(() => addGroup(xml, 'NoSuchTarget', 'Tests'), /NoSuchTarget/);
    });
});

describe('uvGroups addFiles', () => {
    it('adds files to an existing group and reports added entries', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const result = addFiles(xml, 'Demo_Debug', 'Drivers', [
            { filePath: '.\\Drivers\\can.c', fileName: 'can.c', fileType: 1 }
        ]);

        assert.deepEqual(result.added, ['.\\Drivers\\can.c']);
        assert.deepEqual(result.skipped, []);
        const groups = groupsOf(result.xml, 'Demo_Debug');
        assert.deepEqual(
            groups[1].files.map((file) => file.fileName),
            ['stm32f4xx_hal.c', 'system_stm32f4xx.c', 'can.c']
        );
        assert.deepEqual(groups[0], groupsOf(xml, 'Demo_Debug')[0]);
        assert.equal(targetSlice(result.xml, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
        assert.ok(result.xml.includes(
            '            <File>\n              <FileName>can.c</FileName>\n' +
            '              <FileType>1</FileType>\n' +
            '              <FilePath>.\\Drivers\\can.c</FilePath>\n            </File>'
        ));
    });

    it('is idempotent for an already present file', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const once = addFiles(xml, 'Demo_Debug', 'Drivers', [
            { filePath: '.\\Drivers\\can.c', fileName: 'can.c', fileType: 1 }
        ]);
        const twice = addFiles(once.xml, 'Demo_Debug', 'Drivers', [
            { filePath: '.\\Drivers\\can.c', fileName: 'can.c', fileType: 1 }
        ]);

        assert.deepEqual(twice.added, []);
        assert.deepEqual(twice.skipped, ['.\\Drivers\\can.c']);
        assert.equal(twice.xml, once.xml);
    });

    it('skips duplicates inside one call and compares paths case-insensitively', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const result = addFiles(xml, 'Demo_Debug', 'Drivers', [
            { filePath: '.\\Drivers\\can.c', fileName: 'can.c', fileType: 1 },
            { filePath: '.\\DRIVERS\\CAN.C', fileName: 'CAN.C', fileType: 1 },
            { filePath: '.\\.\\Drivers\\can.c', fileName: 'can.c', fileType: 1 }
        ]);

        assert.deepEqual(result.added, ['.\\Drivers\\can.c']);
        assert.deepEqual(result.skipped, ['.\\DRIVERS\\CAN.C', '.\\.\\Drivers\\can.c']);
        assert.equal(groupsOf(result.xml, 'Demo_Debug')[1].files.length, 3);
    });

    it('skips files that are already part of the group', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const result = addFiles(xml, 'Demo_Debug', 'Application', [
            { filePath: '.\\Application\\MAIN.C', fileName: 'MAIN.C', fileType: 1 }
        ]);

        assert.deepEqual(result.added, []);
        assert.deepEqual(result.skipped, ['.\\Application\\MAIN.C']);
        assert.equal(result.xml, xml);
    });

    it('creates the target group when it does not exist yet', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const result = addFiles(xml, 'Demo_Debug', 'Brand', [
            { filePath: '.\\Brand\\a.c', fileName: 'a.c', fileType: 1 },
            { filePath: '.\\Brand\\b.c', fileName: 'b.c', fileType: 1 }
        ]);

        assert.deepEqual(result.added, ['.\\Brand\\a.c', '.\\Brand\\b.c']);
        const groups = groupsOf(result.xml, 'Demo_Debug');
        assert.deepEqual(names(groups), ['Application', 'Drivers', 'Documentation', 'Library', 'Brand']);
        assert.deepEqual(
            groups[4].files.map((file) => file.fileName),
            ['a.c', 'b.c']
        );
        assert.equal(targetSlice(result.xml, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('creates <Groups>, <Files> and expands self-closing containers', () => {
        const entry = [{ filePath: '.\\Empty\\a.c', fileName: 'a.c', fileType: 1 }];

        const noGroups = addFiles(PROJECT_WITHOUT_GROUPS, 'Debug', 'Empty', entry);
        assert.deepEqual(names(groupsOf(noGroups.xml, 'Debug')), ['Empty']);
        assert.equal(groupsOf(noGroups.xml, 'Debug')[0].files.length, 1);

        const emptyGroups = addFiles(PROJECT_WITH_EMPTY_GROUPS, 'Debug', 'Empty', entry);
        assert.equal(groupsOf(emptyGroups.xml, 'Debug')[0].files.length, 1);

        const noFiles = addFiles(PROJECT_WITH_GROUP_WITHOUT_FILES, 'Debug', 'Empty', entry);
        assert.equal(groupsOf(noFiles.xml, 'Debug')[0].files.length, 1);
        assert.ok(noFiles.xml.includes('\n          <Files>\n            <File>'));

        const selfClosingFiles = addFiles(PROJECT_WITH_SELF_CLOSING_FILES, 'Debug', 'Empty', entry);
        assert.equal(groupsOf(selfClosingFiles.xml, 'Debug')[0].files.length, 1);
        assert.ok(!selfClosingFiles.xml.includes('<Files/>'));
    });

    it('adds files to C51 / C251 groups', () => {
        const c51 = readFixture('c51.uvproj');
        const c51Result = addFiles(c51, 'C51_Debug', 'Source', [
            { filePath: '.\\Source\\uart.c', fileName: 'uart.c', fileType: 1 }
        ]);
        assert.deepEqual(
            groupsOf(c51Result.xml, 'C51_Debug')[0].files.map((file) => file.fileName),
            ['main.c', 'delay.c', 'uart.c']
        );
        assert.equal(targetSlice(c51Result.xml, 'C51_Release'), targetSlice(c51, 'C51_Release'));

        const c251 = readFixture('c251.uvproj');
        const c251Result = addFiles(c251, 'C251_Debug', 'Startup', [
            { filePath: '.\\Startup\\STARTUP2.A51', fileName: 'STARTUP2.A51', fileType: 2 }
        ]);
        assert.deepEqual(
            groupsOf(c251Result.xml, 'C251_Debug')[1].files.map((file) => file.fileName),
            ['STARTUP.A51', 'STARTUP2.A51']
        );
    });

    it('throws for an unknown target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.throws(
            () => addFiles(xml, 'NoSuchTarget', 'Drivers', []),
            /NoSuchTarget/
        );
    });
});

describe('uvGroups removeFile', () => {
    it('removes only the requested file', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = removeFile(xml, 'Demo_Debug', 'Drivers', '.\\Drivers\\stm32f4xx_hal.c');

        assert.notEqual(updated, xml);
        assert.ok(!targetBlock(updated, 'Demo_Debug').includes('stm32f4xx_hal.c'));
        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(
            groups[1].files.map((file) => file.fileName),
            ['system_stm32f4xx.c']
        );
        assert.deepEqual(groups[0], groupsOf(xml, 'Demo_Debug')[0]);
        assert.equal(targetSlice(updated, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('is idempotent for missing files and missing groups', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.equal(removeFile(xml, 'Demo_Debug', 'Drivers', '.\\Drivers\\missing.c'), xml);
        assert.equal(removeFile(xml, 'Demo_Debug', 'MissingGroup', '.\\Drivers\\can.c'), xml);

        const once = removeFile(xml, 'Demo_Debug', 'Drivers', '.\\Drivers\\stm32f4xx_hal.c');
        assert.equal(removeFile(once, 'Demo_Debug', 'Drivers', '.\\Drivers\\stm32f4xx_hal.c'), once);
    });

    it('compares file paths case-insensitively', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = removeFile(xml, 'Demo_Debug', 'Drivers', '.\\DRIVERS\\STM32F4XX_HAL.C');
        assert.equal(groupsOf(updated, 'Demo_Debug')[1].files.length, 1);
    });

    it('keeps CRLF line endings intact when removing a node', () => {
        const crlf = PROJECT_WITH_FILE_OPTION.split('\n').join('\r\n');
        const updated = removeFile(crlf, 'Debug', 'App', '.\\App\\main.c');

        assert.equal(groupsOf(updated, 'Debug')[0].files.length, 0);
        assert.equal(/[^\r]\n/.test(updated), false, 'no bare LF should be introduced by the removal');
    });

    it('throws for an unknown target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.throws(() => removeFile(xml, 'NoSuchTarget', 'Drivers', '.\\Drivers\\can.c'), /NoSuchTarget/);
    });
});

describe('uvGroups moveFile', () => {
    it('moves a file between groups of the same target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = moveFile(xml, 'Demo_Debug', 'Application', 'Documentation', '.\\Application\\app.h');

        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(
            groups[0].files.map((file) => file.fileName),
            ['main.c', 'app.c']
        );
        assert.deepEqual(
            groups[2].files.map((file) => file.fileName),
            ['readme.txt', 'app.h']
        );
        assert.equal(targetSlice(updated, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('creates the destination group when it does not exist', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = moveFile(xml, 'Demo_Debug', 'Library', 'ThirdParty', '.\\Library\\libdemo.lib');

        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(names(groups), ['Application', 'Drivers', 'Documentation', 'Library', 'ThirdParty']);
        assert.deepEqual(groups[3].files, []);
        assert.deepEqual(
            groups[4].files.map((file) => [file.fileName, file.fileType, file.filePath]),
            [['libdemo.lib', 4, '.\\Library\\libdemo.lib']]
        );
    });

    it('preserves FileOption and re-indents the moved fragment', () => {
        const updated = moveFile(PROJECT_WITH_FILE_OPTION, 'Debug', 'App', 'Lib', '.\\App\\main.c');

        const groups = groupsOf(updated, 'Debug');
        assert.deepEqual(groups[0].files, []);
        assert.equal(groups[1].files.length, 1);
        assert.equal(groups[1].files[0].fileName, 'main.c');
        assert.equal(groups[1].files[0].includeInBuild, false, 'FileOption/IncludeInBuild must survive the move');

        const fileLine = updated.split('\n').find((line) => line.trim() === '<File>');
        assert.equal(fileLine, '            <File>');
        assert.ok(updated.includes('              <FileOption>\n'));
    });

    it('is a no-op for same group, missing file, missing source group or missing target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.equal(moveFile(xml, 'Demo_Debug', 'Application', 'Application', '.\\Application\\app.h'), xml);
        assert.equal(moveFile(xml, 'Demo_Debug', 'Application', 'Library', '.\\Application\\missing.h'), xml);
        assert.equal(moveFile(xml, 'Demo_Debug', 'MissingGroup', 'Library', '.\\Application\\app.h'), xml);
        assert.throws(
            () => moveFile(xml, 'NoSuchTarget', 'Application', 'Library', '.\\Application\\app.h'),
            /NoSuchTarget/
        );
    });
});

describe('uvGroups removeGroup', () => {
    it('removes the group together with its files', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = removeGroup(xml, 'Demo_Debug', 'Documentation');

        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(names(groups), ['Application', 'Drivers', 'Library']);
        assert.ok(!targetBlock(updated, 'Demo_Debug').includes('readme.txt'));
        assert.deepEqual(groups[0], groupsOf(xml, 'Demo_Debug')[0]);
        assert.equal(targetSlice(updated, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('is idempotent for a missing group', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.equal(removeGroup(xml, 'Demo_Debug', 'MissingGroup'), xml);

        const once = removeGroup(xml, 'Demo_Debug', 'Library');
        assert.equal(removeGroup(once, 'Demo_Debug', 'Library'), once);
    });

    it('throws for an unknown target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.throws(() => removeGroup(xml, 'NoSuchTarget', 'Library'), /NoSuchTarget/);
    });
});

describe('uvGroups renameGroup', () => {
    it('renames only the requested group and keeps its files', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = renameGroup(xml, 'Demo_Debug', 'Application', 'App');

        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(names(groups), ['App', 'Drivers', 'Documentation', 'Library']);
        assert.deepEqual(
            groups[0].files.map((file) => file.fileName),
            ['main.c', 'app.c', 'app.h']
        );
        assert.equal(targetSlice(updated, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('is idempotent for the same name and missing groups', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.equal(renameGroup(xml, 'Demo_Debug', 'Application', 'Application'), xml);
        assert.equal(renameGroup(xml, 'Demo_Debug', 'MissingGroup', 'App'), xml);
    });

    it('throws for an unknown target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.throws(() => renameGroup(xml, 'NoSuchTarget', 'Application', 'App'), /NoSuchTarget/);
    });
});

describe('uvGroups setFileInBuild / setGroupInBuild', () => {
    it('creates FileOption/CommonProperty/IncludeInBuild and only edits that file', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = setFileInBuild(xml, 'Demo_Debug', 'Application', '.\\Application\\app.c', false);

        assert.ok(updated.includes(
            '              <FileOption>\n' +
            '                <CommonProperty>\n' +
            '                  <IncludeInBuild>0</IncludeInBuild>\n' +
            '                </CommonProperty>\n' +
            '              </FileOption>'
        ));
        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(
            groups[0].files.map((file) => [file.fileName, file.includeInBuild]),
            [
                ['main.c', true],
                ['app.c', false],
                ['app.h', true]
            ]
        );
        assert.equal(groups[0].includeInBuild, true);
        assert.equal(targetSlice(updated, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('is idempotent and does not touch a file that already matches', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const once = setFileInBuild(xml, 'Demo_Debug', 'Application', '.\\Application\\app.c', false);
        assert.equal(setFileInBuild(once, 'Demo_Debug', 'Application', '.\\Application\\app.c', false), once);
        assert.equal(setFileInBuild(xml, 'Demo_Debug', 'Application', '.\\Application\\app.c', true), xml);
        assert.equal(setFileInBuild(xml, 'Demo_Debug', 'Application', '.\\Application\\missing.c', false), xml);
        assert.equal(setFileInBuild(xml, 'Demo_Debug', 'MissingGroup', '.\\Application\\app.c', false), xml);
    });

    it('creates GroupOption/CommonProperty/IncludeInBuild for groups', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const updated = setGroupInBuild(xml, 'Demo_Debug', 'Drivers', false);

        assert.ok(updated.includes(
            '          <GroupOption>\n' +
            '            <CommonProperty>\n' +
            '              <IncludeInBuild>0</IncludeInBuild>\n' +
            '            </CommonProperty>\n' +
            '          </GroupOption>'
        ));
        const groups = groupsOf(updated, 'Demo_Debug');
        assert.deepEqual(
            groups.map((group) => [group.name, group.includeInBuild]),
            [
                ['Application', true],
                ['Drivers', false],
                ['Documentation', true],
                ['Library', true]
            ]
        );
        assert.deepEqual(
            groups[1].files.map((file) => file.includeInBuild),
            [true, true]
        );
        assert.equal(targetSlice(updated, 'Demo_Release'), targetSlice(xml, 'Demo_Release'));
    });

    it('is idempotent for groups', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const once = setGroupInBuild(xml, 'Demo_Debug', 'Drivers', false);
        assert.equal(setGroupInBuild(once, 'Demo_Debug', 'Drivers', false), once);
        assert.equal(setGroupInBuild(xml, 'Demo_Debug', 'Drivers', true), xml);
        assert.equal(setGroupInBuild(xml, 'Demo_Debug', 'MissingGroup', false), xml);
    });

    it('works on C51 and C251 projects', () => {
        const c51 = readFixture('c51.uvproj');
        const c51Updated = setFileInBuild(c51, 'C51_Debug', 'Startup', '.\\Startup\\STARTUP.A51', false);
        assert.equal(groupsOf(c51Updated, 'C51_Debug')[1].files[0].includeInBuild, false);
        assert.equal(groupsOf(c51Updated, 'C51_Debug')[0].files[0].includeInBuild, true);
        assert.equal(targetSlice(c51Updated, 'C51_Release'), targetSlice(c51, 'C51_Release'));

        const c251 = readFixture('c251.uvproj');
        const c251Updated = setGroupInBuild(c251, 'C251_Release', 'Library', false);
        assert.equal(groupsOf(c251Updated, 'C251_Release')[2].includeInBuild, false);
        assert.equal(groupsOf(c251Updated, 'C251_Release')[0].includeInBuild, true);
    });

    it('throws for an unknown target', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        assert.throws(
            () => setFileInBuild(xml, 'NoSuchTarget', 'Application', '.\\Application\\app.c', false),
            /NoSuchTarget/
        );
        assert.throws(() => setGroupInBuild(xml, 'NoSuchTarget', 'Application', false), /NoSuchTarget/);
    });
});

describe('uvGroups listTargets after edits', () => {
    it('reflects add/remove operations in the summary', () => {
        const xml = readFixture('arm-ac6.uvprojx');
        const added = addGroup(xml, 'Demo_Debug', 'Tests');
        assert.deepEqual(listTargets(added)[0], {
            name: 'Demo_Debug',
            toolchain: 'ARM6',
            groupCount: 5,
            fileCount: 7
        });

        const removed = removeGroup(xml, 'Demo_Debug', 'Documentation');
        assert.deepEqual(listTargets(removed)[0], {
            name: 'Demo_Debug',
            toolchain: 'ARM6',
            groupCount: 3,
            fileCount: 6
        });
        assert.deepEqual(listTargets(removed)[1], listTargets(xml)[1]);
    });
});

describe('uvGroups fileTypeForPath', () => {
    it('maps the Keil file types', () => {
        assert.equal(fileTypeForPath('main.c'), 1);
        assert.equal(fileTypeForPath('MAIN.C'), 1);
        assert.equal(fileTypeForPath('app.cpp'), 8);
        assert.equal(fileTypeForPath('app.cc'), 8);
        assert.equal(fileTypeForPath('app.cxx'), 8);
        assert.equal(fileTypeForPath('app.c++'), 8);
        assert.equal(fileTypeForPath('startup.s'), 2);
        assert.equal(fileTypeForPath('startup.asm'), 2);
        assert.equal(fileTypeForPath('STARTUP.A51'), 2);
        assert.equal(fileTypeForPath('driver.lib'), 4);
        assert.equal(fileTypeForPath('driver.a'), 4);
        assert.equal(fileTypeForPath('module.o'), 3);
        assert.equal(fileTypeForPath('module.obj'), 3);
        assert.equal(fileTypeForPath('image.png'), 9);
        assert.equal(fileTypeForPath('image.jpg'), 9);
        assert.equal(fileTypeForPath('image.gif'), 9);
        assert.equal(fileTypeForPath('image.bmp'), 9);
        assert.equal(fileTypeForPath('page.html'), 7);
        assert.equal(fileTypeForPath('page.htm'), 7);
        assert.equal(fileTypeForPath('keil.inp'), 7);
        assert.equal(fileTypeForPath('header.h'), 5);
        assert.equal(fileTypeForPath('readme.txt'), 5);
        assert.equal(fileTypeForPath('noextension'), 5);
    });
});

describe('uvGroups project path conversion (Windows)', () => {
    const windowsOnly = process.platform === 'win32' ? it : it.skip;

    windowsOnly('writes project-relative paths with a .\\ prefix', () => {
        assert.equal(toUvProjectPath('C:\\proj', 'C:\\proj\\src\\main.c'), '.\\src\\main.c');
        assert.equal(toUvProjectPath('C:\\proj\\', 'C:\\proj\\main.c'), '.\\main.c');
        assert.equal(toUvProjectPath('C:\\proj', 'C:\\proj\\a\\b\\c.c'), '.\\a\\b\\c.c');
    });

    windowsOnly('keeps the original casing and backslashes', () => {
        assert.equal(toUvProjectPath('C:\\Project', 'c:\\project\\Src\\Main.C'), '.\\Src\\Main.C');
    });

    windowsOnly('expresses parent-directory references', () => {
        assert.equal(toUvProjectPath('C:\\proj\\src', 'C:\\proj\\include\\x.h'), '.\\..\\include\\x.h');
        assert.equal(toUvProjectPath('C:\\proj\\a\\b', 'C:\\proj\\x.c'), '.\\..\\..\\x.c');
    });

    windowsOnly('writes absolute paths for other drives', () => {
        assert.equal(toUvProjectPath('C:\\proj', 'D:\\shared\\x.c'), 'D:\\shared\\x.c');
    });

    windowsOnly('accepts already relative input', () => {
        assert.equal(toUvProjectPath('C:\\proj', 'src\\main.c'), '.\\src\\main.c');
        assert.equal(toUvProjectPath('C:\\proj', '.\\src\\main.c'), '.\\src\\main.c');
    });

    windowsOnly('resolves .\\, ..\\, bare relative and absolute project paths', () => {
        assert.equal(fromUvProjectPath('C:\\proj', '.\\src\\main.c'), 'C:\\proj\\src\\main.c');
        assert.equal(fromUvProjectPath('C:\\proj', '..\\include\\x.h'), 'C:\\include\\x.h');
        assert.equal(fromUvProjectPath('C:\\proj', 'src/main.c'), 'C:\\proj\\src\\main.c');
        assert.equal(fromUvProjectPath('C:\\proj', 'D:\\shared\\x.c'), 'D:\\shared\\x.c');
        assert.equal(fromUvProjectPath('C:\\proj', 'C:\\proj\\src\\..\\main.c'), 'C:\\proj\\main.c');
    });

    windowsOnly('round-trips an absolute path through both helpers', () => {
        const projectDir = 'C:\\work\\fw';
        const files = ['C:\\work\\fw\\main.c', 'C:\\work\\fw\\src\\app\\app.c', 'D:\\shared\\lib.c'];

        for (const absolutePath of files) {
            const uvPath = toUvProjectPath(projectDir, absolutePath);
            const roundTripped = fromUvProjectPath(projectDir, uvPath);
            assert.equal(roundTripped.toLowerCase(), absolutePath.toLowerCase(), uvPath);
        }
    });
});
