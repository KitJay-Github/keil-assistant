import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

type MenuEntry = {
    command: string;
    when?: string;
    group?: string;
};

type CommandEntry = {
    command: string;
    title: string;
    icon?: unknown;
};

/** Command id -> title contract from the 2.6.0 design document. */
const NEW_COMMAND_TITLES: Record<string, string> = {
    'project.options': '工程选项(Options for Target)…',
    'project.addFilesToGroup': '添加文件到分组…',
    'project.newFile': '新建源文件并加入工程…',
    'project.removeFile': '从工程移除文件',
    'project.addGroup': '新建分组…',
    'project.renameGroup': '重命名分组…',
    'project.removeGroup': '删除分组',
    'project.moveFileToGroup': '移动文件到分组…',
    'project.toggleFileInBuild': '切换文件是否参与编译',
    'project.toggleGroupInBuild': '切换分组是否参与编译'
};

const NEW_COMMANDS = Object.keys(NEW_COMMAND_TITLES);

/** Project file commands expected per project tree item type. */
const CONTEXT_MENU_COMMANDS: Record<string, string[]> = {
    Project: [
        'project.options',
        'project.addFilesToGroup',
        'project.newFile',
        'project.addGroup'
    ],
    Target: [
        'project.options',
        'project.addFilesToGroup',
        'project.newFile',
        'project.addGroup'
    ],
    FileGroup: [
        'project.addFilesToGroup',
        'project.newFile',
        'project.addGroup',
        'project.renameGroup',
        'project.removeGroup',
        'project.toggleGroupInBuild'
    ],
    Source: [
        'project.removeFile',
        'project.moveFileToGroup',
        'project.toggleFileInBuild'
    ]
};

/** Only the non-destructive entry points are offered through the command palette. */
const COMMAND_PALETTE_COMMANDS = ['project.options', 'project.addGroup', 'project.newFile'];

function readPackageJson(): any {
    const packageJsonPath = path.resolve(__dirname, '../../../package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function findMenuEntries(entries: MenuEntry[], command: string): MenuEntry[] {
    return entries.filter(entry => entry.command === command);
}

function findCommand(manifest: any, command: string): CommandEntry | undefined {
    const commands = manifest.contributes?.commands as CommandEntry[] | undefined;
    return (commands ?? []).find(entry => entry.command === command);
}

describe('package contributions', () => {
    it('exposes project refresh and reveal actions from the project explorer UI', () => {
        const manifest = readPackageJson();
        const menus = manifest.contributes?.menus ?? {};
        const viewTitleEntries = menus['view/title'] as MenuEntry[] || [];
        const viewItemContextEntries = menus['view/item/context'] as MenuEntry[] || [];

        assert.ok(
            findMenuEntries(viewTitleEntries, 'project.refresh').some(entry => entry.when === 'view == project'),
            'expected project.refresh in the project view title'
        );
        assert.ok(
            findMenuEntries(viewTitleEntries, 'project.revealCurrentFile').some(entry => entry.when === 'view == project'),
            'expected project.revealCurrentFile in the project view title'
        );
        assert.ok(
            findMenuEntries(viewItemContextEntries, 'project.refresh').some(entry => entry.when === 'viewItem == Project'),
            'expected project.refresh in the project item context menu'
        );
        assert.ok(
            findMenuEntries(viewItemContextEntries, 'project.clearCacheAndRefresh').some(entry => entry.when === 'viewItem == Project'),
            'expected project.clearCacheAndRefresh in the project item context menu'
        );
        assert.ok(
            findMenuEntries(viewItemContextEntries, 'project.revealCurrentFile').some(entry => entry.when === 'viewItem == Project'),
            'expected project.revealCurrentFile in the project item context menu'
        );
    });

    it('bumps the extension to the 2.6.0 project file and target option release', () => {
        assert.equal(readPackageJson().version, '2.6.0');
    });

    it('contributes the project file and target option commands', () => {
        const manifest = readPackageJson();

        for (const command of NEW_COMMANDS) {
            const entry = findCommand(manifest, command);
            assert.ok(entry, `expected command ${command} to be contributed`);
            assert.equal(entry.title, NEW_COMMAND_TITLES[command], `unexpected title for ${command}`);
        }
    });

    it('exposes the options command from the project view title', () => {
        const manifest = readPackageJson();
        const viewTitleEntries =
            (manifest.contributes?.menus?.['view/title'] as MenuEntry[] | undefined) ?? [];

        assert.ok(
            findMenuEntries(viewTitleEntries, 'project.options').some(
                entry => entry.when === 'view == project' && entry.group === 'navigation@0'
            ),
            'expected project.options at navigation@0 in the project view title'
        );
    });

    it('contributes project file commands for project, target, group and source context menus', () => {
        const manifest = readPackageJson();
        const viewItemContextEntries =
            (manifest.contributes?.menus?.['view/item/context'] as MenuEntry[] | undefined) ?? [];

        for (const viewItem of Object.keys(CONTEXT_MENU_COMMANDS)) {
            const matched = viewItemContextEntries
                .filter(entry => entry.when === `viewItem == ${viewItem}`)
                .map(entry => entry.command)
                .filter(command => NEW_COMMANDS.indexOf(command) !== -1);
            const actual = Array.from(new Set(matched)).sort();
            const expected = CONTEXT_MENU_COMMANDS[viewItem].slice().sort();

            assert.deepEqual(
                actual,
                expected,
                `unexpected project file commands for viewItem == ${viewItem}`
            );
        }

        // The new commands may only target the four project tree item types.
        for (const entry of viewItemContextEntries.filter(entry => NEW_COMMANDS.indexOf(entry.command) !== -1)) {
            assert.ok(
                Object.keys(CONTEXT_MENU_COMMANDS).some(viewItem => entry.when === `viewItem == ${viewItem}`),
                `expected ${entry.command} to target a known project tree item, got when=${entry.when}`
            );
        }

        // Inline actions stay limited to the existing build/rebuild/download/copyValue set.
        const inlineCommands = viewItemContextEntries
            .filter(entry => entry.group === 'inline')
            .map(entry => entry.command);
        for (const command of NEW_COMMANDS) {
            assert.equal(
                inlineCommands.indexOf(command),
                -1,
                `expected ${command} not to be exposed as an inline action`
            );
        }
    });

    it('limits the new commands that enter the command palette', () => {
        const manifest = readPackageJson();
        const paletteEntries =
            (manifest.contributes?.menus?.commandPalette as MenuEntry[] | undefined) ?? [];

        assert.deepEqual(
            paletteEntries.map(entry => entry.command).sort(),
            COMMAND_PALETTE_COMMANDS.slice().sort()
        );
        for (const entry of paletteEntries) {
            assert.equal(entry.when, 'workspaceFolderCount > 0');
        }
    });

    it('contributes the backup-before-write setting', () => {
        const manifest = readPackageJson();
        const properties = manifest.contributes?.configuration?.[0]?.properties;
        const setting = properties?.['KeilAssistant.Project.BackupBeforeWrite'];

        assert.ok(setting, 'expected KeilAssistant.Project.BackupBeforeWrite to be contributed');
        assert.equal(setting.type, 'boolean');
        assert.equal(setting.scope, 'resource');
        assert.equal(setting.default, true);
    });
});
