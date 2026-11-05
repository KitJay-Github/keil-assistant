/**
 * Host side of the "Options for Target" webview panel.
 *
 * One panel exists per Keil project (`prjID`). The class owns the
 * `vscode.WebviewPanel`, renders the generated assets from
 * `options/panelAssets.ts`, validates every incoming message through
 * `options/protocol.ts` and delegates all project I/O to an
 * {@link OptionsPanelHost} adapter supplied by the extension wiring
 * (`src/extension.ts`), which keeps this file free of project parsing details.
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { buildOptionsHtml } from './options/panelAssets';
import {
    HostToWebviewMessage,
    parseWebviewMessage,
    serializeHostMessage
} from './options/protocol';
import type { OptionApplyResultSummary, OptionsViewData } from './options/types';

export type { OptionApplyResultSummary } from './options/types';

/** MVP webview type id, also used as the panel key in VS Code's tab groups. */
const VIEW_TYPE = 'keilAssistant.options';
const PANEL_TITLE_PREFIX = 'Keil Options: ';

/**
 * Project services the panel needs. Implemented by the extension wiring; all
 * file access, schema knowledge and tree refreshing stays behind this boundary.
 */
export interface OptionsPanelHost {
    readonly prjID: string;
    readonly projectLabel: string;
    readonly projectFile: string;
    loadViewData(targetName?: string): Promise<OptionsViewData>;
    saveValues(targetName: string, values: Record<string, string>): Promise<OptionApplyResultSummary>;
    notify(kind: 'info' | 'warning' | 'error', message: string): void;
}

function createNonce(): string {
    return crypto.randomBytes(16).toString('base64');
}

function describeError(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return String(error);
}

/** One webview panel per project. */
export class OptionsPanel {
    private static readonly registry = new Map<string, OptionsPanel>();

    private host: OptionsPanelHost;
    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private targetName: string | undefined;
    private lastViewData: OptionsViewData | undefined;
    private disposed = false;

