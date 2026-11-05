/**
 * User-facing commands for the Keil project file management feature.
 *
 * The module is a thin interaction layer: it collects user input with VS Code
 * UI primitives, re-reads the project file to know the current state, and hands
 * every *write* to {@link ProjectFileCommandServices.applyChange}. It never
 * writes the project file itself, so backup / encoding / retry / tree refresh
 * stay in one place (`src/extension.ts`).
 *
 * All user visible strings are Chinese and mention the target name, because one
 * project file can hold several targets (Debug/Release, ...).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { readProjectTextFile } from './projectFileIo';
import {
    UvFileEntry,
    UvFileToAdd,
    UvGroupEntry,
    UvToolchainKind,
    addFiles,
    addGroup,
    fileTypeForPath,
    fromUvProjectPath,
    moveFile,
    readTargetGroups,
    removeFile,
    removeGroup,
    renameGroup,
    setFileInBuild,
    setGroupInBuild,
    toUvProjectPath
} from './uvGroups';

/** Context resolved from the clicked tree item. */
export interface ProjectFileCommandContext {
    prjID: string;
    /** Absolute path of the `.uvproj` / `.uvprojx` file. */
    projectFile: string;
    /** Absolute path of the directory that contains the project file. */
    projectDir: string;
    /** Active target of the project (commands act on this target only). */
    targetName: string;
    toolchain: UvToolchainKind;
    /** Group that owns the clicked `Source`. */
    groupName?: string;
    /** Absolute path of the clicked `Source`. */
    filePath?: string;
}

/** Services provided by the extension wiring (`src/extension.ts`). */
export interface ProjectFileCommandServices {
    resolve(item: unknown): ProjectFileCommandContext | undefined;
    applyChange(
        ctx: ProjectFileCommandContext,
        mutate: (xml: string) => string,
        options?: { successMessage?: string }
    ): Promise<boolean>;
    notify(kind: 'info' | 'warning' | 'error', message: string): void;
}

const DEFAULT_NEW_FILE_NAME = 'new_file.c';
const CREATE_GROUP_ITEM_LABEL = '$(add) 新建分组…';
const REMOVE_ACTION = '移除';
const DELETE_ACTION = '删除';

const SOURCE_FILE_EXTENSIONS = [
    'c',
    'cpp',
    'cc',
    'cxx',
    'c++',
    'h',
    'hpp',
    'hxx',
    'inc',
    's',
    'asm',
    'a51',
    'lib',
    'a',
    'obj'
];
const ALL_FILE_EXTENSIONS = ['*'];

