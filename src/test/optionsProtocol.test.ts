import { strict as assert } from 'assert';
import { parseWebviewMessage, serializeHostMessage } from '../project/options/protocol';
import type { HostToWebviewMessage } from '../project/options/protocol';
import type { OptionsViewData } from '../project/options/types';

describe('optionsProtocol.parseWebviewMessage', () => {
    it('parses the ready message and drops unknown fields', () => {
        assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
        assert.deepEqual(parseWebviewMessage({ type: 'ready', extra: 'ignored' }), { type: 'ready' });
    });

    it('parses save messages with target and string values', () => {
        const parsed = parseWebviewMessage({
            type: 'save',
            target: 'Debug',
            values: { 'ccpp.define': 'A=1', 'linker.scatter': '', 'output.hex': '1' }
        });
        assert.deepEqual(parsed, {
            type: 'save',
            target: 'Debug',
            values: { 'ccpp.define': 'A=1', 'linker.scatter': '', 'output.hex': '1' }
        });
    });

    it('parses save messages with an empty value map', () => {
        const parsed = parseWebviewMessage({ type: 'save', target: 'Debug', values: {} });
        assert.deepEqual(parsed, { type: 'save', target: 'Debug', values: {} });
    });

    it('parses reload and switchTarget messages', () => {
        assert.deepEqual(parseWebviewMessage({ type: 'reload', target: 'Release' }), {
            type: 'reload',
            target: 'Release'
        });
        assert.deepEqual(parseWebviewMessage({ type: 'switchTarget', target: 'Release' }), {
            type: 'switchTarget',
            target: 'Release'
        });
        assert.deepEqual(parseWebviewMessage({ type: 'reload', target: 'Release', pid: 1 }), {
            type: 'reload',
            target: 'Release'
        });
    });

    it('parses openFile messages for both project files', () => {
        assert.deepEqual(parseWebviewMessage({ type: 'openFile', which: 'uvprojx' }), {
            type: 'openFile',
            which: 'uvprojx'
        });
        assert.deepEqual(parseWebviewMessage({ type: 'openFile', which: 'uvopt' }), {
            type: 'openFile',
            which: 'uvopt'
        });
    });

    it('rejects unknown or wrongly cased message types', () => {
        assert.equal(parseWebviewMessage({ type: 'nope' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'SAVE', target: 'Debug', values: {} }), undefined);
        assert.equal(parseWebviewMessage({ type: '' }), undefined);
        assert.equal(parseWebviewMessage({ type: 42 }), undefined);
        assert.equal(parseWebviewMessage({ type: ['ready'] }), undefined);
    });

    it('rejects non-object payloads', () => {
        const invalidPayloads: unknown[] = [
            null,
            undefined,
            '',
            'ready',
            0,
            true,
            [],
            [{ type: 'ready' }],
            () => 'ready'
        ];
        for (const payload of invalidPayloads) {
            assert.equal(parseWebviewMessage(payload), undefined);
        }
    });

    it('rejects messages with missing or badly typed fields', () => {
        assert.equal(parseWebviewMessage({}), undefined);
        assert.equal(parseWebviewMessage({ type: 'save' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', values: {} }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 1, values: {} }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: '', values: {} }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: '   ', values: {} }), undefined);
        assert.equal(parseWebviewMessage({ type: 'reload' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'reload', target: null }), undefined);
        assert.equal(parseWebviewMessage({ type: 'reload', target: 7 }), undefined);
        assert.equal(parseWebviewMessage({ type: 'switchTarget' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'switchTarget', target: ['Debug'] }), undefined);
        assert.equal(parseWebviewMessage({ type: 'openFile' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'openFile', which: 'uvproj' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'openFile', which: 'uvprojx ' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'openFile', which: 1 }), undefined);
    });

    it('rejects a values payload that is not a plain string map', () => {
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: [] }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: null }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: 'a=b' }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: new Map() }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: { a: 1 } }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: { a: null } }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: { a: { b: 'c' } } }), undefined);
        assert.equal(parseWebviewMessage({ type: 'save', target: 'Debug', values: Object.create({ a: 'b' }) }), undefined);
    });

    it('rejects prototype polluting value keys', () => {
        const payload = JSON.parse('{"type":"save","target":"Debug","values":{"__proto__":"x"}}');
        assert.equal(parseWebviewMessage(payload), undefined);
        const constructorPayload = JSON.parse('{"type":"save","target":"Debug","values":{"constructor":"x"}}');
        assert.equal(parseWebviewMessage(constructorPayload), undefined);
    });
});

describe('optionsProtocol.serializeHostMessage', () => {
    const viewData: OptionsViewData = {
        projectLabel: 'Demo',
        projectFile: 'C:/firmware/demo.uvprojx',
        uvoptFile: 'C:/firmware/demo.uvoptx',
        targets: ['Debug', 'Release'],
        activeTarget: 'Debug',
        toolchain: 'ARM (AC6)',
        tabs: [
            {
                id: 'target',
                title: 'Target',
                sections: [
                    {
                        id: 'target.device',
                        title: 'Device',
                        fields: [
                            {
                                id: 'target.device',
                                label: 'Device',
                                type: 'string',
                                value: 'STM32F103C8',
                                options: [{ value: '1', label: 'One' }]
                            }
                        ]
                    }
                ]
            }
        ],
        warnings: ['uvopt file missing'],
        readonly: false
    };

    it('serializes init messages', () => {
        assert.deepEqual(serializeHostMessage({ type: 'init', data: viewData }), {
            type: 'init',
            data: viewData
        });
    });

    it('serializes saved messages', () => {
        assert.deepEqual(serializeHostMessage({ type: 'saved', changed: ['ccpp.define'], warnings: [] }), {
            type: 'saved',
            changed: ['ccpp.define'],
            warnings: []
        });
    });

    it('normalizes malformed saved arrays instead of forwarding them', () => {
        const message = {
            type: 'saved',
            changed: ['ccpp.define', 5, null],
            warnings: 'not-an-array'
        } as unknown as HostToWebviewMessage;
        assert.deepEqual(serializeHostMessage(message), {
            type: 'saved',
            changed: ['ccpp.define'],
            warnings: []
        });
    });

    it('serializes error and busy messages', () => {
        assert.deepEqual(serializeHostMessage({ type: 'error', message: '写回失败' }), {
            type: 'error',
            message: '写回失败'
        });
        assert.deepEqual(serializeHostMessage({ type: 'busy', value: true }), { type: 'busy', value: true });
        assert.deepEqual(serializeHostMessage({ type: 'busy', value: false }), { type: 'busy', value: false });
    });

    it('strips unknown runtime fields', () => {
        const message = { type: 'busy', value: true, extra: 'ignored' } as unknown as HostToWebviewMessage;
        assert.deepEqual(serializeHostMessage(message), { type: 'busy', value: true });
    });

    it('throws for an unknown message type instead of emitting garbage', () => {
        assert.throws(() => serializeHostMessage({ type: 'nope' } as unknown as HostToWebviewMessage));
    });
});
