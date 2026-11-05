/**
 * Assets for the "Options for Target" webview panel.
 *
 * Everything (HTML, CSS and the webview script) is generated from this module
 * so the panel does not depend on `res/` files and can be unit tested without a
 * VS Code runtime. The generated page:
 *
 * - runs under a strict nonce based Content-Security-Policy,
 * - uses only VS Code theme variables for colors,
 * - never uses inline event handler attributes nor `eval`,
 * - renders the fields of `OptionsViewData` by their declared `type`.
 *
 * This file must not import `vscode`: `buildOptionsHtml` is a pure function.
 */

const OPTIONS_STYLE = `
:root {
    --kl-border: var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
    --kl-input-border: var(--vscode-input-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));
    --kl-hover: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.15));
}

* {
    box-sizing: border-box;
}

html,
body {
    height: 100%;
}

body {
    margin: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    color: var(--vscode-foreground);
    background-color: var(--vscode-editor-background);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
}

[hidden] {
    display: none !important;
}

#toolbar {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--kl-border);
    background-color: var(--vscode-editor-background);
}

.toolbar-project {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    max-width: 45%;
}

.project-label {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 320px;
}

.toolchain {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    white-space: nowrap;
}

.toolbar-field {
    display: flex;
    align-items: center;
    gap: 6px;
}

.toolbar-label {
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
    white-space: nowrap;
}

.toolbar-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: auto;
}

#dirty {
    display: none;
    color: var(--vscode-editorWarning-foreground);
    font-size: 0.92em;
    white-space: nowrap;
}

#dirty.visible {
    display: inline;
}

button {
    font-family: inherit;
    font-size: inherit;
}

button.btn {
    color: var(--vscode-button-foreground);
    background-color: var(--vscode-button-background);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    padding: 4px 12px;
    cursor: pointer;
    white-space: nowrap;
}

button.btn:hover {
    background-color: var(--vscode-button-hoverBackground);
}

button.btn.secondary {
    color: var(--vscode-button-secondaryForeground);
    background-color: var(--vscode-button-secondaryBackground);
}

button.btn.secondary:hover {
    background-color: var(--vscode-button-secondaryHoverBackground);
}

button.btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
}

button.btn:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
}

#banner {
    display: none;
    flex: 0 0 auto;
    padding: 6px 12px;
    border-bottom: 1px solid var(--kl-border);
    font-size: 0.92em;
    white-space: pre-wrap;
    word-break: break-word;
}

#banner.visible {
    display: block;
}

#banner.warn {
    color: var(--vscode-editorWarning-foreground);
    background-color: var(--vscode-inputValidation-warningBackground, transparent);
}

#banner.error {
    color: var(--vscode-errorForeground);
    background-color: var(--vscode-inputValidation-errorBackground, transparent);
}

#layout {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
}

#tabs {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    width: 180px;
    overflow-y: auto;
    padding: 6px 0;
    border-right: 1px solid var(--kl-border);
    background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
}

#tabs button {
    appearance: none;
    -webkit-appearance: none;
    font: inherit;
    color: inherit;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-left: 2px solid transparent;
    padding: 7px 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

#tabs button:hover {
    background-color: var(--kl-hover);
}

#tabs button[aria-selected="true"] {
    background-color: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-left-color: var(--vscode-focusBorder);
}

#tabs button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

#panels {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 12px 16px 40px;
}

.panel {
    display: none;
}

.panel.active {
    display: block;
}

.panel > h2 {
    margin: 0 0 12px;
    font-size: 1.15em;
    font-weight: 600;
}

.section {
    margin: 0 0 18px;
    padding: 10px 12px 12px;
    border: 1px solid var(--kl-border);
    border-radius: 3px;
}

.section > h3 {
    margin: 0 0 6px;
    font-size: 1em;
    font-weight: 600;
}

.section-desc {
    margin: 0 0 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
}

.fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px 16px;
}

.field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}

.field-wide {
    grid-column: 1 / -1;
}

.field-label {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px;
    font-weight: 600;
}

.field-hint {
    color: var(--vscode-descriptionForeground);
    font-weight: 400;
    font-size: 0.88em;
}

.field-note {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
}

.field-value {
    min-height: 22px;
    padding: 3px 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    word-break: break-all;
    user-select: text;
}

.field.info > .field-label {
    font-weight: 600;
}

.field-search {
    padding: 3px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: 0.92em;
}

.field-search:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

.field.unavailable > .field-label,
.field.readonly > .field-label {
    opacity: 0.75;
}

.empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
}

input[type="text"],
input[type="number"],
select,
textarea {
    width: 100%;
    font-family: inherit;
    font-size: inherit;
    color: var(--vscode-input-foreground);
    background-color: var(--vscode-input-background);
    border: 1px solid var(--kl-input-border);
    border-radius: 2px;
    padding: 3px 6px;
}

textarea {
    min-height: 72px;
    resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
}

input[type="text"]:focus,
input[type="number"]:focus,
select:focus,
textarea:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
    border-color: var(--vscode-focusBorder);
}

input:disabled,
select:disabled,
textarea:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

input[type="checkbox"] {
    width: auto;
    align-self: flex-start;
    margin: 3px 0;
    accent-color: var(--vscode-button-background);
}

#status {
    flex: 0 0 auto;
    padding: 6px 12px;
    border-top: 1px solid var(--kl-border);
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
    min-height: 28px;
    white-space: pre-wrap;
    word-break: break-word;
}

#status.ok {
    color: var(--vscode-foreground);
}

#status.warn {
    color: var(--vscode-editorWarning-foreground);
}

#status.error {
    color: var(--vscode-errorForeground);
    font-weight: 600;
}

::-webkit-scrollbar {
    width: 10px;
    height: 10px;
}

::-webkit-scrollbar-track {
    background: transparent;
}

::-webkit-scrollbar-thumb {
    background-color: var(--vscode-scrollbarSlider-background);
}

::-webkit-scrollbar-thumb:hover {
    background-color: var(--vscode-scrollbarSlider-hoverBackground);
}

@media (max-width: 700px) {
    #tabs {
        width: 132px;
    }

    .toolbar-project {
        max-width: 100%;
    }
}
`;