/** Characters Windows rejects in file/group names. Control characters are checked separately. */
const INVALID_NAME_CHARACTERS = /[<>:"/\\|?*]/;
const INVALID_SEGMENT_CHARACTERS = /[<>:"|?*]/;

/** True when the text contains a C0 control character (U+0000..U+001F). */
function containsControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) <= 0x1f) {
            return true;
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjectFileCommands(services: ProjectFileCommandServices): vscode.Disposable[] {
    return [
        registerCommand(services, 'project.addFilesToGroup', '添加文件', (item) =>
            commandAddFilesToGroup(services, item)
        ),
        registerCommand(services, 'project.newFile', '新建源文件', (item) =>
            commandNewFile(services, item)
        ),
        registerCommand(services, 'project.removeFile', '从工程移除文件', (item) =>
            commandRemoveFile(services, item)
        ),
        registerCommand(services, 'project.addGroup', '新建分组', (item) =>
            commandAddGroup(services, item)
        ),
        registerCommand(services, 'project.renameGroup', '重命名分组', (item) =>
            commandRenameGroup(services, item)
        ),
        registerCommand(services, 'project.removeGroup', '删除分组', (item) =>
            commandRemoveGroup(services, item)
        ),
        registerCommand(services, 'project.moveFileToGroup', '移动文件到分组', (item) =>
            commandMoveFileToGroup(services, item)
        ),
        registerCommand(services, 'project.toggleFileInBuild', '切换文件是否参与编译', (item) =>
            commandToggleFileInBuild(services, item)
        ),
        registerCommand(services, 'project.toggleGroupInBuild', '切换分组是否参与编译', (item) =>
            commandToggleGroupInBuild(services, item)
        )
    ];
}

function registerCommand(
    services: ProjectFileCommandServices,
    commandId: string,
    actionLabel: string,
    handler: (item: unknown) => Promise<void>
): vscode.Disposable {
    return vscode.commands.registerCommand(commandId, (item?: unknown) => {
        void handler(item).catch((error: unknown) => {
            services.notify('error', `${actionLabel}失败：${describeError(error)}`);
        });
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandAddFilesToGroup(
    services: ProjectFileCommandServices,
    item: unknown
): Promise<void> {
    const ctx = requireContext(services, item, '添加文件到分组');
    if (!ctx) {
        return;
    }
    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }

    let groupName = ctx.groupName;
    if (!groupName || !groups.some((group) => group.name === groupName)) {
        groupName = await pickGroupName(services, ctx, groups, {
            placeHolder: `选择目标「${ctx.targetName}」中接收文件的分组`,
            allowCreate: true
        });
        if (!groupName) {
            return;
        }
    }

    const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: '添加到工程',
        filters: {
            'Source Files': SOURCE_FILE_EXTENSIONS,
            'All Files': ALL_FILE_EXTENSIONS
        }
    });
    if (!selected || selected.length === 0) {
        return;
    }

    const knownFiles = new Set<string>();
    for (const group of groups) {
        for (const file of group.files) {
            knownFiles.add(comparableAbsolutePath(fromUvProjectPath(ctx.projectDir, file.filePath)));
        }
    }

    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const uri of selected) {
        const absolutePath = path.normalize(uri.fsPath);
        const key = comparableAbsolutePath(absolutePath);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (knownFiles.has(key)) {
            continue;
        }
        candidates.push(absolutePath);
    }

    const skippedCount = selected.length - candidates.length;
    if (candidates.length === 0) {
        services.notify('info', `所选文件均已存在于目标「${ctx.targetName}」中，未添加任何文件。`);
        return;
    }

    const entries = candidates.map((absolutePath) => buildFileEntry(ctx.projectDir, absolutePath));
    const targetGroup = groupName;
    const addedCount = entries.length;
    await services.applyChange(
        ctx,
        (xml) => addFiles(xml, ctx.targetName, targetGroup, entries).xml,
        {
            successMessage:
                `已向目标「${ctx.targetName}」的分组「${targetGroup}」添加 ${addedCount} 个文件` +
                (skippedCount > 0 ? `，跳过 ${skippedCount} 个已存在的文件。` : '。')
        }
    );
}

