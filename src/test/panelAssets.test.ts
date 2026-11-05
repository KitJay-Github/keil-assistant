import { strict as assert } from 'assert';
import { buildOptionsHtml } from '../project/options/panelAssets';

const NONCE = 'noncePANEL1234567890abcd';
const CSP_SOURCE = 'https://*.vscode-cdn.net';
const HTML = buildOptionsHtml({ nonce: NONCE, cspSource: CSP_SOURCE });

describe('panelAssets.buildOptionsHtml', () => {
    it('returns a complete standalone HTML document', () => {
        assert.ok(HTML.startsWith('<!DOCTYPE html>'));
        assert.ok(HTML.includes('<html lang="zh-CN">'));
        assert.ok(HTML.includes('</html>'));
        assert.ok(HTML.includes('<meta charset="UTF-8"'));
        // Everything is inlined: no external stylesheets/resources are referenced.
        assert.equal(HTML.includes('<link'), false);
    });

    it('embeds the strict nonce based Content-Security-Policy', () => {
        const expectedCsp = "default-src 'none'; img-src " + CSP_SOURCE + " data:; style-src 'nonce-" + NONCE +
            "'; script-src 'nonce-" + NONCE + "'; font-src " + CSP_SOURCE + ";";
        assert.ok(HTML.includes(`content="${expectedCsp}"`), 'CSP meta tag must match the contract exactly');
        assert.ok(HTML.includes("default-src 'none'"));
        assert.ok(HTML.includes(`img-src ${CSP_SOURCE} data:`));
        assert.ok(HTML.includes(`style-src 'nonce-${NONCE}'`));
        assert.ok(HTML.includes(`script-src 'nonce-${NONCE}'`));
        assert.ok(HTML.includes(`font-src ${CSP_SOURCE}`));
        assert.equal(HTML.includes("'unsafe-inline'"), false, 'styles must use the nonce, not unsafe-inline');
        assert.equal(HTML.includes("'unsafe-eval'"), false);
    });

    it('tags the inline style and script blocks with the nonce', () => {
        assert.ok(HTML.includes(`<style nonce="${NONCE}">`));
        assert.ok(HTML.includes(`<script nonce="${NONCE}">`));
        assert.ok(HTML.includes('</script>'));
    });

    it('renders the toolbar, tab rail, panels and status bar skeleton', () => {
        const requiredIds = [
            'id="toolbar"',
            'id="project-label"',
            'id="target-select"',
            'id="save"',
            'id="reload"',
            'id="open-file"',
            'id="dirty"',
            'id="tabs"',
            'id="panels"',
            'id="status"'
        ];
        for (const requiredId of requiredIds) {
            assert.ok(HTML.includes(requiredId), `missing element ${requiredId}`);
        }
        // The save button starts disabled until there are dirty fields.
        assert.ok(HTML.includes('id="save" class="btn" disabled'));
        assert.ok(HTML.includes('role="tablist"'));
    });

    it('creates the panels before the tab rail selects the first tab', () => {
        const panelsCall = HTML.indexOf('renderPanels(data);');
        const tabsCall = HTML.indexOf('renderTabs(data);');
        assert.ok(panelsCall > 0, 'renderPanels(data) call is missing');
        assert.ok(tabsCall > 0, 'renderTabs(data) call is missing');
        assert.ok(
            panelsCall < tabsCall,
            'panels must be in the DOM before selectTab() marks one active, otherwise the content pane stays blank'
        );
    });

    it('never uses inline event handler attributes or dynamic code evaluation', () => {
        const forbiddenAttributes = [
            'onclick=',
            'onchange=',
            'oninput=',
            'onsubmit=',
            'ondblclick=',
            'onkeydown=',
            'onkeyup=',
            'onfocus=',
            'onblur=',
            'onload='
        ];
        for (const forbidden of forbiddenAttributes) {
            assert.equal(HTML.includes(forbidden), false, `inline handler ${forbidden} is not allowed`);
        }
        assert.equal(HTML.includes('eval('), false, 'eval is not allowed');
        assert.equal(HTML.includes('new Function('), false);
        // All events are wired through addEventListener.
        assert.ok(HTML.includes('addEventListener'));
    });

    it('contains a rendering branch for every option value type', () => {
        assert.ok(HTML.includes("case 'multiline':"));
        assert.ok(HTML.includes("case 'bool':"));
        assert.ok(HTML.includes("case 'number':"));
        assert.ok(HTML.includes("case 'enum':"));
        assert.ok(HTML.includes("case 'string':"));
        assert.ok(HTML.includes("createElement('textarea')"), 'multiline fields must render a textarea');
        assert.ok(HTML.includes("createElement('select')"), 'enum fields must render a select');
        assert.ok(HTML.includes("control.type = 'checkbox'"), 'bool fields must render a checkbox');
        assert.ok(HTML.includes("control.type = 'number'"), 'number fields must render a number input');
        assert.ok(HTML.includes("control.type = 'text'"), 'string fields must render a text input');
    });

    it('contains the webview side of the message protocol', () => {
        assert.ok(HTML.includes('acquireVsCodeApi'));
        assert.ok(HTML.includes("post({ type: 'ready' })"));
        assert.ok(HTML.includes("type: 'save'"));
        assert.ok(HTML.includes("type: 'reload'"));
        assert.ok(HTML.includes("type: 'switchTarget'"));
        assert.ok(HTML.includes("type: 'openFile'"));
        assert.ok(HTML.includes("which: 'uvprojx'"));
        assert.ok(HTML.includes("which: 'uvopt'"));
        assert.ok(HTML.includes("case 'init':"));
        assert.ok(HTML.includes("case 'saved':"));
        assert.ok(HTML.includes("case 'error':"));
        assert.ok(HTML.includes("case 'busy':"));
    });

    it('handles dirty tracking, readonly and unavailable fields', () => {
        assert.ok(HTML.includes('state.dirty'));
        assert.ok(HTML.includes('collectDirtyValues'));
        assert.ok(HTML.includes('refreshDirtyUi'));
        assert.ok(HTML.includes('field.unavailable'));
        assert.ok(HTML.includes('field.unavailableReason'));
        assert.ok(HTML.includes('isReadonly'));
    });

    it('styles everything with VS Code theme variables', () => {
        const themeVariables = [
            '--vscode-editor-background',
            '--vscode-foreground',
            '--vscode-button-background',
            '--vscode-button-foreground',
            '--vscode-input-background',
            '--vscode-input-foreground',
            '--vscode-panel-border',
            '--vscode-list-activeSelectionBackground',
            '--vscode-list-activeSelectionForeground',
            '--vscode-focusBorder',
            '--vscode-descriptionForeground',
            '--vscode-editorWarning-foreground',
            '--vscode-errorForeground'
        ];
        for (const themeVariable of themeVariables) {
            assert.ok(HTML.includes(themeVariable), `missing theme variable ${themeVariable}`);
        }
        assert.ok(HTML.includes(':focus-visible'), 'keyboard focus must stay visible');
    });

    it('escapes the nonce and CSP source when embedding them in attributes', () => {
        const escaped = buildOptionsHtml({ nonce: 'a"b<c&d', cspSource: 'x"y<z&w' });
        assert.ok(escaped.includes('&quot;'));
        assert.ok(escaped.includes('&lt;'));
        assert.ok(escaped.includes('&amp;'));
        assert.equal(escaped.includes('"a"b<c&d'), false);
    });
});