const OPTIONS_SCRIPT = `
(function () {
    'use strict';

    var vscode = acquireVsCodeApi();

    var elements = {
        projectLabel: document.getElementById('project-label'),
        toolchain: document.getElementById('toolchain'),
        targetSelect: document.getElementById('target-select'),
        save: document.getElementById('save'),
        reload: document.getElementById('reload'),
        openFile: document.getElementById('open-file'),
        openUvopt: document.getElementById('open-uvopt'),
        dirty: document.getElementById('dirty'),
        banner: document.getElementById('banner'),
        tabs: document.getElementById('tabs'),
        panels: document.getElementById('panels'),
        status: document.getElementById('status')
    };

    var state = {
        data: null,
        activeTab: null,
        busy: false,
        savedTimer: null,
        dirty: Object.create(null),
        original: Object.create(null),
        controls: Object.create(null)
    };

    function post(message) {
        try {
            vscode.postMessage(message);
        } catch (error) {
            setStatus('无法与扩展通信：' + describeError(error), 'error');
        }
    }

    function describeError(error) {
        if (error && typeof error.message === 'string') {
            return error.message;
        }
        return String(error);
    }

    function asText(value) {
        return value === undefined || value === null ? '' : String(value);
    }

    function safeId(value) {
        var parts = asText(value).split('.');
        return parts.join('-');
    }

    function setStatus(text, kind) {
        elements.status.textContent = text;
        elements.status.className = kind || '';
        elements.status.title = text;
    }

    function showBanner(text, kind) {
        if (!text) {
            hideBanner();
            return;
        }
        elements.banner.textContent = text;
        elements.banner.className = 'visible ' + (kind || '');
    }

    function hideBanner() {
        elements.banner.textContent = '';
        elements.banner.className = '';
    }

    function isReadonly() {
        return !!(state.data && state.data.readonly);
    }

    function uvoptAvailable() {
        return !!(state.data && state.data.uvoptFile);
    }

    function currentTarget() {
        if (elements.targetSelect && elements.targetSelect.value) {
            return elements.targetSelect.value;
        }
        if (state.data && state.data.activeTarget) {
            return state.data.activeTarget;
        }
        return '';
    }

    function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
    }

    function dirtyCount() {
        var count = 0;
        var id;
        for (id in state.dirty) {
            if (hasOwn(state.dirty, id)) {
                count += 1;
            }
        }
        return count;
    }

    function refreshDirtyUi() {
        var count = dirtyCount();
        var visible = count > 0;
        elements.dirty.textContent = visible ? '● 未保存 ' + count + ' 项' : '';
        elements.dirty.className = visible ? 'visible' : '';
        elements.dirty.title = visible ? '有 ' + count + ' 个字段已修改但尚未保存' : '';
        elements.save.disabled = state.busy || !state.data || isReadonly() || !visible;
        elements.save.title = visible ? '保存 ' + count + ' 个修改' : '没有需要保存的修改';
    }

    function applyBusy(value) {
        state.busy = value === true;
        var disabled = state.busy || !state.data;
        elements.reload.disabled = disabled;
        elements.openFile.disabled = disabled;
        elements.targetSelect.disabled = disabled;
        elements.openUvopt.disabled = disabled || !uvoptAvailable();
        refreshDirtyUi();
    }

    function countFields(data) {
        var total = 0;
        var tabs = Array.isArray(data.tabs) ? data.tabs : [];
        var i;
        var j;
        for (i = 0; i < tabs.length; i += 1) {
            var sections = Array.isArray(tabs[i].sections) ? tabs[i].sections : [];
            for (j = 0; j < sections.length; j += 1) {
                total += Array.isArray(sections[j].fields) ? sections[j].fields.length : 0;
            }
        }
        return total;
    }

    function renderToolbar(data) {
        elements.projectLabel.textContent = data.projectLabel || '未命名工程';
        elements.projectLabel.title = data.projectFile || '';
        elements.toolchain.textContent = data.toolchain ? '[' + data.toolchain + ']' : '';
        elements.toolchain.title = data.toolchain || '';

        var select = elements.targetSelect;
        while (select.firstChild) {
            select.removeChild(select.firstChild);
        }
        var targets = Array.isArray(data.targets) ? data.targets : [];
        var i;
        for (i = 0; i < targets.length; i += 1) {
            var option = document.createElement('option');
            option.value = targets[i];
            option.textContent = targets[i];
            select.appendChild(option);
        }
        if (data.activeTarget && targets.indexOf(data.activeTarget) === -1) {
            var activeOption = document.createElement('option');
            activeOption.value = data.activeTarget;
            activeOption.textContent = data.activeTarget;
            select.appendChild(activeOption);
        }
        if (data.activeTarget) {
            select.value = data.activeTarget;
        }
        elements.openFile.title = data.projectFile ? '打开 ' + data.projectFile : '打开工程文件';
        elements.openUvopt.hidden = !data.uvoptFile;
        elements.openUvopt.title = data.uvoptFile ? '打开 ' + data.uvoptFile : '当前工程没有 .uvopt/.uvoptx 文件';
        elements.reload.title = '丢弃修改并重新从磁盘加载';
    }

    function renderNotices(data) {
        var warnings = Array.isArray(data.warnings) ? data.warnings : [];
        if (data.readonly) {
            showBanner('面板只读：' + (data.readonlyReason || '当前工程文件无法安全写回'), 'error');
            return;
        }
        if (warnings.length > 0) {
            showBanner('注意：' + warnings[0], 'warn');
            elements.banner.title = warnings.join(' / ');
            return;
        }
        hideBanner();
    }

    function renderTabs(data) {
        var tabs = Array.isArray(data.tabs) ? data.tabs : [];
        var previous = state.activeTab;
        elements.tabs.textContent = '';
        var i;
        for (i = 0; i < tabs.length; i += 1) {
            var tab = tabs[i];
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'tab';
            button.id = 'tab-' + safeId(tab.id);
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-controls', 'panel-' + safeId(tab.id));
            button.setAttribute('data-tab-id', asText(tab.id));
            button.textContent = tab.title || asText(tab.id);
            button.tabIndex = -1;
            button.addEventListener('click', makeTabHandler(asText(tab.id)));
            button.addEventListener('keydown', makeTabKeyHandler(i, tabs));
            elements.tabs.appendChild(button);
        }

        var initialId = null;
        if (previous) {
            for (i = 0; i < tabs.length; i += 1) {
                if (asText(tabs[i].id) === previous) {
                    initialId = previous;
                    break;
                }
            }
        }
        if (!initialId && tabs.length > 0) {
            initialId = asText(tabs[0].id);
        }
        selectTab(initialId, false);
    }

    function makeTabHandler(tabId) {
        return function () {
            selectTab(tabId, false);
        };
    }

    function makeTabKeyHandler(index, tabs) {
        return function (event) {
            var nextIndex = -1;
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                nextIndex = (index + 1) % tabs.length;
            } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                nextIndex = (index - 1 + tabs.length) % tabs.length;
            } else if (event.key === 'Home') {
                nextIndex = 0;
            } else if (event.key === 'End') {
                nextIndex = tabs.length - 1;
            }
            if (nextIndex < 0) {
                return;
            }
            event.preventDefault();
            selectTab(asText(tabs[nextIndex].id), true);
        };
    }

    function selectTab(tabId, focus) {
        state.activeTab = tabId;
        var buttons = elements.tabs.querySelectorAll('button[data-tab-id]');
        var i;
        for (i = 0; i < buttons.length; i += 1) {
            var button = buttons[i];
            var selected = button.getAttribute('data-tab-id') === tabId;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.className = selected ? 'tab active' : 'tab';
            button.tabIndex = selected ? 0 : -1;
            if (selected && focus) {
                button.focus();
            }
        }
        var panels = elements.panels.querySelectorAll('.panel');
        for (i = 0; i < panels.length; i += 1) {
            if (panels[i].getAttribute('data-tab-id') === tabId) {
                panels[i].className = 'panel active';
            } else {
                panels[i].className = 'panel';
            }
        }
    }

    function renderPanels(data) {
        var tabs = Array.isArray(data.tabs) ? data.tabs : [];
        elements.panels.textContent = '';
        state.controls = Object.create(null);
        state.original = Object.create(null);

        var i;
        for (i = 0; i < tabs.length; i += 1) {
            var tab = tabs[i];
            var panel = document.createElement('section');
            panel.className = 'panel';
            panel.id = 'panel-' + safeId(tab.id);
            panel.setAttribute('data-tab-id', asText(tab.id));
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', 'tab-' + safeId(tab.id));

            var heading = document.createElement('h2');
            heading.textContent = tab.title || asText(tab.id);
            panel.appendChild(heading);

            var sections = Array.isArray(tab.sections) ? tab.sections : [];
            var j;
            for (j = 0; j < sections.length; j += 1) {
                panel.appendChild(renderSection(sections[j]));
            }
            if (sections.length === 0) {
                var empty = document.createElement('p');
                empty.className = 'empty';
                empty.textContent = '该标签页暂无可编辑字段。';
                panel.appendChild(empty);
            }
            elements.panels.appendChild(panel);
        }
        if (tabs.length === 0) {
            var emptyState = document.createElement('p');
            emptyState.className = 'empty';
            emptyState.textContent = '没有可显示的工程选项字段，请查看底部提示或重新加载。';
            elements.panels.appendChild(emptyState);
        }
    }

    function renderSection(section) {
        var wrapper = document.createElement('div');
        wrapper.className = 'section';

        var heading = document.createElement('h3');
        heading.textContent = section.title || asText(section.id);
        wrapper.appendChild(heading);

        if (section.description) {
            var description = document.createElement('p');
            description.className = 'section-desc';
            description.textContent = section.description;
            wrapper.appendChild(description);
        }

        var fields = Array.isArray(section.fields) ? section.fields : [];
        var grid = document.createElement('div');
        grid.className = 'fields';
        var i;
        for (i = 0; i < fields.length; i += 1) {
            grid.appendChild(renderField(section, fields[i]));
        }
        wrapper.appendChild(grid);
        return wrapper;
    }

    function renderField(section, field) {
        var wrapper = document.createElement('div');
        var classes = ['field'];
        if (field.type === 'multiline') {
            classes.push('field-wide');
        }
        if (field.unavailable) {
            classes.push('unavailable');
        }
        if (field.readonly) {
            classes.push('readonly');
        }
        if (field.type === 'info') {
            classes.push('info');
        }
        wrapper.className = classes.join(' ');

        var controlId = 'field-' + safeId(section.id) + '-' + safeId(field.id);
        var label = document.createElement('label');
        label.className = 'field-label';
        label.setAttribute('for', controlId);

        var labelText = document.createElement('span');
        labelText.textContent = field.label || asText(field.id);
        label.appendChild(labelText);

        if (field.hint) {
            var hint = document.createElement('span');
            hint.className = 'field-hint';
            hint.textContent = field.hint;
            label.appendChild(hint);
        }
        wrapper.appendChild(label);

        var disabledReason = '';
        var disabled = false;
        if (field.type === 'info') {
            // Pure information rows: never editable, never disabled-looking.
            disabled = false;
        } else if (isReadonly()) {
            disabled = true;
            disabledReason = (state.data && state.data.readonlyReason) || '面板为只读模式';
        } else if (field.unavailable) {
            disabled = true;
            disabledReason = field.unavailableReason || '当前工程不提供该字段';
        } else if (field.readonly) {
            disabled = true;
            disabledReason = '该字段为只读';
        }

        var control = createControl(field, controlId, disabled);
        wrapper.appendChild(control);

        // Large enums (e.g. the CMSIS-Pack device catalog) get an inline search box
        // that filters the visible <option> entries without changing the value.
        if (field.type === 'enum' && control.tagName === 'SELECT'
            && Array.isArray(field.options) && field.options.length > 40) {
            var search = document.createElement('input');
            search.type = 'search';
            search.className = 'field-search';
            search.placeholder = '搜索 ' + field.options.length + ' 个选项…';
            search.disabled = disabled;
            search.addEventListener('input', function () {
                var query = search.value.trim().toLowerCase();
                var options = control.options;
                for (var optionIndex = 0; optionIndex < options.length; optionIndex += 1) {
                    var optionText = options[optionIndex].textContent || '';
                    options[optionIndex].hidden = query !== '' && optionText.toLowerCase().indexOf(query) === -1;
                }
            });
            wrapper.insertBefore(search, control);
        }

        if (field.unavailable && field.unavailableReason) {
            var note = document.createElement('span');
            note.className = 'field-note';
            note.textContent = field.unavailableReason;
            wrapper.appendChild(note);
        }
        if (disabledReason) {
            control.title = disabledReason;
            wrapper.title = disabledReason;
        }

        state.original[field.id] = asText(field.value);
        state.controls[field.id] = control;
        return wrapper;
    }

    function createControl(field, controlId, disabled) {
        var value = asText(field.value);
        var control;
        switch (field.type) {
            case 'info':
                control = document.createElement('div');
                control.className = 'field-value';
                control.textContent = value === '' ? '—' : value;
                break;
            case 'multiline':
                control = document.createElement('textarea');
                control.rows = 4;
                control.value = value;
                control.placeholder = field.placeholder || '';
                control.addEventListener('input', makeValueHandler(field, function () {
                    return control.value;
                }));
                break;
            case 'bool':
                control = document.createElement('input');
                control.type = 'checkbox';
                control.checked = value === '1' || value.toLowerCase() === 'true';
                control.addEventListener('change', makeValueHandler(field, function () {
                    return control.checked ? '1' : '0';
                }));
                break;
            case 'number':
                control = document.createElement('input');
                control.type = 'number';
                control.step = 'any';
                control.value = value;
                control.placeholder = field.placeholder || '';
                control.addEventListener('input', makeValueHandler(field, function () {
                    return control.value;
                }));
                break;
            case 'enum':
                control = document.createElement('select');
                renderEnumOptions(control, field, value);
                control.addEventListener('change', makeValueHandler(field, function () {
                    return control.value;
                }));
                break;
            case 'string':
            default:
                control = document.createElement('input');
                control.type = 'text';
                control.value = value;
                control.placeholder = field.placeholder || '';
                control.addEventListener('input', makeValueHandler(field, function () {
                    return control.value;
                }));
                break;
        }
        control.id = controlId;
        control.setAttribute('data-field-id', asText(field.id));
        control.disabled = disabled;
        return control;
    }

    function renderEnumOptions(control, field, value) {
        var options = Array.isArray(field.options) ? field.options : [];
        var matched = false;
        var i;
        for (i = 0; i < options.length; i += 1) {
            var option = document.createElement('option');
            option.value = asText(options[i].value);
            option.textContent = options[i].label || asText(options[i].value);
            if (option.value === value) {
                matched = true;
            }
            control.appendChild(option);
        }
        if (!matched) {
            var current = document.createElement('option');
            current.value = value;
            current.textContent = value === '' ? '（未设置）' : value + '（自定义）';
            control.insertBefore(current, control.firstChild);
        }
        control.value = value;
    }

    function makeValueHandler(field, readValue) {
        return function () {
            setFieldValue(field, readValue());
        };
    }

    function setFieldValue(field, value) {
        var text = asText(value);
        var original = hasOwn(state.original, field.id) ? state.original[field.id] : '';
        if (text === original) {
            delete state.dirty[field.id];
        } else {
            state.dirty[field.id] = text;
        }
        refreshDirtyUi();
    }

    function collectDirtyValues() {
        var values = {};
        var count = 0;
        var id;
        for (id in state.dirty) {
            if (hasOwn(state.dirty, id)) {
                values[id] = state.dirty[id];
                count += 1;
            }
        }
        return { values: values, count: count };
    }

    function handleInit(data) {
        if (!data || typeof data !== 'object') {
            return;
        }
        if (state.savedTimer) {
            window.clearTimeout(state.savedTimer);
            state.savedTimer = null;
        }
        state.data = data;
        state.busy = false;
        state.dirty = Object.create(null);
        state.original = Object.create(null);
        state.controls = Object.create(null);

        renderToolbar(data);
        renderNotices(data);
        // Panels must be created before the tab rail selects the active tab:
        // selectTab toggles the "active" class on the panel sections.
        renderPanels(data);
        renderTabs(data);
        refreshDirtyUi();
        applyBusy(false);

        var targetCount = Array.isArray(data.targets) ? data.targets.length : 0;
        var summary = '已加载 ' + targetCount + ' 个目标 · ' + countFields(data) + ' 个字段';
        if (data.toolchain) {
            summary += ' · ' + data.toolchain;
        }
        var warnings = Array.isArray(data.warnings) ? data.warnings : [];
        if (warnings.length > 0) {
            summary += ' · ' + warnings.length + ' 条提示';
        }
        setStatus(summary, warnings.length > 0 ? 'warn' : 'ok');
    }

    function handleSaved(message) {
        var changed = Array.isArray(message.changed) ? message.changed : [];
        var warnings = Array.isArray(message.warnings) ? message.warnings : [];
        state.dirty = Object.create(null);
        refreshDirtyUi();

        var summary = '已保存 ' + changed.length + ' 个字段';
        if (warnings.length > 0) {
            summary += ' · ' + warnings.length + ' 条警告';
            showBanner('保存时出现警告：' + warnings.join('；'), 'warn');
        }
        setStatus(summary, warnings.length > 0 ? 'warn' : 'ok');

        if (state.savedTimer) {
            window.clearTimeout(state.savedTimer);
        }
        state.savedTimer = window.setTimeout(function () {
            state.savedTimer = null;
            if (dirtyCount() === 0) {
                setStatus('就绪', '');
            }
        }, 6000);
    }

    function handleError(message) {
        var text = typeof message === 'string' && message ? message : '操作失败';
        setStatus(text, 'error');
        showBanner(text, 'error');
    }

    function handleBusy(value) {
        applyBusy(value === true);
        if (value === true) {
            setStatus('正在处理…', '');
        }
    }

    elements.save.addEventListener('click', function () {
        if (state.busy || !state.data || isReadonly()) {
            return;
        }
        var target = currentTarget();
        if (!target) {
            setStatus('未选择目标，无法保存。', 'error');
            return;
        }
        var collected = collectDirtyValues();
        if (collected.count === 0) {
            setStatus('没有需要保存的修改。', '');
            return;
        }
        setStatus('正在保存 ' + collected.count + ' 个字段…', '');
        post({ type: 'save', target: target, values: collected.values });
    });

    elements.reload.addEventListener('click', function () {
        if (state.busy) {
            return;
        }
        setStatus('正在重新加载…', '');
        post({ type: 'reload', target: currentTarget() });
    });

    elements.targetSelect.addEventListener('change', function () {
        if (state.busy) {
            return;
        }
        var target = elements.targetSelect.value;
        if (!target) {
            return;
        }
        state.dirty = Object.create(null);
        refreshDirtyUi();
        setStatus('正在切换到目标 ' + target + '…', '');
        post({ type: 'switchTarget', target: target });
    });

    elements.openFile.addEventListener('click', function () {
        if (state.busy) {
            return;
        }
        post({ type: 'openFile', which: 'uvprojx' });
    });

    elements.openUvopt.addEventListener('click', function () {
        if (state.busy || !uvoptAvailable()) {
            return;
        }
        post({ type: 'openFile', which: 'uvopt' });
    });

    window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || typeof message.type !== 'string') {
            return;
        }
        switch (message.type) {
            case 'init':
                handleInit(message.data);
                break;
            case 'saved':
                handleSaved(message);
                break;
            case 'error':
                handleError(message.message);
                break;
            case 'busy':
                handleBusy(message.value);
                break;
            default:
                break;
        }
    });

    function announceReady() {
        post({ type: 'ready' });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', announceReady);
    } else {
        announceReady();
    }
})();
`;