async function commandNewFile(services: ProjectFileCommandServices, item: unknown): Promise<void> {
    const ctx = requireContext(services, item, '新建源文件');
    if (!ctx) {
        return;
    }
    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }

    const rawName = await vscode.window.showInputBox({
        title: `新建源文件（目标：${ctx.targetName}）`,
        prompt: '输入文件名，可带工程目录内的相对路径（例如 Src/new_file.c）',
        value: DEFAULT_NEW_FILE_NAME,
        valueSelection: [0, DEFAULT_NEW_FILE_NAME.length],
        validateInput: (input) => resolveNewFilePath(ctx.projectDir, input).error
    });
    if (rawName === undefined) {
        return;
    }

    const resolution = resolveNewFilePath(ctx.projectDir, rawName);
    if (!resolution.absolutePath) {
        services.notify('error', resolution.error || '文件名无效。');
        return;
    }
    const absolutePath = resolution.absolutePath;

    let groupName = ctx.groupName;
    if (!groupName || !groups.some((group) => group.name === groupName)) {
        groupName = await pickGroupName(services, ctx, groups, {
            placeHolder: `选择目标「${ctx.targetName}」中接收新文件的分组`,
            allowCreate: true
        });
        if (!groupName) {
            return;
        }
    }

    try {
        fs.writeFileSync(absolutePath, buildNewFileContent(ctx.projectDir, absolutePath), 'utf8');
    } catch (error) {
        services.notify('error', `创建文件「${path.basename(absolutePath)}」失败：${describeError(error)}`);
        return;
    }

    const entry = buildFileEntry(ctx.projectDir, absolutePath);
    const targetGroup = groupName;
    let applied = false;
    try {
        applied = await services.applyChange(
            ctx,
            (xml) => addFiles(xml, ctx.targetName, targetGroup, [entry]).xml,
            {
                successMessage:
                    `已在目标「${ctx.targetName}」的分组「${targetGroup}」中创建文件「${path.basename(absolutePath)}」。`
            }
        );
    } catch (error) {
        services.notify('error', `文件已创建，但加入工程失败：${describeError(error)}`);
    }
    if (!applied) {
        services.notify('warning', `文件已创建但未加入工程：${absolutePath}`);
    }

    await openFileInEditor(absolutePath);
}

async function commandRemoveFile(services: ProjectFileCommandServices, item: unknown): Promise<void> {
    const ctx = requireContext(services, item, '从工程移除文件');
    if (!ctx) {
        return;
    }
    const groupName = ctx.groupName;
    const clickedFilePath = ctx.filePath;
    if (!groupName || !clickedFilePath) {
        services.notify('warning', '请在工程树中的文件节点上执行「从工程移除文件」。');
        return;
    }

    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }
    const group = groups.find((candidate) => candidate.name === groupName);
    const file = group ? findFileEntry(ctx.projectDir, group, clickedFilePath) : undefined;
    if (!group || !file) {
        services.notify('warning', `未在目标「${ctx.targetName}」的分组「${groupName}」中找到该文件。`);
        return;
    }

    const confirmed = await vscode.window.showWarningMessage(
        `确定要从目标「${ctx.targetName}」的分组「${group.name}」中移除文件「${file.fileName}」吗？` +
            '文件不会被删除，只是不再参与工程构建。',
        { modal: true },
        REMOVE_ACTION
    );
    if (confirmed !== REMOVE_ACTION) {
        return;
    }

    const removedGroupName = group.name;
    const removedUvPath = file.filePath;
    await services.applyChange(
        ctx,
        (xml) => removeFile(xml, ctx.targetName, removedGroupName, removedUvPath),
        {
            successMessage:
                `已从目标「${ctx.targetName}」的分组「${removedGroupName}」中移除文件「${file.fileName}」。`
        }
    );
}

async function commandAddGroup(services: ProjectFileCommandServices, item: unknown): Promise<void> {
    const ctx = requireContext(services, item, '新建分组');
    if (!ctx) {
        return;
    }
    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }

    const groupName = await promptForGroupName(ctx, groups, {
        title: '新建分组',
        prompt: '请输入新分组名称',
        placeHolder: '例如 Drivers'
    });
    if (!groupName) {
        return;
    }

    await services.applyChange(ctx, (xml) => addGroup(xml, ctx.targetName, groupName), {
        successMessage: `已在目标「${ctx.targetName}」中新建分组「${groupName}」。`
    });
}

async function commandRenameGroup(services: ProjectFileCommandServices, item: unknown): Promise<void> {
    const ctx = requireContext(services, item, '重命名分组');
    if (!ctx) {
        return;
    }
    const currentName = ctx.groupName;
    if (!currentName) {
        services.notify('warning', '请在工程树中的分组节点上执行「重命名分组」。');
        return;
    }

    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }
    if (!groups.some((group) => group.name === currentName)) {
        services.notify('warning', `未在目标「${ctx.targetName}」中找到分组「${currentName}」。`);
        return;
    }

    const newName = await promptForGroupName(ctx, groups, {
        title: '重命名分组',
        prompt: '请输入新的分组名称',
        placeHolder: '例如 Drivers',
        currentName
    });
    if (!newName || newName === currentName) {
        return;
    }

    await services.applyChange(ctx, (xml) => renameGroup(xml, ctx.targetName, currentName, newName), {
        successMessage: `已把目标「${ctx.targetName}」中的分组「${currentName}」重命名为「${newName}」。`
    });
}

