/**
 * Message protocol shared by the Options panel host (`optionsPanel.ts`) and the
 * generated webview assets (`panelAssets.ts`).
 *
 * The module is intentionally free of `vscode` and DOM dependencies: it only
 * contains plain data types plus strict parsing / serialization helpers, so it
 * can be unit tested in a plain Node process and reused on both sides.
 */

import type { OptionsViewData } from './types';

/** Messages sent from the webview to the extension host. */
export type WebviewToHostMessage =
    | { type: 'ready' }
    | { type: 'save'; target: string; values: Record<string, string> }
    | { type: 'reload'; target: string }
    | { type: 'switchTarget'; target: string }
    | { type: 'openFile'; which: 'uvprojx' | 'uvopt' };

/** Messages sent from the extension host to the webview. */
export type HostToWebviewMessage =
    | { type: 'init'; data: OptionsViewData }
    | { type: 'saved'; changed: string[]; warnings: string[] }
    | { type: 'error'; message: string }
    | { type: 'busy'; value: boolean };

/**
 * Keys that must never be copied into the editable value map: accepting them
 * would let a compromised webview tamper with the prototype chain of objects
 * that the option writers iterate over.
 */
const FORBIDDEN_VALUE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Accept only plain `{}` / `Object.create(null)` objects, never arrays or class instances. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Read a required non-empty string field. */
function readRequiredString(source: Record<string, unknown>, key: string): string | undefined {
    const value = source[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        return undefined;
    }
    return value;
}

/** Copy a `Record<string, string>` out of an untrusted payload, validating every entry. */
function readStringRecord(source: Record<string, unknown>, key: string): Record<string, string> | undefined {
    const raw = source[key];
    if (!isPlainObject(raw)) {
        return undefined;
    }
    const result: Record<string, string> = {};
    const keys = Object.keys(raw);
    for (const entryKey of keys) {
        if (entryKey.length === 0 || FORBIDDEN_VALUE_KEYS.has(entryKey)) {
            return undefined;
        }
        const entryValue = raw[entryKey];
        if (typeof entryValue !== 'string') {
            return undefined;
        }
        result[entryKey] = entryValue;
    }
    return result;
}

function isOpenFileKind(value: string): value is 'uvprojx' | 'uvopt' {
    return value === 'uvprojx' || value === 'uvopt';
}

function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Strictly validate one webview message.
 *
 * Returns `undefined` (never throws) for anything that does not match the
 * protocol exactly: unknown `type`, missing fields, wrong field types, a
 * `values` payload that is not a plain string map, or non-object input.
 * Unknown extra fields are dropped rather than forwarded.
 */
export function parseWebviewMessage(raw: unknown): WebviewToHostMessage | undefined {
    if (!isPlainObject(raw)) {
        return undefined;
    }
    const type = raw['type'];
    if (typeof type !== 'string') {
        return undefined;
    }

    switch (type) {
        case 'ready':
            return { type: 'ready' };

        case 'save': {
            const target = readRequiredString(raw, 'target');
            const values = readStringRecord(raw, 'values');
            if (target === undefined || values === undefined) {
                return undefined;
            }
            return { type: 'save', target, values };
        }

        case 'reload': {
            const target = readRequiredString(raw, 'target');
            return target === undefined ? undefined : { type: 'reload', target };
        }

        case 'switchTarget': {
            const target = readRequiredString(raw, 'target');
            return target === undefined ? undefined : { type: 'switchTarget', target };
        }

        case 'openFile': {
            const which = raw['which'];
            if (typeof which !== 'string' || !isOpenFileKind(which)) {
                return undefined;
            }
            return { type: 'openFile', which };
        }

        default:
            return undefined;
    }
}

/**
 * Convert a host message into a JSON-safe payload for `webview.postMessage`.
 *
 * Only the fields declared by {@link HostToWebviewMessage} are emitted; any
 * extra runtime property is dropped, and malformed array members are removed
 * instead of being forwarded to the webview.
 */
export function serializeHostMessage(message: HostToWebviewMessage): unknown {
    switch (message.type) {
        case 'init':
            return { type: 'init', data: message.data };

        case 'saved':
            return {
                type: 'saved',
                changed: toStringArray(message.changed),
                warnings: toStringArray(message.warnings)
            };

        case 'error':
            return { type: 'error', message: String(message.message) };

        case 'busy':
            return { type: 'busy', value: message.value === true };

        default:
            throw new Error(`Unsupported host message type: ${String((message as { type?: unknown }).type)}`);
    }
}
