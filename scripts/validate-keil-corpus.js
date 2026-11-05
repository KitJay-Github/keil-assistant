#!/usr/bin/env node
/**
 * Keil project corpus validation script (development tool, not part of `npm test`).
 *
 * Scans a directory recursively for `.uvproj` / `.uvprojx` files and validates that
 * the extension's new project-file layer can handle them:
 *
 *   1. the file is valid UTF-8 and parses with `parseXml`;
 *   2. `new XmlEditor(doc).apply()` with no edits reproduces the original text
 *      byte for byte (no hidden reformatting);
 *   3. every target exposes readable groups (`readTargetGroups`, when compiled);
 *   4. `readTargetOptions` does not throw for any target (when compiled); targets
 *      without a Keil toolchain are reported as skipped when the
 *      `--skip-unsupported-toolchain` flag is used.
 *
 * Usage:
 *   node scripts/validate-keil-corpus.js [目录] [--skip-unsupported-toolchain]
 *
 *   Without a directory argument the default corpus directory is used.
 *   `--skip-unsupported-toolchain` reports targets whose toolchain is not one of
 *   ARM / ARM6 / C51 / C251 (for example GCC-only projects shipped inside the Keil
 *   PACK directory) as skipped instead of failed. Without the flag such projects
 *   count as failures, because the options reader is expected to reject them.
 *
 * Exit codes:
 *   0 - every scanned project passed
 *   1 - at least one project failed validation
 *   2 - compiled modules are missing (run `npx tsc -p ./` first) or bad usage
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CORPUS_DIR = 'E:\\APP\\Keil';
const PROJECT_EXTENSIONS = new Set(['.uvproj', '.uvprojx']);
const MAX_REPORTED_FAILURES = 20;
const PROGRESS_INTERVAL = 100;

const UV_XML_MODULE = path.join(REPO_ROOT, 'dist', 'src', 'project', 'uvXml.js');
const UV_GROUPS_MODULE = path.join(REPO_ROOT, 'dist', 'src', 'project', 'uvGroups.js');
const UV_OPTIONS_MODULE = path.join(REPO_ROOT, 'dist', 'src', 'project', 'options', 'uvOptions.js');

const UV_GROUPS_SOURCE = path.join(REPO_ROOT, 'src', 'project', 'uvGroups.ts');
const UV_OPTIONS_SOURCE = path.join(REPO_ROOT, 'src', 'project', 'options', 'uvOptions.ts');

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

function describeError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function loadModule(modulePath, requiredExports) {
    if (!fs.existsSync(modulePath)) {
        return { ok: false, reason: `未找到文件 ${modulePath}` };
    }
    let loaded;
    try {
        loaded = require(modulePath);
    } catch (error) {
        return { ok: false, reason: `加载 ${modulePath} 失败：${describeError(error)}` };
    }
    const missing = requiredExports.filter((name) => typeof loaded[name] !== 'function');
    if (missing.length > 0) {
        return {
            ok: false,
            reason: `${modulePath} 缺少导出函数：${missing.join(', ')}`
        };
    }
    return { ok: true, module: loaded };
}

function printMissingCompiledModulesHint() {
    console.error('');
    console.error('错误：未找到可用的编译产物，请先运行 npx tsc -p ./ 后重试。');
    console.error(`  - ${UV_XML_MODULE}`);
}

/**
 * Resolve a validation module that is only available once the corresponding
 * feature has been compiled.
 *
 * - compiled module usable      -> `{ module }`
 * - source exists, dist missing -> print `npx tsc -p ./` hint, return `undefined` (exit 2)
 * - source does not exist yet   -> warn and skip the check, `{ module: undefined }`
 */
function resolveOptionalModule(label, modulePath, sourcePath, requiredExports) {
    const loaded = loadModule(modulePath, requiredExports);
    if (loaded.ok) {
        return { module: loaded.module };
    }
    if (fs.existsSync(sourcePath)) {
        console.error(`错误：${loaded.reason}`);
        console.error(`请先运行 npx tsc -p ./ 后重试（「${label}」校验需要该编译产物）。`);
        return undefined;
    }
    console.warn(`提示：跳过「${label}」校验（源码尚未提供：${sourcePath}）。`);
    return { module: undefined };
}