    private constructor(extensionUri: vscode.Uri, host: OptionsPanelHost, targetName?: string) {
        this.host = host;
        this.targetName = targetName;
        this.panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            `${PANEL_TITLE_PREFIX}${host.projectLabel}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );
        this.panel.webview.html = buildOptionsHtml({
            nonce: createNonce(),
            cspSource: this.panel.webview.cspSource
        });
        this.panel.onDidDispose(() => this.handleDisposed(), undefined, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            (message: unknown) => {
                void this.handleMessage(message).catch((error: unknown) => {
                    this.reportError(`处理工程选项面板消息失败：${describeError(error)}`);
                });
            },
            undefined,
            this.disposables
        );
    }

    /**
     * Show (or reveal) the options panel of one project.
     *
     * When a panel already exists for `host.prjID`, it is revealed, pointed at
     * the freshly supplied host adapter and reloaded instead of duplicated.
     */
    static show(extensionUri: vscode.Uri, host: OptionsPanelHost, targetName?: string): OptionsPanel {
        const existing = OptionsPanel.registry.get(host.prjID);
        if (existing) {
            existing.host = host;
            if (targetName !== undefined) {
                existing.targetName = targetName;
            }
            existing.panel.reveal(undefined, false);
            void existing.reload();
            return existing;
        }

        const created = new OptionsPanel(extensionUri, host, targetName);
        OptionsPanel.registry.set(host.prjID, created);
        return created;
    }

    /** Find the panel currently bound to a project, if any. */
    static find(prjID: string): OptionsPanel | undefined {
        return OptionsPanel.registry.get(prjID);
    }

    /** Dispose every open options panel (extension deactivation / reload). */
    static disposeAll(): void {
        for (const panel of Array.from(OptionsPanel.registry.values())) {
            panel.dispose();
        }
        OptionsPanel.registry.clear();
    }

    /** Reload the currently active target from disk and re-render the webview. */
    async reload(): Promise<void> {
        await this.refresh(this.targetName);
    }

    /** Close the panel and unregister it. Safe to call more than once. */
    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        OptionsPanel.unregister(this.host.prjID, this);
        this.disposeListeners();
        try {
            this.panel.dispose();
        } catch {
            // The webview panel can already be gone when VS Code shuts down.
        }
    }

    private static unregister(prjID: string, panel: OptionsPanel): void {
        if (OptionsPanel.registry.get(prjID) === panel) {
            OptionsPanel.registry.delete(prjID);
        }
    }

    private handleDisposed(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        OptionsPanel.unregister(this.host.prjID, this);
        this.disposeListeners();
    }

    private disposeListeners(): void {
        while (this.disposables.length > 0) {
            const disposable = this.disposables.pop();
            if (!disposable) {
                continue;
            }
            try {
                disposable.dispose();
            } catch {
                // Disposing an already disposed listener is harmless.
            }
        }
    }

    /** Post a message, but never after disposal (posting then throws "Webview is disposed"). */
    private post(message: HostToWebviewMessage): void {
        if (this.disposed) {
            return;
        }
        try {
            const posted = this.panel.webview.postMessage(serializeHostMessage(message));
            if (posted) {
                void posted.then(undefined, () => undefined);
            }
        } catch {
            // The panel may be torn down at any moment; a dropped update is fine.
        }
    }

    private reportError(message: string): void {
        this.post({ type: 'error', message });
        try {
            this.host.notify('error', message);
        } catch {
            // Notifications are best effort and must never break the panel.
        }
    }

    private async handleMessage(raw: unknown): Promise<void> {
        if (this.disposed) {
            return;
        }
        const message = parseWebviewMessage(raw);
        if (!message) {
            // Invalid messages are ignored instead of being forwarded.
            return;
        }

        switch (message.type) {
            case 'ready':
                await this.refresh(this.targetName);
                return;
            case 'save':
                await this.save(message.target, message.values);
                return;
            case 'reload':
                this.targetName = message.target;
                await this.refresh(message.target);
                return;
            case 'switchTarget':
                this.targetName = message.target;
                await this.refresh(message.target);
                return;
            case 'openFile':
                await this.openProjectFile(message.which);
                return;
        }
    }

    private async refresh(targetName?: string): Promise<void> {
        if (this.disposed) {
            return;
        }
        try {
            const data = await this.host.loadViewData(targetName);
            if (this.disposed) {
                return;
            }
            this.lastViewData = data;
            this.targetName = data.activeTarget || targetName;
            this.post({ type: 'init', data });
        } catch (error) {
            if (!this.disposed) {
                this.reportError(`加载工程选项失败：${describeError(error)}`);
            }
        }
    }

    private async save(target: string, values: Record<string, string>): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.targetName = target;
        this.post({ type: 'busy', value: true });
        try {
            const summary = await this.host.saveValues(target, values);
            if (this.disposed) {
                return;
            }
            this.post({
                type: 'saved',
                changed: summary.changed,
                warnings: summary.warnings
            });
        } catch (error) {
            if (!this.disposed) {
                this.reportError(`保存工程选项失败：${describeError(error)}`);
            }
        } finally {
            if (!this.disposed) {
                this.post({ type: 'busy', value: false });
            }
        }
    }

    private async openProjectFile(which: 'uvprojx' | 'uvopt'): Promise<void> {
        let filePath: string | undefined;
        if (which === 'uvopt') {
            filePath = this.lastViewData?.uvoptFile;
            if (!filePath) {
                const message = '当前工程没有找到 .uvopt/.uvoptx 选项文件。';
                this.post({ type: 'error', message });
                this.host.notify('warning', message);
                return;
            }
        } else {
            filePath = this.host.projectFile || this.lastViewData?.projectFile;
        }

        if (!filePath) {
            const message = '当前工程没有可打开的工程文件路径。';
            this.post({ type: 'error', message });
            this.host.notify('warning', message);
            return;
        }

        try {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
        } catch (error) {
            this.reportError(`打开工程文件失败：${describeError(error)}`);
        }
    }
}