async function commandRemoveGroup(services: ProjectFileCommandServices, item: unknown): Promise<void> {
    const ctx = requireContext(services, item, '删除分组');
    if (!ctx) {
        return;
    }
    const groupName = ctx.groupName;
    if (!groupName) {
        services.notify('warning', '请在工程树中的分组节点上执行「删除分组」。');
        return;
    }

    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }
    const group = groups.find((candidate) => candidate.name === groupName);
    if (!group) {
        services.notify('warning', `未在目标「${ctx.targetName}」中找到分组「${groupName}」。`);
        return;
    }

    const confirmed = await vscode.window.showWarningMessage(
        `确定要删除目标「${ctx.targetName}」中的分组「${group.name}」吗？` +
            `该分组包含 ${group.files.length} 个文件；只从工程中移除，不会删除磁盘文件。`,
        { modal: true },
        DELETE_ACTION
    );
    if (confirmed !== DELETE_ACTION) {
        return;
    }

    const removedGroupName = group.name;
    await services.applyChange(ctx, (xml) => removeGroup(xml, ctx.targetName, removedGroupName), {
        successMessage: `已从目标「${ctx.targetName}」中删除分组「${removedGroupName}」。`
    });
}

async function commandMoveFileToGroup(
    services: ProjectFileCommandServices,
    item: unknown
): Promise<void> {
    const ctx = requireContext(services, item, '移动文件到分组');
    if (!ctx) {
        return;
    }
    const groupName = ctx.groupName;
    const clickedFilePath = ctx.filePath;
    if (!groupName || !clickedFilePath) {
        services.notify('warning', '请在工程树中的文件节点上执行「移动文件到分组」。');
        return;
    }

    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }
    const sourceGroup = groups.find((candidate) => candidate.name === groupName);
    const file = sourceGroup ? findFileEntry(ctx.projectDir, sourceGroup, clickedFilePath) : undefined;
    if (!sourceGroup || !file) {
        services.notify('warning', `未在目标「${ctx.targetName}」的分组「${groupName}」中找到该文件。`);
        return;
    }

    const destination = await pickGroupName(services, ctx, groups, {
        placeHolder: `选择目标「${ctx.targetName}」中「${file.fileName}」要移动到的分组`,
        allowCreate: true,
        excludedGroup: sourceGroup.name
    });
    if (!destination || destination === sourceGroup.name) {
        return;
    }

    const fromGroup = sourceGroup.name;
    const uvPath = file.filePath;
    await services.applyChange(
        ctx,
        (xml) => moveFile(xml, ctx.targetName, fromGroup, destination, uvPath),
        {
            successMessage:
                `已将目标「${ctx.targetName}」中的文件「${file.fileName}」从分组「${fromGroup}」移动到「${destination}」。`
        }
    );
}

async function commandToggleFileInBuild(
    services: ProjectFileCommandServices,
    item: unknown
): Promise<void> {
    const ctx = requireContext(services, item, '切换文件是否参与编译');
    if (!ctx) {
        return;
    }
    const groupName = ctx.groupName;
    const clickedFilePath = ctx.filePath;
    if (!groupName || !clickedFilePath) {
        services.notify('warning', '请在工程树中的文件节点上执行「切换文件是否参与编译」。');
        return;
    }

    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }
    const group = groups.find((candidate) => candidate.name === groupName);
    const file = group ? findFileEntry(ctx.projectDir, group, clickedFilePath) : undefined;
    if (!group || !file) {
        services.notify('warning', `未在目标「${ctx.targetName}」的分组「${groupName}」中找到该文件。`);
        return;
    }

    const include = !file.includeInBuild;
    const resolvedGroupName = group.name;
    const uvPath = file.filePath;
    await services.applyChange(
        ctx,
        (xml) => setFileInBuild(xml, ctx.targetName, resolvedGroupName, uvPath, include),
        {
            successMessage:
                `已在目标「${ctx.targetName}」中${include ? '启用' : '禁用'}文件「${file.fileName}」的编译。`
        }
    );
}

