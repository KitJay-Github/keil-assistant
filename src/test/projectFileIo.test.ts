import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    ProjectEncodingError,
    backupProjectFile,
    findCompanionUvoptFile,
    readProjectTextFile,
    tryReadProjectTextFile,
    writeNewTextFile,
    writeProjectTextFile
} from '../project/projectFileIo';

function makeTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best effort cleanup.
    }
}

describe('projectFileIo', () => {
    const tempDirs: string[] = [];

    after(() => {
        tempDirs.forEach(removeDir);
    });

    it('reads UTF-8 files and reports the BOM state', () => {
        const dir = makeTempDir('keil-io-utf8-');
        tempDirs.push(dir);

        const plainPath = path.join(dir, 'plain.uvprojx');
        fs.writeFileSync(plainPath, '<Project>中文</Project>', 'utf8');
        const plain = readProjectTextFile(plainPath);
        assert.equal(plain.bom, false);
        assert.equal(plain.text, '<Project>中文</Project>');

        const bomPath = path.join(dir, 'bom.uvprojx');
        fs.writeFileSync(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<Project/>', 'utf8')]));
        const bom = readProjectTextFile(bomPath);
        assert.equal(bom.bom, true);
        assert.equal(bom.text, '<Project/>');
    });

    it('refuses non UTF-8 project files', () => {
        const dir = makeTempDir('keil-io-gbk-');
        tempDirs.push(dir);

        const gbkPath = path.join(dir, 'gbk.uvproj');
        // "工程" encoded as GBK, which is not valid UTF-8.
        fs.writeFileSync(gbkPath, Buffer.from([0xb9, 0xa4, 0xb3, 0xcc]));

        assert.throws(() => readProjectTextFile(gbkPath), (error: unknown) => {
            assert.ok(error instanceof ProjectEncodingError);
            assert.equal((error as ProjectEncodingError).filePath, gbkPath);
            return true;
        });

        const result = tryReadProjectTextFile(gbkPath);
        assert.equal(result.ok, false);
        assert.equal(result.encodingIssue, true);
        assert.ok(result.error && result.error.indexOf('UTF-8') !== -1);
    });

    it('reports a readable error when the file does not exist', () => {
        const result = tryReadProjectTextFile(path.join(os.tmpdir(), 'keil-missing-file-does-not-exist.uvprojx'));
        assert.equal(result.ok, false);
        assert.equal(result.encodingIssue, undefined);
        assert.ok(result.error && result.error.length > 0);
    });

    it('writes files back while preserving BOM and creating a backup', async () => {
        const dir = makeTempDir('keil-io-write-');
        tempDirs.push(dir);

        const projectPath = path.join(dir, 'demo.uvprojx');
        const original = '<Project>\n  <SchemaVersion>2.1</SchemaVersion>\n</Project>\n';
        fs.writeFileSync(projectPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(original, 'utf8')]));

        const file = readProjectTextFile(projectPath);
        assert.equal(file.bom, true);

        const backupDir = path.join(dir, 'backups');
        const next = '<Project>\n  <SchemaVersion>2.2</SchemaVersion>\n</Project>\n';
        const result = await writeProjectTextFile(file, next, { backupDir });
        assert.equal(result.ok, true, result.error);
        assert.ok(result.backupPath && fs.existsSync(result.backupPath));

        const bytes = fs.readFileSync(projectPath);
        assert.deepEqual([bytes[0], bytes[1], bytes[2]], [0xef, 0xbb, 0xbf], 'BOM must be preserved');
        assert.equal(bytes.subarray(3).toString('utf8'), next);

        const backupText = fs.readFileSync(result.backupPath!, 'utf8').replace(/^\uFEFF/, '');
        assert.equal(backupText, original);

        // No temporary file may be left behind.
        const leftovers = fs.readdirSync(dir).filter((name) => name.indexOf('.kltmp-') !== -1);
        assert.deepEqual(leftovers, []);
    });

    it('does not create a backup when none is requested', async () => {
        const dir = makeTempDir('keil-io-nobackup-');
        tempDirs.push(dir);

        const projectPath = path.join(dir, 'demo.uvprojx');
        fs.writeFileSync(projectPath, '<Project/>', 'utf8');
        const file = readProjectTextFile(projectPath);

        const result = await writeProjectTextFile(file, '<Project>updated</Project>');
        assert.equal(result.ok, true, result.error);
        assert.equal(result.backupPath, undefined);
        assert.equal(fs.readFileSync(projectPath, 'utf8'), '<Project>updated</Project>');
    });

    it('fails gracefully when the target directory is gone', async () => {
        const dir = makeTempDir('keil-io-missing-dir-');
        tempDirs.push(dir);

        const projectPath = path.join(dir, 'nested', 'demo.uvprojx');
        const file = { path: projectPath, text: '<Project/>', bom: false };
        const result = await writeProjectTextFile(file, '<Project>updated</Project>', { retries: 1, retryDelayMs: 1 });
        assert.equal(result.ok, false);
        assert.ok(result.error && result.error.length > 0);
    });

    it('creates parent directories when writing new files', () => {
        const dir = makeTempDir('keil-io-newfile-');
        tempDirs.push(dir);

        const target = path.join(dir, 'source', 'app', 'main.c');
        writeNewTextFile(target, 'int main(void) { return 0; }\n');
        assert.equal(fs.readFileSync(target, 'utf8'), 'int main(void) { return 0; }\n');
    });

    it('returns undefined for missing backup sources and prefers .uvoptx companions', () => {
        const dir = makeTempDir('keil-io-companion-');
        tempDirs.push(dir);

        assert.equal(backupProjectFile(path.join(dir, 'missing.uvprojx'), path.join(dir, 'backups')), undefined);

        const projectPath = path.join(dir, 'demo.uvprojx');
        fs.writeFileSync(projectPath, '<Project/>', 'utf8');
        assert.equal(findCompanionUvoptFile(projectPath), undefined);

        fs.writeFileSync(path.join(dir, 'demo.uvopt'), '<ProjectOpt/>', 'utf8');
        assert.equal(findCompanionUvoptFile(projectPath), path.join(dir, 'demo.uvopt'));

        fs.writeFileSync(path.join(dir, 'demo.uvoptx'), '<ProjectOpt/>', 'utf8');
        assert.equal(findCompanionUvoptFile(projectPath), path.join(dir, 'demo.uvoptx'));
    });
});
