import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
    ApplyOutcome,
    XmlEditor,
    buildContainerElement,
    buildLeafElement,
    decodeXmlText,
    detectIndentUnit,
    escapeXmlText,
    findPath,
    findPaths,
    findTarget,
    firstChild,
    getAttribute,
    parseXml,
    projectTargets,
    targetNameOf,
    textOf,
    updateProjectXml
} from '../project/uvXml';

const FIXTURE_DIR = path.resolve(__dirname, '../../../src/test/fixtures');

function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function listFixtures(): string[] {
    return fs.readdirSync(FIXTURE_DIR).filter((name) => /\.uv(proj|projx|opt|optx)$/i.test(name)).sort();
}

describe('uvXml', () => {
    it('round-trips every fixture byte for byte', () => {
        const fixtures = listFixtures();
        assert.ok(fixtures.length >= 6, `expected at least 6 fixtures, found ${fixtures.length}`);

        for (const name of fixtures) {
            const source = readFixture(name);
            const doc = parseXml(source);
            const editor = new XmlEditor(doc);
            assert.equal(editor.dirty, false);
            assert.equal(editor.apply(), source, `round-trip mismatch for ${name}`);
        }
    });

    it('round-trips real Keil projects when a local corpus is available', () => {
        const corpusDir = process.env.KEIL_CORPUS_DIR || 'E:\\APP\\Keil';
        if (!fs.existsSync(corpusDir)) {
            return;
        }
        const sample = path.join(corpusDir, 'ARM', 'Flash', '_Template', 'NewDevice.uvprojx');
        if (!fs.existsSync(sample)) {
            return;
        }
        const source = fs.readFileSync(sample, 'utf8');
        assert.equal(new XmlEditor(parseXml(source)).apply(), source);
    });

    it('parses declarations, comments, CDATA and self-closing elements', () => {
        const source = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!-- a comment <with> tags -->',
            '<Root attr="1" other=\'two\'>',
            '  <Empty/>',
            '  <EmptyWithSpace   />',
            '  <Data><![CDATA[raw <&> text]]></Data>',
            '  <Text>a &amp; b &lt; c</Text>',
            '</Root>'
        ].join('\r\n');

        const doc = parseXml(source);
        assert.equal(doc.root.name, 'Root');
        assert.equal(getAttribute(doc.root, 'attr'), '1');
        assert.equal(getAttribute(doc.root, 'other'), 'two');

        const empty = firstChild(doc.root, 'Empty');
        assert.ok(empty);
        assert.equal(empty!.selfClosing, true);
        assert.equal(textOf(empty!), '');

        const text = firstChild(doc.root, 'Text');
        assert.ok(text);
        assert.equal(textOf(text!), 'a & b < c');
        assert.equal(new XmlEditor(doc).apply(), source);
    });

    it('decodes and escapes XML entities', () => {
        assert.equal(decodeXmlText('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;'), `a & b <c> "d" 'e'`);
        assert.equal(decodeXmlText('&#65;&#x42;'), 'AB');
        assert.equal(decodeXmlText('&unknown;'), '&unknown;');
        assert.equal(escapeXmlText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
    });

    it('updates only the addressed leaf text', () => {
        const source = readFixture('arm-ac6.uvprojx');
        const doc = parseXml(source);
        const target = findTarget(doc.root, 'Demo_Debug');
        assert.ok(target);

        const editor = new XmlEditor(doc);
        const outcome: ApplyOutcome = editor.setTextAt(target!, ['TargetOption', 'TargetArmAds', 'Cads', 'Optim'], '2');
        assert.equal(outcome, 'updated');

        const next = editor.apply();
        const nextDoc = parseXml(next);
        const nextTarget = findTarget(nextDoc.root, 'Demo_Debug');
        assert.ok(nextTarget);
        assert.equal(
            findPath(nextTarget!, ['TargetOption', 'TargetArmAds', 'Cads', 'Optim'])!.children.length,
            0
        );
        assert.equal(textOf(findPath(nextTarget!, ['TargetOption', 'TargetArmAds', 'Cads', 'Optim'])!), '2');

        // The sibling target must stay untouched.
        const release = findTarget(nextDoc.root, 'Demo_Release');
        assert.ok(release);
        assert.equal(textOf(findPath(release!, ['TargetOption', 'TargetArmAds', 'Cads', 'Optim'])!), '3');

        // Only one line should differ.
        const before = source.split(/\r?\n/);
        const after = next.split(/\r?\n/);
        assert.equal(after.length, before.length);
        const differing = before.filter((line, index) => line !== after[index]).length;
        assert.equal(differing, 1);
    });

    it('reports unchanged without producing edits', () => {
        const source = readFixture('arm-ac6.uvprojx');
        const doc = parseXml(source);
        const target = findTarget(doc.root, 'Demo_Debug')!;
        const editor = new XmlEditor(doc);

        assert.equal(
            editor.setTextAt(target, ['TargetOption', 'TargetArmCommonMissing', 'Device'], 'x'),
            'created'
        );
        const created = editor.apply();
        assert.ok(created.indexOf('<TargetArmCommonMissing>') !== -1);

        const secondDoc = parseXml(readFixture('arm-ac6.uvprojx'));
        const secondTarget = findTarget(secondDoc.root, 'Demo_Debug')!;
        const secondEditor = new XmlEditor(secondDoc);
        assert.equal(
            secondEditor.setTextAt(secondTarget, ['TargetOption', 'TargetCommonOption', 'Device'], 'STM32F407VGTx'),
            'unchanged'
        );
        assert.equal(secondEditor.dirty, false);
        assert.equal(secondEditor.apply(), readFixture('arm-ac6.uvprojx'));
    });

    it('creates missing nested elements with matching indentation', () => {
        const source = readFixture('arm-ac6.uvprojx');
        const doc = parseXml(source);
        const target = findTarget(doc.root, 'Demo_Debug')!;
        const editor = new XmlEditor(doc);

        const outcome = editor.setTextAt(
            target,
            ['TargetOption', 'DebugOption', 'SimDlls', 'InitializationFile'],
            '.\\Debug.ini'
        );
        assert.equal(outcome, 'created');

        const next = editor.apply();
        const nextDoc = parseXml(next);
        const nextTarget = findTarget(nextDoc.root, 'Demo_Debug')!;
        assert.equal(
            textOf(findPath(nextTarget, ['TargetOption', 'DebugOption', 'SimDlls', 'InitializationFile'])!),
            '.\\Debug.ini'
        );
        // New container content must be indented consistently.
        assert.ok(next.indexOf('\n          <SimDlls>\n            <InitializationFile>.\\Debug.ini</InitializationFile>\n          </SimDlls>') !== -1);
    });

    it('inserts children into self-closing, inline-empty and multi-line containers', () => {
        const source = [
            '<Project>',
            '  <SelfClosing/>',
            '  <Inline></Inline>',
            '  <Multi>',
            '    <Existing>1</Existing>',
            '  </Multi>',
            '</Project>'
        ].join('\n');
        const doc = parseXml(source);
        const editor = new XmlEditor(doc);

        editor.appendChild(firstChild(doc.root, 'SelfClosing')!, '    <Added>1</Added>');
        editor.appendChild(firstChild(doc.root, 'Inline')!, '    <Added>2</Added>');
        editor.appendChild(firstChild(doc.root, 'Multi')!, '    <Added>3</Added>');

        const next = editor.apply();
        const reparsed = parseXml(next);
        assert.equal(textOf(firstChild(firstChild(reparsed.root, 'SelfClosing')!, 'Added')!), '1');
        assert.equal(textOf(firstChild(firstChild(reparsed.root, 'Inline')!, 'Added')!), '2');
        const multiChildren = firstChild(reparsed.root, 'Multi')!.children.map((child) => child.name);
        assert.deepEqual(multiChildren, ['Existing', 'Added']);
        assert.ok(next.indexOf('  <SelfClosing>\n    <Added>1</Added>\n  </SelfClosing>') !== -1);
        assert.ok(next.indexOf('  <Inline>\n    <Added>2</Added>\n  </Inline>') !== -1);
    });

    it('removes elements together with their own line', () => {
        const source = [
            '<Project>',
            '  <Groups>',
            '    <Group>',
            '      <GroupName>A</GroupName>',
            '    </Group>',
            '    <Group>',
            '      <GroupName>B</GroupName>',
            '    </Group>',
            '  </Groups>',
            '</Project>'
        ].join('\n');
        const doc = parseXml(source);
        const groups = findPath(doc.root, ['Groups'])!;
        const editors = new XmlEditor(doc);

        assert.equal(editors.removeAt(groups, ['Group']), true);
        const next = editors.apply();
        assert.ok(next.indexOf('A') === -1, 'first group should be removed');
        assert.ok(next.indexOf('B') !== -1, 'second group should remain');
        assert.equal(next.split('\n').length, source.split('\n').length - 3);
        assert.ok(next.indexOf('\n\n') === -1, 'no blank line should be left behind');
    });

    it('applies multiple edits including inserts at the same offset', () => {
        const source = '<Project>\n  <List>\n  </List>\n</Project>\n';
        const doc = parseXml(source);
        const list = findPath(doc.root, ['List'])!;
        const editor = new XmlEditor(doc);
        editor.appendChild(list, '    <A>1</A>');
        editor.appendChild(list, '    <B>2</B>');
        const next = editor.apply();
        assert.equal(next, '<Project>\n  <List>\n    <A>1</A>\n    <B>2</B>\n  </List>\n</Project>\n');
    });

    it('detects indentation units', () => {
        assert.equal(detectIndentUnit('<A>\n  <B>\n    <C>1</C>\n  </B>\n</A>'), '  ');
        assert.equal(detectIndentUnit('<A>\n\t<B>\n\t\t<C>1</C>\n\t</B>\n</A>'), '\t');
        assert.equal(detectIndentUnit('<A><B>1</B></A>'), '  ');
    });

    it('throws on structurally broken markup', () => {
        assert.throws(() => parseXml(''), /empty document/);
        assert.throws(() => parseXml('<A><B></A></B>'), /mismatched end tag/);
        assert.throws(() => parseXml('<A><B></B>'), /unclosed element/);
        assert.throws(() => parseXml('<A></A><B></B>'), /multiple root elements/);
    });

    it('lists targets and resolves target names', () => {
        const doc = parseXml(readFixture('c51.uvproj'));
        const targets = projectTargets(doc.root);
        assert.deepEqual(targets.map(targetNameOf), ['C51_Debug', 'C51_Release']);
        assert.ok(findTarget(doc.root, 'C51_Release'));
        assert.equal(findTarget(doc.root, 'missing'), undefined);
    });

    it('finds repeated child elements via findPaths', () => {
        const doc = parseXml(readFixture('arm-ac6.uvprojx'));
        const groups = findPaths(doc.root, ['Targets', 'Target', 'Groups', 'Group']);
        assert.equal(groups.length, 8);
    });

    it('builds well-formed fragments', () => {
        assert.equal(buildLeafElement('Name', 'a & b', '  '), '  <Name>a &amp; b</Name>');
        assert.equal(
            buildContainerElement('Group', ['    <GroupName>A</GroupName>'], '  ', '  '),
            '  <Group>\n    <GroupName>A</GroupName>\n  </Group>'
        );
    });

    it('supports updateProjectXml convenience wrapper', () => {
        const source = '<Project>\n  <SchemaVersion>2.1</SchemaVersion>\n</Project>\n';
        const next = updateProjectXml(source, (editor, root) => {
            editor.setTextAt(root, ['SchemaVersion'], '1.1');
        });
        assert.equal(next, '<Project>\n  <SchemaVersion>1.1</SchemaVersion>\n</Project>\n');
    });
});