/**
 * Escape a value so it can be embedded in a double quoted HTML attribute or in
 * the text of an element.
 */
function escapeHtml(value: string): string {
    return value
        .split('&').join('&amp;')
        .split('<').join('&lt;')
        .split('>').join('&gt;')
        .split('"').join('&quot;')
        .split("'").join('&#39;');
}

/**
 * Build the complete HTML document for the Options panel.
 *
 * The caller is responsible for generating a fresh `nonce` for every webview
 * instance; `cspSource` is the `webview.cspSource` value supplied by VS Code.
 */
export function buildOptionsHtml(options: { nonce: string; cspSource: string }): string {
    const nonce = escapeHtml(options.nonce);
    const cspSource = escapeHtml(options.cspSource);
    const contentSecurityPolicy = "default-src 'none'; img-src " + cspSource + " data:; style-src 'nonce-" + nonce +
        "'; script-src 'nonce-" + nonce + "'; font-src " + cspSource + ";";

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
<title>Keil Options</title>
<style nonce="${nonce}">${OPTIONS_STYLE}</style>
</head>
<body>
<header id="toolbar">
    <div class="toolbar-project">
        <span class="toolbar-label">工程</span>
        <span id="project-label" class="project-label">未加载</span>
        <span id="toolchain" class="toolchain"></span>
    </div>
    <div class="toolbar-field">
        <label class="toolbar-label" for="target-select">目标</label>
        <select id="target-select"></select>
    </div>
    <div class="toolbar-actions">
        <span id="dirty" class="dirty"></span>
        <button type="button" id="save" class="btn" disabled>保存</button>
        <button type="button" id="reload" class="btn secondary">重新加载</button>
        <button type="button" id="open-file" class="btn secondary">打开工程文件</button>
        <button type="button" id="open-uvopt" class="btn secondary" hidden>打开选项文件</button>
    </div>
</header>
<div id="banner" role="alert"></div>
<div id="layout">
    <nav id="tabs" role="tablist" aria-orientation="vertical" aria-label="工程选项标签页"></nav>
    <main id="panels"></main>
</div>
<footer id="status" role="status" aria-live="polite">正在加载工程选项…</footer>
<script nonce="${nonce}">${OPTIONS_SCRIPT}</script>
</body>
</html>
`;
}