function loadModules() {
    const uvXml = loadModule(UV_XML_MODULE, [
        'parseXml',
        'XmlEditor',
        'projectTargets',
        'targetNameOf'
    ]);
    if (!uvXml.ok) {
        console.error(`错误：${uvXml.reason}`);
        printMissingCompiledModulesHint();
        return undefined;
    }

    const uvGroups = resolveOptionalModule(
        '目标分组读取',
        UV_GROUPS_MODULE,
        UV_GROUPS_SOURCE,
        ['listTargets', 'readTargetGroups']
    );
    if (!uvGroups) {
        return undefined;
    }

    const uvOptions = resolveOptionalModule(
        'Options 读取',
        UV_OPTIONS_MODULE,
        UV_OPTIONS_SOURCE,
        ['readTargetOptions']
    );
    if (!uvOptions) {
        return undefined;
    }

    return {
        uvXml: uvXml.module,
        uvGroups: uvGroups.module,
        uvOptions: uvOptions.module
    };
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function collectProjectFiles(rootDir) {
    const files = [];
    const scanErrors = [];
    const pending = [rootDir];

    while (pending.length > 0) {
        const currentDir = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (error) {
            scanErrors.push({
                file: currentDir,
                issues: [`无法读取目录：${describeError(error)}`]
            });
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(currentDir, entry.name);
            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory()) {
                pending.push(entryPath);
                continue;
            }
            if (entry.isFile() && PROJECT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                files.push(entryPath);
            }
        }
    }

    files.sort();
    return { files, scanErrors };
}

// ---------------------------------------------------------------------------
// Single file validation
// ---------------------------------------------------------------------------

function firstDifferenceIndex(left, right) {
    const max = Math.min(left.length, right.length);
    for (let i = 0; i < max; i++) {
        if (left[i] !== right[i]) {
            return i;
        }
    }
    return max;
}

function readUtf8Payload(filePath) {
    const buffer = fs.readFileSync(filePath);
    const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const payload = bom ? buffer.subarray(3) : buffer;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    return { text: decoder.decode(payload), payload, bom };
}

function readTargetNames(uvXml, text, issues) {
    try {
        const doc = uvXml.parseXml(text);
        const names = uvXml
            .projectTargets(doc.root)
            .map((target) => uvXml.targetNameOf(target))
            .filter((name) => name.length > 0);
        return names;
    } catch (error) {
        issues.push(`目标列表读取失败：${describeError(error)}`);
        return [];
    }
}

/**
 * True when the options reader cannot resolve a Keil toolchain for the target
 * (for example GCC-only projects shipped inside the Keil PACK directory).
 */
function hasUnsupportedToolchain(uvOptions, text, targetName) {
    if (typeof uvOptions.detectTargetToolchain !== 'function') {
        return false;
    }
    try {
        uvOptions.detectTargetToolchain(text, targetName);
        return false;
    } catch {
        return true;
    }
}

/**
 * Validate one project file.
 * Returns `{ issues, targetCount, groupCount, groupFileCount, groupsChecked,
 * optionsChecked, unsupportedOptionTargets }`.
 */