async function commandToggleGroupInBuild(
    services: ProjectFileCommandServices,
    item: unknown
): Promise<void> {
    const ctx = requireContext(services, item, '切换分组是否参与编译');
    if (!ctx) {
        return;
    }
    const groupName = ctx.groupName;
    if (!groupName) {
        services.notify('warning', '请在工程树中的分组节点上执行「切换分组是否参与编译」。');
        return;
    }

    const groups = await loadGroups(services, ctx);
    if (!groups) {
        return;
    }
    const group = groups.find((candidate) => candidate.name === groupName);
    if (!group) {
        services.notify('warning', `未在目标「${ctx.targetName}」中找到分组「${groupName}」。`);
        return;
    }

    const include = !group.includeInBuild;
    const resolvedGroupName = group.name;
    await services.applyChange(
        ctx,
        (xml) => setGroupInBuild(xml, ctx.targetName, resolvedGroupName, include),
        {
            successMessage:
                `已在目标「${ctx.targetName}」中${include ? '启用' : '禁用'}分组「${resolvedGroupName}」的编译。`
        }
    );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function requireContext(
    services: ProjectFileCommandServices,
    item: unknown,
    actionLabel: string
): ProjectFileCommandContext | undefined {
    const ctx = services.resolve(item);
    if (!ctx) {
        services.notify('warning', `请先在工程树中选择一个 Keil 工程或目标，再执行「${actionLabel}」。`);
        return undefined;
    }
    return ctx;
}

/**
 * Read the current project file and return the groups of the active target.
 * Reads only; all writes go through `services.applyChange`.
 */
async function loadGroups(
    services: ProjectFileCommandServices,
    ctx: ProjectFileCommandContext
): Promise<UvGroupEntry[] | undefined> {
    let xml: string;
    try {
        xml = readProjectTextFile(ctx.projectFile).text;
    } catch (error) {
        services.notify(
            'error',
            `无法读取工程文件「${path.basename(ctx.projectFile)}」：${describeError(error)}`
        );
        return undefined;
    }

    let groups: UvGroupEntry[] | undefined;
    try {
        groups = readTargetGroups(xml, ctx.targetName);
    } catch (error) {
        services.notify(
            'error',
            `解析工程文件「${path.basename(ctx.projectFile)}」失败：${describeError(error)}`
        );
        return undefined;
    }

    if (!groups) {
        services.notify(
            'error',
            `工程「${path.basename(ctx.projectFile)}」中不存在目标「${ctx.targetName}」，请刷新工程后重试。`
        );
        return undefined;
    }
    return groups;
}

interface GroupQuickPickItem extends vscode.QuickPickItem {
    groupName?: string;
    createNewGroup?: boolean;
}

/** Let the user pick one of the existing groups, optionally creating a new one. */
async function pickGroupName(
    services: ProjectFileCommandServices,
    ctx: ProjectFileCommandContext,
    groups: UvGroupEntry[],
    options: { placeHolder: string; allowCreate: boolean; excludedGroup?: string }
): Promise<string | undefined> {
    const items: GroupQuickPickItem[] = groups
        .filter((group) => group.name !== options.excludedGroup)
        .map((group) => ({
            label: group.name,
            description: `${group.files.length} 个文件`,
            groupName: group.name
        }));

    if (options.allowCreate) {
        items.push({
            label: CREATE_GROUP_ITEM_LABEL,
            description: '在当前目标中创建新分组',
            createNewGroup: true
        });
    }

    if (items.length === 0) {
        services.notify('warning', `目标「${ctx.targetName}」中还没有任何分组。`);
        return undefined;
    }

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: options.placeHolder,
        matchOnDescription: true
    });
    if (!picked) {
        return undefined;
    }
    if (!picked.createNewGroup) {
        return picked.groupName;
    }

    return promptForGroupName(ctx, groups, {
        title: '新建分组',
        prompt: '请输入新分组名称',
        placeHolder: '例如 Drivers'
    });
}

