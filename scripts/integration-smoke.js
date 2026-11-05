/*
 * Integration smoke test for the extension wiring.
 *
 * Loads the compiled extension (`dist/src/extension.js`, or `dist/extension.js`
 * when KEIL_ENTRY is set) with a stubbed `vscode` module, drives the real command
 * handlers against temporary copies of the fixture projects and asserts the
 * resulting project files. It covers the pieces unit tests cannot: command
 * registration, tree item resolution, project writes, project refresh and the
 * Options webview host adapter.
 *
 * Usage:
 *   npx tsc -p ./                             # required: compiles dist/src
 *   node ./scripts/integration-smoke.js
 *   KEIL_ENTRY=dist/extension.js node ./scripts/integration-smoke.js  # webpack bundle
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const EXTENSION_ENTRY = process.env.KEIL_ENTRY || path.join(REPO, 'dist', 'src', 'extension.js');
const FIXTURES = path.join(REPO, 'src', 'test', 'fixtures');

/** Local Keil installation, when present, enables the driver/version enrichment checks. */
const KEIL_UV4_PATH = process.env.KEIL_UV4_PATH
    || (fs.existsSync('C:\\Keil_v5\\UV4\\UV4.exe') ? 'C:\\Keil_v5\\UV4\\UV4.exe' : '');
const HAS_KEIL_INSTALL = KEIL_UV4_PATH !== '' && fs.existsSync(KEIL_UV4_PATH);

const results = [];
function check(name, condition, detail) {
    results.push({ name, ok: !!condition, detail });
    if (!condition) {
        console.error('  FAIL ' + name + (detail ? ' :: ' + detail : ''));
    }
}

/* ------------------------------------------------------------------ */
/* Workspace preparation                                              */
/* ------------------------------------------------------------------ */

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'keil-e2e-'));
const storage = path.join(workspace, '.storage');
const projectDir = path.join(workspace, 'DemoProject');
fs.mkdirSync(projectDir, { recursive: true });
for (const name of ['arm-ac6.uvprojx', 'arm-ac6.uvoptx', 'arm-ac5.uvproj', 'arm-ac5.uvopt', 'c51.uvproj', 'c251.uvproj']) {
    fs.copyFileSync(path.join(FIXTURES, name), path.join(projectDir, name));
}
// Use the J-Link flavoured companion file so the adapter settings section is rendered.
fs.copyFileSync(path.join(FIXTURES, 'arm-ac6-jlink.uvoptx'), path.join(projectDir, 'arm-ac6.uvoptx'));
const sourceDir = path.join(projectDir, 'Application');
fs.mkdirSync(sourceDir, { recursive: true });
const newSourcePath = path.join(sourceDir, 'harness_added.c');
fs.writeFileSync(newSourcePath, 'int harness_added(void) { return 0; }\n', 'utf8');
const groupSourcePath = path.join(sourceDir, 'harness_group_file.c');
fs.writeFileSync(groupSourcePath, 'int harness_group_file(void) { return 0; }\n', 'utf8');

/* ------------------------------------------------------------------ */
/* vscode stub                                                        */
/* ------------------------------------------------------------------ */

const commandHandlers = new Map();
const postedMessages = [];
const notifications = [];
let treeDataProvider;
let lastWebviewPanel;
let webviewReceiveHandler;

const settings = {
    'KeilAssistant.Project.BackupBeforeWrite': true,
    'KeilAssistant.MDK.Uv4Path': KEIL_UV4_PATH,
    'KeilAssistant.C51.Uv4Path': KEIL_UV4_PATH
};

const ui = {
    quickPick: [],
    inputBox: [],
    openDialog: [],
    warningConfirm: 1,
    infoMessage: 1
};

function disposable() {
    return { dispose() { /* noop */ } };
}

function makeUri(fsPath) {
    return {
        scheme: 'file',
        fsPath,
        path: fsPath.replace(/\\/g, '/'),
        toString() { return 'file:///' + this.path; }
    };
}

class EventEmitter {
    constructor() {
        this.listeners = new Map();
        this.event = (listener) => {
            const list = this.listeners.get('event') || [];
            list.push(listener);
            this.listeners.set('event', list);
            return disposable();
        };
    }
    fire(payload) {
        for (const listener of this.listeners.get('event') || []) {
            listener(payload);
        }
    }
    dispose() { this.listeners.clear(); }
}

class TreeItem {
    constructor(label) {
        this.label = label;
        this.collapsibleState = 0;
    }
}