function validateProject(filePath, modules, options) {
    const { uvXml, uvGroups, uvOptions } = modules;
    const skipUnsupportedToolchain = options.skipUnsupportedToolchain;
    const result = {
        file: filePath,
        issues: [],
        targetCount: 0,
        groupCount: 0,
        groupFileCount: 0,
        groupsChecked: false,
        optionsChecked: false,
        unsupportedOptionTargets: 0
    };

    let text;
    let payload;
    try {
        const decoded = readUtf8Payload(filePath);
        text = decoded.text;
        payload = decoded.payload;
    } catch (error) {
        result.issues.push(`读取 / UTF-8 解码失败：${describeError(error)}`);
        return result;
    }

    let doc;
    try {
        doc = uvXml.parseXml(text);
    } catch (error) {
        result.issues.push(`XML 解析失败：${describeError(error)}`);
        return result;
    }

    let roundTrip;
    try {
        roundTrip = new uvXml.XmlEditor(doc).apply();
    } catch (error) {
        result.issues.push(`空编辑 round-trip 抛错：${describeError(error)}`);
        return result;
    }

    if (typeof roundTrip !== 'string') {
        result.issues.push(`空编辑 round-trip 未返回文本（得到 ${typeof roundTrip}）`);
        return result;
    }
    if (roundTrip !== text) {
        result.issues.push(
            `空编辑 round-trip 与原文本不一致（首个差异偏移 ${firstDifferenceIndex(roundTrip, text)}）`
        );
    } else if (!Buffer.from(roundTrip, 'utf8').equals(payload)) {
        result.issues.push('空编辑 round-trip 重新编码后与原文件字节不一致');
    }

    const targetNames = readTargetNames(uvXml, text, result.issues);
    result.targetCount = targetNames.length;

    if (uvGroups) {
        result.groupsChecked = true;
        try {
            uvGroups.listTargets(text);
        } catch (error) {
            result.issues.push(`listTargets 抛错：${describeError(error)}`);
        }
        for (const targetName of targetNames) {
            let groups;
            try {
                groups = uvGroups.readTargetGroups(text, targetName);
            } catch (error) {
                result.issues.push(`目标 "${targetName}" 读取分组抛错：${describeError(error)}`);
                continue;
            }
            if (!Array.isArray(groups)) {
                result.issues.push(`目标 "${targetName}" 无法读取分组（返回 ${typeof groups}）`);
                continue;
            }
            result.groupCount += groups.length;
            for (const group of groups) {
                result.groupFileCount += Array.isArray(group.files) ? group.files.length : 0;
            }
        }
    }

    if (uvOptions) {
        result.optionsChecked = true;
        for (const targetName of targetNames) {
            if (skipUnsupportedToolchain && hasUnsupportedToolchain(uvOptions, text, targetName)) {
                result.unsupportedOptionTargets++;
                continue;
            }
            try {
                uvOptions.readTargetOptions(text, targetName);
            } catch (error) {
                result.issues.push(`目标 "${targetName}" 读取 Options 抛错：${describeError(error)}`);
            }
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function printUsage() {
    console.log('Keil 工程语料校验');
    console.log('');
    console.log('用法：node scripts/validate-keil-corpus.js [目录] [--skip-unsupported-toolchain]');
    console.log(`  目录  递归扫描的根目录，默认 ${DEFAULT_CORPUS_DIR}`);
    console.log('');
    console.log('选项：');
    console.log('  --skip-unsupported-toolchain  对不支持 Keil 工具链（ARM/ARM6/C51/C251）的目标跳过 Options 读取校验');
    console.log('');
    console.log('校验项：XML 解析、无编辑 round-trip 逐字节一致、目标分组读取、Options 读取');
    console.log('退出码：0 全部通过；1 存在校验失败；2 编译产物缺失或参数错误');
}

function formatDuration(milliseconds) {
    return `${(milliseconds / 1000).toFixed(2)}s`;
}

function main(argv) {
    if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
        printUsage();
        return 0;
    }

    const unknownFlags = argv.filter((arg) => arg.startsWith('-') && arg !== '--skip-unsupported-toolchain');
    if (unknownFlags.length > 0) {
        console.error(`未知参数：${unknownFlags.join(' ')}`);
        printUsage();
        return 2;
    }

    const options = {
        skipUnsupportedToolchain: argv.indexOf('--skip-unsupported-toolchain') !== -1
    };
    const positional = argv.filter((arg) => !arg.startsWith('-'));
    if (positional.length > 1) {
        console.error(`参数过多：${positional.join(' ')}`);
        printUsage();
        return 2;
    }

    const corpusDir = path.resolve(positional.length === 1 ? positional[0] : DEFAULT_CORPUS_DIR);
    if (!fs.existsSync(corpusDir)) {
        console.error(`错误：目录不存在：${corpusDir}`);
        return 2;
    }
    if (!fs.statSync(corpusDir).isDirectory()) {
        console.error(`错误：不是目录：${corpusDir}`);
        return 2;
    }

    const modules = loadModules();
    if (!modules) {
        return 2;
    }

    console.log('Keil 工程语料校验');
    console.log(`  扫描目录：${corpusDir}`);
    console.log(
        `  模块：uvXml ✓  uvGroups ${modules.uvGroups ? '✓' : '（跳过）'}  uvOptions ${modules.uvOptions ? '✓' : '（跳过）'}`
    );
    if (options.skipUnsupportedToolchain) {
        console.log('  选项：--skip-unsupported-toolchain（不支持 Keil 工具链的目标记为跳过）');
    }
    console.log('');

    const startedAt = Date.now();
    const { files, scanErrors } = collectProjectFiles(corpusDir);
    const failures = scanErrors.slice();
    let fileFailureCount = 0;
    let targetTotal = 0;
    let groupTotal = 0;
    let groupFileTotal = 0;
    let groupsChecked = false;
    let optionsChecked = false;
    let unsupportedOptionTargets = 0;

    if (files.length === 0) {
        console.warn(`警告：在 ${corpusDir} 下未找到 .uvproj/.uvprojx 文件。`);
    }

    files.forEach((filePath, index) => {
        const result = validateProject(filePath, modules, options);
        targetTotal += result.targetCount;
        groupTotal += result.groupCount;
        groupFileTotal += result.groupFileCount;
        groupsChecked = groupsChecked || result.groupsChecked;
        optionsChecked = optionsChecked || result.optionsChecked;
        unsupportedOptionTargets += result.unsupportedOptionTargets;
        if (result.issues.length > 0) {
            failures.push(result);
            fileFailureCount++;
        }
        const processed = index + 1;
        if (processed % PROGRESS_INTERVAL === 0 && processed < files.length) {
            console.log(`  已处理 ${processed}/${files.length} 个工程文件…`);
        }
    });

    const durationMs = Date.now() - startedAt;

    console.log('');
    console.log('===== 校验结果 =====');
    console.log(`扫描目录：${corpusDir}`);
    console.log(`工程文件总数：${files.length}`);
    console.log(`校验通过：${files.length - fileFailureCount}`);
    console.log(`校验失败：${fileFailureCount}`);
    if (scanErrors.length > 0) {
        console.log(`目录读取失败：${scanErrors.length}`);
    }
    console.log(`目标总数：${targetTotal}`);
    if (groupsChecked) {
        console.log(`分组总数：${groupTotal}`);
        console.log(`分组内文件总数：${groupFileTotal}`);
    } else {
        console.log('分组校验：已跳过（uvGroups 编译产物缺失）');
    }
    if (!optionsChecked) {
        console.log('Options 校验：已跳过（uvOptions 编译产物缺失）');
    } else if (unsupportedOptionTargets > 0) {
        console.log(`Options 校验：跳过 ${unsupportedOptionTargets} 个不支持 Keil 工具链的目标`);
    }
    console.log(`耗时：${formatDuration(durationMs)}`);

    if (failures.length > 0) {
        console.log('');
        console.log(`失败列表（前 ${Math.min(failures.length, MAX_REPORTED_FAILURES)} / 共 ${failures.length} 项）：`);
        failures.slice(0, MAX_REPORTED_FAILURES).forEach((failure, index) => {
            console.log(`  ${index + 1}) ${failure.file}`);
            for (const issue of failure.issues) {
                console.log(`     - ${issue}`);
            }
        });
        if (failures.length > MAX_REPORTED_FAILURES) {
            console.log(`  …其余 ${failures.length - MAX_REPORTED_FAILURES} 项已省略`);
        }
        console.log('');
        console.log('结果：存在校验失败的工程文件。');
        return 1;
    }

    console.log('');
    console.log('结果：全部工程文件校验通过。');
    return 0;
}

process.exitCode = main(process.argv.slice(2));