/** Ask for a group name and validate empty/illegal/duplicate names. */
async function promptForGroupName(
    ctx: ProjectFileCommandContext,
    groups: UvGroupEntry[],
    options: { title: string; prompt: string; placeHolder: string; currentName?: string }
): Promise<string | undefined> {
    const existingNames = groups.map((group) => group.name);
    const value = await vscode.window.showInputBox({
        title: `${options.title}（目标：${ctx.targetName}）`,
        prompt: options.prompt,
        placeHolder: options.placeHolder,
        value: options.currentName !== undefined ? options.currentName : '',
        valueSelection: options.currentName !== undefined
            ? [0, options.currentName.length]
            : undefined,
        validateInput: (input) => validateGroupName(input, existingNames, options.currentName)
    });
    if (value === undefined) {
        return undefined;
    }
    return value.trim();
}

function validateGroupName(
    raw: string,
    existingNames: string[],
    currentName?: string
): string | undefined {
    const name = raw.trim();
    if (name === '') {
        return '分组名不能为空';
    }
    if (INVALID_NAME_CHARACTERS.test(name) || containsControlCharacter(name)) {
        return '分组名不能包含 < > : " / \\ | ? * 等字符';
    }
    if (name === '.' || name === '..') {
        return '分组名不能为 "." 或 ".."';
    }
    if (name !== currentName && existingNames.indexOf(name) !== -1) {
        return `分组「${name}」已存在`;
    }
    return undefined;
}

interface NewFileResolution {
    absolutePath?: string;
    error?: string;
}

/** Validate the file name typed by the user and resolve it inside the project dir. */
function resolveNewFilePath(projectDir: string, rawName: string): NewFileResolution {
    const trimmed = rawName.trim();
    if (trimmed === '') {
        return { error: '文件名不能为空' };
    }
    if (path.isAbsolute(trimmed)) {
        return { error: '请输入工程目录内的相对路径' };
    }

    const segments = trimmed.replace(/[\\/]+/g, path.sep).split(path.sep);
    for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') {
            return { error: '文件名中不能包含 "." 或 ".." 路径段' };
        }
        if (INVALID_SEGMENT_CHARACTERS.test(segment) || containsControlCharacter(segment)) {
            return { error: '文件名不能包含 < > : " | ? * 等字符' };
        }
    }

    const absolutePath = path.resolve(projectDir, ...segments);
    if (!isInsideDirectory(projectDir, absolutePath)) {
        return { error: '文件名必须位于工程目录内' };
    }
    if (path.extname(absolutePath) === '') {
        return { error: '请提供带扩展名的文件名，例如 new_file.c' };
    }
    const parentDirectory = path.dirname(absolutePath);
    if (!fs.existsSync(parentDirectory)) {
        return { error: `目录不存在：${parentDirectory}` };
    }
    if (fs.existsSync(absolutePath)) {
        return { error: '该文件已存在，请换一个文件名' };
    }
    return { absolutePath };
}

function isInsideDirectory(directory: string, candidate: string): boolean {
    const relative = path.relative(path.normalize(directory), path.normalize(candidate));
    return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
    );
}

function buildFileEntry(projectDir: string, absolutePath: string): UvFileToAdd {
    return {
        filePath: toUvProjectPath(projectDir, absolutePath),
        fileName: path.basename(absolutePath),
        fileType: fileTypeForPath(absolutePath)
    };
}