function createWebviewPanel(viewType, title) {
    const panel = {
        viewType,
        title,
        webview: {
            cspSource: 'vscode-resource:',
            html: '',
            onDidReceiveMessage(callback) {
                webviewReceiveHandler = callback;
                return disposable();
            },
            postMessage(message) {
                postedMessages.push(message);
                return Promise.resolve(true);
            },
            asWebviewUri(uri) { return uri; }
        },
        onDidDispose(callback) {
            panel._onDispose = callback;
            return disposable();
        },
        reveal() { /* noop */ },
        dispose() {
            if (panel._onDispose) panel._onDispose();
            if (lastWebviewPanel === panel) lastWebviewPanel = undefined;
        }
    };
    lastWebviewPanel = panel;
    return panel;
}

const vscodeStub = {
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1, One: 1 },
    TaskScope: { Workspace: 1, Global: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Range: class { constructor(startLine, startChar, endLine, endChar) { Object.assign(this, { startLine, startChar, endLine, endChar }); } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    ProcessExecution: class { constructor(process, args, options) { Object.assign(this, { process, args, options }); } },
    Task: class { constructor(definition, scope, name, source) { Object.assign(this, { definition, scope, name, source }); } },
    Uri: {
        file: makeUri,
        parse(value) { return makeUri(String(value).replace(/^file:\/\//, '').replace(/\//g, '\\')); }
    },
    env: {
        clipboard: { writeText() { return Promise.resolve(); } },
        remoteName: undefined,
        shell: 'powershell'
    },
    commands: {
        registerCommand(id, handler) {
            commandHandlers.set(id, handler);
            return disposable();
        },
        executeCommand() { return Promise.resolve(undefined); }
    },
    languages: {
        createDiagnosticCollection() {
            return { clear() { }, set() { }, delete() { }, dispose() { } };
        }
    },
    lm: undefined,
    tasks: {
        onDidEndTaskProcess() { return disposable(); },
        executeTask() { return Promise.resolve({}); }
    },
    window: {
        activeTextEditor: undefined,
        terminals: [],
        createTreeView(id, options) {
            treeDataProvider = options.treeDataProvider;
            return {
                onDidExpandElement() { return disposable(); },
                onDidCollapseElement() { return disposable(); },
                reveal() { return Promise.resolve(); },
                dispose() { }
            };
        },
        createStatusBarItem() {
            return { text: '', tooltip: '', command: '', show() { }, hide() { }, dispose() { } };
        },
        createWebviewPanel,
        createTerminal() {
            return { show() { }, sendText() { }, hide() { }, dispose() { } };
        },
        createOutputChannel() {
            return { appendLine() { }, append() { }, show() { }, dispose() { } };
        },
        onDidChangeActiveTextEditor() { return disposable(); },
        showInformationMessage(message, ...args) {
            notifications.push(['info', message]);
            const buttons = args.filter((item) => typeof item === 'string');
            return Promise.resolve(buttons[0]);
        },
        showWarningMessage(message, ...args) {
            notifications.push(['warning', message]);
            const buttons = args.filter((item) => typeof item === 'string');
            return Promise.resolve(ui.warningConfirm > 0 ? (buttons[0] || 'Remove') : undefined);
        },
        showErrorMessage(message) {
            notifications.push(['error', message]);
            return Promise.resolve(undefined);
        },
        showQuickPick(items) {
            const value = ui.quickPick.shift();
            if (value === undefined) return Promise.resolve(undefined);
            const list = Array.isArray(items) ? items : [];
            const found = list.find((item) => (typeof item === 'string' ? item : item.label) === value);
            return Promise.resolve(typeof found === 'string' ? value : found);
        },
        showInputBox() {
            return Promise.resolve(ui.inputBox.shift());
        },
        showOpenDialog() {
            const next = ui.openDialog.shift();
            return Promise.resolve(next === undefined ? undefined : next);
        },
        showTextDocument() { return Promise.resolve({}); }
    },
    workspace: {
        workspaceFolders: [{ uri: makeUri(workspace), name: 'ws', index: 0 }],
        workspaceFile: undefined,
        getConfiguration(section) {
            return {
                get(key, defaultValue) {
                    const full = section ? `${section}.${key}` : key;
                    if (Object.prototype.hasOwnProperty.call(settings, full)) return settings[full];
                    return defaultValue;
                },
                has() { return false; },
                update() { return Promise.resolve(); }
            };
        },
        async findFiles(include) {
            const all = fs.readdirSync(projectDir).map((name) => path.join(projectDir, name));
            if (include.indexOf('uvproj') !== -1) {
                return all.filter((file) => /\.uvprojx?$/i.test(file)).map(makeUri);
            }
            return [];
        },
        getWorkspaceFolder() { return { uri: makeUri(workspace), name: 'ws', index: 0 }; },
        asRelativePath(value) {
            const target = typeof value === 'string' ? value : value.fsPath;
            return path.relative(workspace, target).replace(/\\/g, '/');
        },
        fs: {
            readFile(uri) { return Promise.resolve(fs.readFileSync(uri.fsPath)); }
        },
        openTextDocument() { return Promise.resolve({}); }
    }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return vscodeStub;
    }
    return originalLoad.call(this, request, parent, isMain);
};

/* ------------------------------------------------------------------ */
/* Drive the extension                                                */
/* ------------------------------------------------------------------ */

function readProject(name) {
    return fs.readFileSync(path.join(projectDir, name), 'utf8');
}

async function waitFor(checkFn, timeoutMs = 5000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (checkFn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

/** Commands are registered as fire-and-forget (`void handler()`), so wait for the effect. */
async function waitUntil(label, checkFn, timeoutMs = 6000) {
    const ok = await waitFor(checkFn, timeoutMs);
    if (!ok) {
        console.error('[timeout] ' + label);
    }
    return ok;
}

function projectLabels() {
    return ((treeDataProvider && treeDataProvider.getChildren(undefined)) || []).map((item) => item.label);
}

async function findProjectItem(label) {
    await waitUntil('project item ' + label, () => projectLabels().indexOf(label) !== -1, 8000);
    return ((treeDataProvider.getChildren(undefined)) || []).find((item) => item.label === label);
}

async function findTargetItem(projectLabel) {
    const project = await findProjectItem(projectLabel);
    if (!project) return { project: undefined, target: undefined };
    await waitUntil('target of ' + projectLabel, () => ((treeDataProvider.getChildren(project)) || []).length > 0);
    return { project, target: (treeDataProvider.getChildren(project) || [])[0] };
}

async function findGroupItem(projectLabel, groupLabel) {
    const { project, target } = await findTargetItem(projectLabel);
    if (!target) return { project, target, group: undefined, groups: [] };
    await waitUntil('groups of ' + projectLabel, () => ((treeDataProvider.getChildren(target)) || []).length > 0);
    const groups = treeDataProvider.getChildren(target) || [];
    return { project, target, groups, group: groups.find((item) => item.label === groupLabel) };
}

async function findSourceItem(projectLabel, fileLabel) {
    const { project, target } = await findTargetItem(projectLabel);
    if (!target) return { project, target, group: undefined, source: undefined };
    const groups = treeDataProvider.getChildren(target) || [];
    for (const group of groups) {
        const sources = treeDataProvider.getChildren(group) || [];
        const source = sources.find((item) => item.label === fileLabel);
        if (source) return { project, target, group, source };
    }
    return { project, target, group: undefined, source: undefined };
}

async function main() {
    const extension = require(EXTENSION_ENTRY);
    check('extension module exports activate', typeof extension.activate === 'function');

    const extensionContext = {
        subscriptions: [],
        extensionPath: REPO,
        extensionUri: makeUri(REPO),
        globalStorageUri: makeUri(storage),
        workspaceState: {
            get(key, defaultValue) { return this._data && Object.prototype.hasOwnProperty.call(this._data, key) ? this._data[key] : defaultValue; },
            update(key, value) { this._data = this._data || {}; this._data[key] = value; return Promise.resolve(); },
            _data: {}
        }
    };
    fs.mkdirSync(storage, { recursive: true });

    extension.activate(extensionContext);
    const loaded = await waitFor(() => treeDataProvider && (treeDataProvider.getChildren(undefined) || []).length >= 2);
    check('projects loaded into the tree', loaded);

    const projects = treeDataProvider.getChildren(undefined) || [];
    const projectNames = projects.map((item) => item.label);
    check('both fixture projects visible', projectNames.length >= 2, JSON.stringify(projectNames));

    // 11 new commands must be registered.
    const expectedCommands = [
        'project.options', 'project.addFilesToGroup', 'project.newFile', 'project.removeFile',
        'project.addGroup', 'project.renameGroup', 'project.removeGroup', 'project.moveFileToGroup',
        'project.toggleFileInBuild', 'project.toggleGroupInBuild'
    ];
    for (const id of expectedCommands) {
        check('command registered: ' + id, commandHandlers.has(id));
    }

    const uvGroups = require(path.join(REPO, 'dist', 'src', 'project', 'uvGroups.js'));
    const readGroups = (name) => uvGroups.readTargetGroups(readProject(name), 'Demo_Debug');

    const armProject = await findProjectItem('arm-ac6');
    check('arm-ac6 project present', !!armProject);
    const target = (await findTargetItem('arm-ac6')).target;
    check('target resolved', !!target, target && target.label);

    /* --- addGroup --- */
    ui.inputBox.push('HarnessGroup');
    await commandHandlers.get('project.addGroup')(armProject);
    await waitUntil('addGroup written', () => readGroups('arm-ac6.uvprojx').some((group) => group.name === 'HarnessGroup'));
    let groupState = readGroups('arm-ac6.uvprojx');
    check('addGroup wrote the group', groupState.some((group) => group.name === 'HarnessGroup'));
    check('addGroup kept existing groups', groupState.length === 5, 'groups=' + groupState.length);
    check('addGroup produced a backup', fs.existsSync(path.join(storage, armProject.prjID, 'backups')) &&
        fs.readdirSync(path.join(storage, armProject.prjID, 'backups')).length > 0);

    /* --- addFilesToGroup --- */
    let harnessGroup = (await findGroupItem('arm-ac6', 'HarnessGroup')).group;
    check('new group visible in tree', !!harnessGroup);
    ui.openDialog.push([makeUri(newSourcePath)]);
    await commandHandlers.get('project.addFilesToGroup')(harnessGroup);
    await waitUntil('addFiles written', () => {
        const state = readGroups('arm-ac6.uvprojx');
        const group = state.find((item) => item.name === 'HarnessGroup');
        return !!group && group.files.some((file) => file.fileName === 'harness_added.c');
    });
    groupState = readGroups('arm-ac6.uvprojx');
    const addedGroup = groupState.find((group) => group.name === 'HarnessGroup');
    const addedFile = addedGroup && addedGroup.files.find((file) => file.fileName === 'harness_added.c');
    check('addFilesToGroup added the file', !!addedFile);
    check('addFilesToGroup used a project relative path',
        !!addedFile && /^\.\\Application\\harness_added\.c$/i.test(addedFile.filePath),
        addedFile && addedFile.filePath);

    /* --- renameGroup --- */
    harnessGroup = (await findGroupItem('arm-ac6', 'HarnessGroup')).group;
    ui.inputBox.push('HarnessGroupRenamed');
    await commandHandlers.get('project.renameGroup')(harnessGroup);
    await waitUntil('renameGroup written', () => readGroups('arm-ac6.uvprojx').some((group) => group.name === 'HarnessGroupRenamed'));
    groupState = readGroups('arm-ac6.uvprojx');
    check('renameGroup applied', groupState.some((group) => group.name === 'HarnessGroupRenamed'));
    check('renameGroup removed the old name', !groupState.some((group) => group.name === 'HarnessGroup'));
    const renamedGroup = (await findGroupItem('arm-ac6', 'HarnessGroupRenamed')).group;
    check('renamed group visible', !!renamedGroup);

    /* --- toggleFileInBuild --- */
    const harnessSource = (await findSourceItem('arm-ac6', 'harness_added.c')).source;
    check('added file visible in tree', !!harnessSource);
    await commandHandlers.get('project.toggleFileInBuild')(harnessSource);
    await waitUntil('toggle written', () => {
        const group = readGroups('arm-ac6.uvprojx').find((item) => item.name === 'HarnessGroupRenamed');
        const file = group && group.files.find((entry) => entry.fileName === 'harness_added.c');
        return !!file && file.includeInBuild === false;
    });
    const toggledFileState = readGroups('arm-ac6.uvprojx')
        .find((group) => group.name === 'HarnessGroupRenamed').files.find((file) => file.fileName === 'harness_added.c');
    check('toggleFileInBuild excluded the file', toggledFileState.includeInBuild === false);

    /* --- moveFileToGroup --- */
    ui.quickPick.push('Drivers');
    const sourceToMove = (await findSourceItem('arm-ac6', 'harness_added.c')).source;
    check('source to move located', !!sourceToMove);
    await commandHandlers.get('project.moveFileToGroup')(sourceToMove);
    await waitUntil('move written', () => {
        const state = readGroups('arm-ac6.uvprojx');
        const destination = state.find((group) => group.name === 'Drivers');
        const origin = state.find((group) => group.name === 'HarnessGroupRenamed');
        return !!destination && !!origin &&
            destination.files.some((file) => file.fileName === 'harness_added.c') &&
            !origin.files.some((file) => file.fileName === 'harness_added.c');
    });
    groupState = readGroups('arm-ac6.uvprojx');
    check('moveFileToGroup moved the file',
        groupState.find((group) => group.name === 'Drivers').files.some((file) => file.fileName === 'harness_added.c'));
    check('moveFileToGroup removed it from the source group',
        !groupState.find((group) => group.name === 'HarnessGroupRenamed').files.some((file) => file.fileName === 'harness_added.c'));

    /* --- removeFile from project --- */
    const movedSource = (await findSourceItem('arm-ac6', 'harness_added.c')).source;
    check('moved file node located', !!movedSource);
    ui.warningConfirm = 1;
    await commandHandlers.get('project.removeFile')(movedSource);
    await waitUntil('removeFile written', () =>
        !readGroups('arm-ac6.uvprojx').some((group) => group.files.some((file) => file.fileName === 'harness_added.c')));
    check('removeFile removed the file',
        !readGroups('arm-ac6.uvprojx').some((group) => group.files.some((file) => file.fileName === 'harness_added.c')));

    /* --- removeGroup --- */
    const groupToRemove = (await findGroupItem('arm-ac6', 'HarnessGroupRenamed')).group;
    check('group to remove located', !!groupToRemove);
    await commandHandlers.get('project.removeGroup')(groupToRemove);
    await waitUntil('removeGroup written', () => !readGroups('arm-ac6.uvprojx').some((group) => group.name === 'HarnessGroupRenamed'));
    groupState = readGroups('arm-ac6.uvprojx');
    check('removeGroup removed the group', !groupState.some((group) => group.name === 'HarnessGroupRenamed'));
    check('project still valid after group removal', groupState.length === 4, 'groups=' + groupState.length);
    check('other targets untouched', uvGroups.readTargetGroups(readProject('arm-ac6.uvprojx'), 'Demo_Release').length === 4);

    /* --- Options panel --- */
    const armProject7 = await findProjectItem('arm-ac6');
    await commandHandlers.get('project.options')(armProject7);
    await waitUntil('panel created', () => !!lastWebviewPanel);
    check('options panel created', !!lastWebviewPanel);
    check('panel title mentions project', !!lastWebviewPanel && lastWebviewPanel.title.indexOf('arm-ac6') !== -1, lastWebviewPanel && lastWebviewPanel.title);
    check('webview html set', !!lastWebviewPanel && lastWebviewPanel.webview.html.length > 1000);
    check('webview receive handler registered', typeof webviewReceiveHandler === 'function');

    postedMessages.length = 0;
    webviewReceiveHandler({ type: 'ready' });
    await waitUntil('init posted', () => postedMessages.some((message) => message && message.type === 'init'));
    const initMessage = postedMessages.find((message) => message && message.type === 'init');
    check('panel posted init on ready', !!initMessage);
    if (initMessage) {
        check('init data has 7 tabs', initMessage.data.tabs.length === 7, String(initMessage.data.tabs.length));
        check('init data has targets', initMessage.data.targets.length === 2, JSON.stringify(initMessage.data.targets));
        check('init data is writable', initMessage.data.readonly === false);
        check('init data exposes uvoptFile', !!initMessage.data.uvoptFile, initMessage.data.uvoptFile);
        check('init data toolchain label', !!initMessage.data.toolchain, initMessage.data.toolchain);

        /* --- generated read-only information sections --- */
        const targetTab = initMessage.data.tabs.find((tab) => tab.id === 'target');
        const mcuSection = targetTab && targetTab.sections.find((section) => section.id === 'target.mcu');
        check('MCU info section rendered', !!mcuSection);
        if (mcuSection) {
            const mcuField = (id) => mcuSection.fields.find((field) => field.id === id);
            check('MCU rows are info type', mcuSection.fields.every((field) => field.type === 'info'));
            check('MCU device shown', (mcuField('mcu.device') || {}).value === 'STM32F407VGTx', (mcuField('mcu.device') || {}).value);
            check('MCU core shown', /Cortex-M4/.test((mcuField('mcu.core') || {}).value || ''), (mcuField('mcu.core') || {}).value);
            check('MCU flash shown', /1 MB/.test((mcuField('mcu.flash') || {}).value || ''), (mcuField('mcu.flash') || {}).value);
            check('MCU ram shown', /128 KB/.test((mcuField('mcu.ram') || {}).value || ''), (mcuField('mcu.ram') || {}).value);
        }

        const utilitiesTab = initMessage.data.tabs.find((tab) => tab.id === 'utilities');
        const flashSection = utilitiesTab && utilitiesTab.sections.find((section) => section.id === 'utilities.flash');
        const driverField = flashSection && flashSection.fields.find((field) => field.id === 'utilities.driverSelection');
        check('driver selection is an enum', !!driverField && driverField.type === 'enum');
        check(
            'driver list is complete',
            !!driverField && Array.isArray(driverField.options) && driverField.options.length > 2,
            driverField && driverField.options && String(driverField.options.length)
        );
        const driverMeaning = flashSection && flashSection.fields.find((field) => field.id === 'info.utilities.driverSelection');
        check('driver selection meaning shown', !!driverMeaning && /4096/.test(driverMeaning.value || ''), driverMeaning && driverMeaning.value);

        const debugTab = initMessage.data.tabs.find((tab) => tab.id === 'debug');
        const hardwareSection = debugTab && debugTab.sections.find((section) => section.id === 'debug.hardware');
        check('debugger info section rendered', !!hardwareSection);
        if (hardwareSection) {
            const infoField = (id) => hardwareSection.fields.find((field) => field.id === id);
            check('debugger info rows are info type', hardwareSection.fields.every((field) => field.type === 'info'));
            check('debugger name resolved', /CMSIS-DAP/.test((infoField('info.debugger.name') || {}).value || ''), (infoField('info.debugger.name') || {}).value);
        }

        if (HAS_KEIL_INSTALL) {
            check(
                'driver list uses the local TOOLS.INI',
                !!driverField && Array.isArray(driverField.options)
                    && driverField.options.some((option) => /ULINK2\/ME Cortex Debugger/.test(option.label || '')),
                driverField && JSON.stringify((driverField.options || []).slice(0, 3))
            );
            check(
                'debugger version read from the driver DLL',
                /^\d+\.\d+/.test(((hardwareSection && hardwareSection.fields.find((field) => field.id === 'info.debugger.version')) || {}).value || ''),
                hardwareSection && JSON.stringify(hardwareSection.fields.map((field) => [field.id, field.value]))
            );
            check(
                'uVision version shown',
                /^\d+\.\d+/.test(((hardwareSection && hardwareSection.fields.find((field) => field.id === 'info.debugger.uvision')) || {}).value || '')
            );
        }
    }

    /* --- generated pickers: device catalog + debugger adapter --- */
    const pickerField = (data, id) => {
        for (const tab of data.tabs || []) {
            for (const section of tab.sections || []) {
                const found = (section.fields || []).find((entry) => entry.id === id);
                if (found) return found;
            }
        }
        return undefined;
    };
    const firstDeviceField = initMessage ? pickerField(initMessage.data, 'target.deviceSelect') : undefined;
    check('device picker rendered', !!firstDeviceField);
    check(
        'device picker explains the pack scan',
        !!firstDeviceField
            && (/正在扫描/.test(firstDeviceField.hint || '')
                || (firstDeviceField.options || []).length > 1
                || (initMessage.data.warnings || []).some((warning) => /CMSIS-Pack/.test(warning))),
        firstDeviceField && firstDeviceField.hint
    );
    const firstDebuggerField = initMessage ? pickerField(initMessage.data, 'debug.debugger') : undefined;
    check('debugger picker rendered', !!firstDebuggerField);
    check(
        'debugger picker lists the local drivers',
        !!firstDebuggerField && (firstDebuggerField.options || []).length >= 13,
        firstDebuggerField && String((firstDebuggerField.options || []).length)
    );
    check(
        'debugger picker marks the current driver',
        !!firstDebuggerField && /ULINK2\/ME Cortex Debugger/.test(firstDebuggerField.hint || '')
            || (firstDebuggerField && (firstDebuggerField.options || []).some((option) => option.value === firstDebuggerField.value)),
        firstDebuggerField && firstDebuggerField.hint
    );

    // The CMSIS-Pack scan runs in the background and reloads the panel when done.
    postedMessages.length = 0;
    await waitUntil(
        'device catalog loaded',
        () => postedMessages.some((message) => {
            if (!message || message.type !== 'init') return false;
            const field = pickerField(message.data, 'target.deviceSelect');
            return !!field && Array.isArray(field.options) && field.options.length > 1000;
        }),
        60000
    );
    const catalogInit = postedMessages
        .filter((message) => message && message.type === 'init')
        .map((message) => message.data)
        .find((data) => {
            const field = pickerField(data, 'target.deviceSelect');
            return !!field && Array.isArray(field.options) && field.options.length > 1000;
        });
    check('device catalog scan completed', !!catalogInit);
    if (catalogInit) {
        const deviceField = pickerField(catalogInit, 'target.deviceSelect');
        check('device picker exposes many devices', deviceField.options.length > 1000, String(deviceField.options.length));
        check('device picker includes STM32F103CB', deviceField.options.some((option) => option.value === 'STM32F103CB'));
        check('device catalog hint shows pack count', /Pack/.test(deviceField.hint || ''), deviceField.hint);
    }

    // Change the device and the debugger through the generated pickers.
    postedMessages.length = 0;
    webviewReceiveHandler({
        type: 'save',
        target: 'Demo_Debug',
        values: { 'target.deviceSelect': 'STM32F103CB', 'debug.debugger': '4' }
    });
    await waitUntil('picker save posted', () => postedMessages.some((message) => message && message.type === 'saved'), 20000);
    const pickerSaved = postedMessages.find((message) => message && message.type === 'saved');
    check('picker save finished', !!pickerSaved, JSON.stringify((pickerSaved && pickerSaved.changed) || []));
    const projectAfterPicker = readProject('arm-ac6.uvprojx');
    check('device written to .uvprojx', projectAfterPicker.indexOf('<Device>STM32F103CB</Device>') !== -1);
    check('vendor written to .uvprojx', projectAfterPicker.indexOf('<Vendor>STMicroelectronics</Vendor>') !== -1);
    check('cpu rebuilt from the pack', /CPUTYPE\("Cortex-M3"\)/.test(projectAfterPicker), (projectAfterPicker.match(/<Cpu>[^<]*<\/Cpu>/) || [])[0]);
    const uvoptAfterPicker = readProject('arm-ac6.uvoptx');
    check('debugger nTsel written', uvoptAfterPicker.indexOf('<nTsel>4</nTsel>') !== -1);
    check(
        'debugger pMon written',
        /<pMon>[^<]*JL2CM3[^<]*<\/pMon>/i.test(uvoptAfterPicker),
        (uvoptAfterPicker.match(/<pMon>[^<]*<\/pMon>/) || [])[0]
    );
    check('debugger mode set to target', uvoptAfterPicker.indexOf('<uSim>0</uSim>') !== -1 && uvoptAfterPicker.indexOf('<uTrg>1</uTrg>') !== -1);

    /* --- J-Link adapter settings (target driver registry) --- */
    const jlinkSection = initMessage
        ? (initMessage.data.tabs.find((tab) => tab.id === 'debug') || { sections: [] }).sections
            .find((section) => section.id === 'debug.jlink')
        : undefined;
    check('J-Link adapter section rendered', !!jlinkSection);
    check(
        'J-Link section has all fields',
        !!jlinkSection && jlinkSection.fields.length === 8,
        jlinkSection && String(jlinkSection.fields.length)
    );
    if (jlinkSection) {
        const byId = (id) => jlinkSection.fields.find((field) => field.id === id);
        check('J-Link port read', (byId('jlink.port') || {}).value === 'sw', (byId('jlink.port') || {}).value);
        check('J-Link speed read', (byId('jlink.maxClock') || {}).value === '10000', (byId('jlink.maxClock') || {}).value);
        check('J-Link reset-after read', (byId('jlink.resetAfter') || {}).value === '1');
    }

    postedMessages.length = 0;
    const uvoptBeforeJlink = readProject('arm-ac6.uvoptx');
    webviewReceiveHandler({
        type: 'save',
        target: 'Demo_Debug',
        values: {
            'jlink.port': 'jtag',
            'jlink.maxClock': '5000',
            'jlink.connect': 'under-reset',
            'jlink.reset': 'connect-under-reset',
            'jlink.interface': 'tcp',
            'jlink.ip': '192.168.1.20',
            'jlink.tcpPort': '19020'
        }
    });
    await waitUntil('jlink save posted', () => postedMessages.some((message) => message && message.type === 'saved'), 15000);
    const uvoptAfterJlink = readProject('arm-ac6.uvoptx');
    check('J-Link save changed the file', uvoptAfterJlink !== uvoptBeforeJlink);
    check('J-Link port written', /-O14\b/.test(uvoptAfterJlink), (uvoptAfterJlink.match(/-O\d+/) || [])[0]);
    check('J-Link speed written', /-S2\b/.test(uvoptAfterJlink) && /-ZTIFSpeedSel5000\b/.test(uvoptAfterJlink));
    check('J-Link connect written', /-C2\b/.test(uvoptAfterJlink));
    check('J-Link reset written', /-RST3\b/.test(uvoptAfterJlink));
    check('J-Link interface written', /-JU0\b/.test(uvoptAfterJlink) && /-JI192\.168\.1\.20\b/.test(uvoptAfterJlink) && /-JP19020\b/.test(uvoptAfterJlink));
    check('J-Link save keeps the flash settings', /-FF0STM32F10x_128\.FLM/.test(uvoptAfterJlink));

    postedMessages.length = 0;
    const beforeSave = readProject('arm-ac6.uvprojx');
    webviewReceiveHandler({
        type: 'save',
        target: 'Demo_Debug',
        values: { 'output.outputName': 'HarnessOut', 'ccpp.define': 'HARNESS=1' }
    });
    await waitUntil('saved posted', () => postedMessages.some((message) => message && message.type === 'saved'), 8000);
    const savedMessage = postedMessages.find((message) => message && message.type === 'saved');
    check('panel posted saved', !!savedMessage, JSON.stringify(postedMessages.map((message) => message && message.type)));
    const afterSave = readProject('arm-ac6.uvprojx');
    check('outputName written', afterSave.indexOf('<OutputName>HarnessOut</OutputName>') !== -1);
    check('define written', afterSave.indexOf('HARNESS=1') !== -1);
    check('only the Demo_Debug target changed', afterSave !== beforeSave &&
        afterSave.indexOf('<OutputName>Demo</OutputName>') !== -1);
    check('save produced a backup', fs.readdirSync(path.join(storage, armProject7.prjID, 'backups')).length >= 2);

    // uvopt field save
    postedMessages.length = 0;
    webviewReceiveHandler({
        type: 'save',
        target: 'Demo_Debug',
        values: { 'target.xtal': '24000000' }
    });
    await waitUntil('uvopt save posted', () => postedMessages.some((message) => message && message.type === 'saved'), 8000);
    const uvoptText = readProject('arm-ac6.uvoptx');
    check('xtal written to .uvoptx', uvoptText.indexOf('<CLKADS>24000000</CLKADS>') !== -1);

    // Invalid message must be ignored without crashing.
    postedMessages.length = 0;
    webviewReceiveHandler({ type: 'bogus' });
    webviewReceiveHandler(null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    check('invalid webview messages ignored', postedMessages.length === 0);

    // switching target reloads the panel
    postedMessages.length = 0;
    webviewReceiveHandler({ type: 'switchTarget', target: 'Demo_Release' });
    await waitUntil('switch target init', () => postedMessages.some((message) => message && message.type === 'init'));
    const switched = postedMessages.find((message) => message && message.type === 'init');
    check('switchTarget reloaded data', !!switched && switched.data.activeTarget === 'Demo_Release');

    /* --- summary --- */
    const failed = results.filter((result) => !result.ok);
    console.log(`\nintegration checks: ${results.length - failed.length}/${results.length} passed`);
    if (notifications.some((entry) => entry[0] === 'error')) {
        console.log('error notifications: ' + JSON.stringify(notifications.filter((entry) => entry[0] === 'error')));
    }
    if (failed.length) {
        console.log('failures:\n' + failed.map((result) => '  - ' + result.name + (result.detail ? ' :: ' + result.detail : '')).join('\n'));
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error('harness crashed: ' + (error && error.stack ? error.stack : error));
    process.exitCode = 1;
}).finally(() => {
    Module._load = originalLoad;
    // FileWatcher instances keep the event loop alive; clean up and exit in the
    // same tick so no watcher callback runs against the removed workspace.
    try {
        fs.rmSync(workspace, { recursive: true, force: true });
    } catch {
        // Best effort cleanup.
    }
    process.exit(process.exitCode || 0);
});
