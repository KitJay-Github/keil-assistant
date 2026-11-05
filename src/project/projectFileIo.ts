/**
 * Encoding-aware, crash-safe read/write helpers for Keil project files.
 *
 * Keil uVision writes `.uvproj(x)` / `.uvopt(x)` as UTF-8 with an XML declaration
 * (the corpus of 1400+ real projects is uniformly UTF-8). Files that cannot be
 * decoded as strict UTF-8 are treated as read-only so we never corrupt a legacy
 * GBK project. Writes go through a temporary file + rename and are retried when
 * uVision holds a lock on the project file.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Raised when a project file is not valid UTF-8 (writes must be refused). */
export class ProjectEncodingError extends Error {
    readonly filePath: string;

    constructor(filePath: string, message?: string) {
        super(message || `Project file is not valid UTF-8: ${filePath}`);
        this.name = 'ProjectEncodingError';
        this.filePath = filePath;
    }
}

export interface ProjectTextFile {
    /** Absolute file path. */
    path: string;
    /** Decoded text without the BOM. */
    text: string;
    /** Whether the original file started with a UTF-8 BOM. */
    bom: boolean;
}

export interface ReadTextFileResult {
    ok: boolean;
    file?: ProjectTextFile;
    /** Human readable error, suitable for a VS Code notification. */
    error?: string;
    /** True when the failure was caused by the file encoding. */
    encodingIssue?: boolean;
}

export interface WriteProjectTextOptions {
    /** Directory that receives a timestamped backup copy of the original file. */
    backupDir?: string;
    /** Number of attempts for temporary-file writes and renames. */
    retries?: number;
    /** Delay between attempts, in milliseconds. */
    retryDelayMs?: number;
    /** Skip creating the backup even when `backupDir` is provided. */
    skipBackup?: boolean;
}

export interface WriteProjectTextResult {
    ok: boolean;
    backupPath?: string;
    error?: string;
}

const DEFAULT_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 200;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function isRetryableCode(code: string | undefined): boolean {
    return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EAGAIN';
}

function describeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function errorCode(error: unknown): string | undefined {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        return typeof code === 'string' ? code : undefined;
    }
    return undefined;
}

/**
 * Read a Keil project file as UTF-8 text, remembering whether it carried a BOM.
 * Throws {@link ProjectEncodingError} when the bytes are not valid UTF-8.
 */
export function readProjectTextFile(filePath: string): ProjectTextFile {
    const buffer = fs.readFileSync(filePath);
    const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const payload = bom ? buffer.subarray(3) : buffer;

    let text: string;
    try {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        text = decoder.decode(payload);
    } catch {
        throw new ProjectEncodingError(
            filePath,
            `工程文件不是 UTF-8 编码，为避免损坏中文内容已禁止写回：${filePath}`
        );
    }

    return { path: filePath, text, bom };
}

/** Non-throwing variant of {@link readProjectTextFile} for UI code. */
export function tryReadProjectTextFile(filePath: string): ReadTextFileResult {
    try {
        return { ok: true, file: readProjectTextFile(filePath) };
    } catch (error) {
        if (error instanceof ProjectEncodingError) {
            return { ok: false, error: error.message, encodingIssue: true };
        }
        return { ok: false, error: `${describeError(error)}` };
    }
}

function timestampForFileName(date: Date): string {
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '-',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
        '-',
        pad(date.getMilliseconds(), 3)
    ].join('');
}

/**
 * Copy the current file content into `backupDir` using a timestamped name.
 * Returns the backup path, or `undefined` when the source does not exist.
 */
export function backupProjectFile(filePath: string, backupDir: string): string | undefined {
    if (!fs.existsSync(filePath)) {
        return undefined;
    }
    try {
        fs.mkdirSync(backupDir, { recursive: true });
    } catch (error) {
        throw new Error(`无法创建备份目录 ${backupDir}: ${describeError(error)}`);
    }
    const parsed = path.parse(filePath);
    const backupName = `${parsed.base}.${timestampForFileName(new Date())}.bak`;
    const backupPath = path.join(backupDir, backupName);
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
}

async function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write UTF-8 text back to a project file.
 *
 * The write is atomic (temporary file + rename) and retried while uVision keeps
 * the project file locked.
 */
export async function writeProjectTextFile(
    file: ProjectTextFile,
    nextText: string,
    options: WriteProjectTextOptions = {}
): Promise<WriteProjectTextResult> {
    const retries = options.retries === undefined ? DEFAULT_RETRIES : options.retries;
    const retryDelayMs = options.retryDelayMs === undefined ? DEFAULT_RETRY_DELAY_MS : options.retryDelayMs;

    let backupPath: string | undefined;
    if (options.backupDir && !options.skipBackup) {
        try {
            backupPath = backupProjectFile(file.path, options.backupDir);
        } catch (error) {
            return { ok: false, error: describeError(error) };
        }
    }

    const payload = Buffer.concat([file.bom ? UTF8_BOM : Buffer.alloc(0), Buffer.from(nextText, 'utf8')]);
    const temporaryPath = `${file.path}.kltmp-${process.pid}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            fs.writeFileSync(temporaryPath, payload);
            fs.renameSync(temporaryPath, file.path);
            return { ok: true, backupPath };
        } catch (error) {
            lastError = error;
            try {
                if (fs.existsSync(temporaryPath)) {
                    fs.unlinkSync(temporaryPath);
                }
            } catch {
                // Best effort cleanup only.
            }
            if (!isRetryableCode(errorCode(error)) || attempt === retries) {
                break;
            }
            await delay(retryDelayMs);
        }
    }

    const code = errorCode(lastError);
    const hints = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
        ? '文件可能正被 Keil uVision 占用，请先关闭 uVision 中打开的工程后重试。'
        : '请检查文件是否只读或被其他程序占用。';
    return { ok: false, error: `写入工程文件失败：${describeError(lastError)}。${hints}` };
}

/** Write a freshly created file, creating parent directories as needed. */
export function writeNewTextFile(filePath: string, text: string, bom = false): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const payload = Buffer.concat([bom ? UTF8_BOM : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
    fs.writeFileSync(filePath, payload);
}

/**
 * Resolve the `.uvopt` / `.uvoptx` companion file of a `.uvproj(x)` project.
 * `.uvoptx` wins when both exist.
 */
export function findCompanionUvoptFile(projectFilePath: string): string | undefined {
    const parsed = path.parse(projectFilePath);
    const candidates = [
        path.join(parsed.dir, `${parsed.name}.uvoptx`),
        path.join(parsed.dir, `${parsed.name}.uvopt`)
    ];
    return candidates.find((candidate) => fs.existsSync(candidate));
}