function findFileEntry(
    projectDir: string,
    group: UvGroupEntry,
    absolutePath: string
): UvFileEntry | undefined {
    const key = comparableAbsolutePath(absolutePath);
    return group.files.find((file) => {
        const resolved = fromUvProjectPath(projectDir, file.filePath);
        return comparableAbsolutePath(resolved) === key;
    });
}

function comparableAbsolutePath(value: string): string {
    return path.normalize(value).replace(/[\\/]+/g, '/').toLowerCase();
}

async function openFileInEditor(absolutePath: string): Promise<void> {
    try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
        await vscode.window.showTextDocument(document, { preview: false });
    } catch {
        // Best effort only: the file is already created on disk.
    }
}

// ---------------------------------------------------------------------------
// New file templates
// ---------------------------------------------------------------------------

function buildNewFileContent(projectDir: string, absolutePath: string): string {
    const fileName = path.basename(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();
    const date = new Date().toISOString().slice(0, 10);

    switch (extension) {
        case '.c':
            return [
                '/**',
                ` * @file    ${fileName}`,
                ' * @brief   TODO: 描述该模块的功能',
                ` * @date    ${date}`,
                ' */',
                '',
                '/* TODO: 添加需要的头文件 */',
                `// #include "${path.basename(absolutePath, path.extname(absolutePath))}.h"`,
                '',
                '/* TODO: 实现 */',
                ''
            ].join('\n');
        case '.cpp':
        case '.cc':
        case '.cxx':
        case '.c++':
            return [
                '/**',
                ` * @file    ${fileName}`,
                ' * @brief   TODO: 描述该模块的功能',
                ` * @date    ${date}`,
                ' */',
                '',
                '/* TODO: 添加需要的头文件 */',
                '// #include <cstdint>',
                '',
                '/* TODO: 实现 */',
                ''
            ].join('\n');
        case '.h':
        case '.hpp':
        case '.hxx':
        case '.inc': {
            const guard = includeGuardFor(projectDir, absolutePath);
            return [
                '/**',
                ` * @file    ${fileName}`,
                ' * @brief   TODO: 描述该头文件的功能',
                ` * @date    ${date}`,
                ' */',
                '',
                `#ifndef ${guard}`,
                `#define ${guard}`,
                '',
                '/* TODO: 声明 */',
                '',
                `#endif /* ${guard} */`,
                ''
            ].join('\n');
        }
        case '.s':
            return [
                ';-------------------------------------------------------------------------------',
                `; File:     ${fileName}`,
                '; Brief:    TODO: 描述该汇编文件的功能',
                ';-------------------------------------------------------------------------------',
                '',
                '                AREA    |.text|, CODE, READONLY',
                '',
                '                END',
                ''
            ].join('\n');
        case '.a51':
            return [
                ';-------------------------------------------------------------------------------',
                `; File:     ${fileName}`,
                '; Brief:    TODO: 描述该汇编文件的功能',
                ';-------------------------------------------------------------------------------',
                '',
                '                NAME    MODULE_NAME',
                '',
                '                END',
                ''
            ].join('\n');
        default:
            return [
                ';-------------------------------------------------------------------------------',
                `; File:     ${fileName}`,
                `; Created:  ${date}`,
                ';-------------------------------------------------------------------------------',
                ''
            ].join('\n');
    }
}

function includeGuardFor(projectDir: string, absolutePath: string): string {
    const relative = path.relative(path.normalize(projectDir), path.normalize(absolutePath));
    const extension = path.extname(relative);
    const withoutExtension = extension === '' ? relative : relative.slice(0, -extension.length);
    const sanitized = withoutExtension
        .replace(/[\\/]+/g, '_')
        .replace(/[^A-Za-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+/, '')
        .toUpperCase();
    return `__${sanitized}_H__`;
}
