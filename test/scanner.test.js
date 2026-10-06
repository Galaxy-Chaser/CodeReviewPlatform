const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanLocal, lineIndex, limits } = require('../lib/rules');
const { scanInWorker } = require('../lib/scanner');
const { compareScans } = require('../lib/reports');

/** Create independent static source; no generated Java is ever executed. */
async function fixture(t, text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-large-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'Large.java'), text);
  return root;
}

test('indexed locations preserve CRLF, Unicode, multiline catches and one TODO per line', async t => {
  const source = '// 中文 TODO FIXME\r\nclass A {\r\n void x() { try {} catch (Exception e) {\r\n } System.out.println("private"); }\r\n}\r\n';
  const root = await fixture(t, source), result = await scanLocal(root);
  assert.equal(result.lines, 6);
  assert.deepEqual(result.issues.map(i => [i.rule, i.line, i.endLine]), [['empty-catch', 3, 4], ['debug-output', 4, 4], ['todo', 1, undefined]]);
  const index = lineIndex(source);
  for (let offset = 0; offset <= source.length; offset++) assert.equal(index.line(offset), source.slice(0, offset).split('\n').length);
});

test('evidence is bounded and credentials at a truncated string boundary stay masked', async t => {
  const source = 'class A { String password = "' + 'sensitive'.repeat(400) + '"; // TODO\n}';
  const result = await scanLocal(await fixture(t, source));
  assert.equal(result.issues.length, 2);
  for (const issue of result.issues) {
    assert.ok(issue.excerpt.length <= limits.evidenceCharacters);
    assert.ok(!issue.excerpt.includes('sensitive'));
    assert.match(issue.excerpt, /REDACTED/);
  }
});

test('finding limits fail explicitly, and disabled rules do not consume the limit', async t => {
  const root = await fixture(t, 'class A {}\n' + '// TODO\n'.repeat(limits.findings + 1));
  await assert.rejects(scanInWorker(root, ['todo']), /超过 10,000.*未完成/);
  assert.equal((await scanInWorker(root, ['empty-catch'])).issues.length, 0);
});

test('oversized files fail without a truncated success report', async t => {
  const root = await fixture(t, ' '.repeat(limits.fileBytes + 1));
  await assert.rejects(scanInWorker(root), /源文件过大.*未完成/);
});

test('worker findings match engine findings and parent timers run during a dense scan', async t => {
  const root = await fixture(t, 'class A { void a() {\n' + 'System.out.println("test");\n'.repeat(8000) + '} }\n');
  let ticks = 0; const timer = setInterval(() => { ticks++; }, 1); t.after(() => clearInterval(timer));
  const progress = [];
  const result = await scanInWorker(root, ['debug-output'], { onProgress: p => progress.push(p) });
  clearInterval(timer);
  assert.ok(ticks > 5, 'parent timers must remain responsive while rules execute');
  assert.equal(result.issues.length, 8000); assert.equal(result.issues.at(-1).line, 8001);
  assert.deepEqual(progress, [{ completed: 0, total: 1 }, { completed: 1, total: 1 }]);
  assert.deepEqual(result, await scanLocal(root, ['debug-output']));
});

test('stop and timeout release a worker and permit a subsequent real scan', async t => {
  const root = await fixture(t, 'class A {}\n' + ' '.repeat(3 * 1024 * 1024));
  const controller = new AbortController();
  await assert.rejects(scanInWorker(root, undefined, { signal: controller.signal, onProgress: () => controller.abort() }), /已停止.*未完成/);
  await assert.rejects(scanInWorker(root, undefined, { timeoutMs: 1 }), /超过.*未完成/);
  await assert.rejects(scanInWorker(root, undefined, { signal: controller.signal }), /已停止/);
  assert.equal((await scanInWorker(path.join(__dirname, '../examples/java8-fixture'))).issues.length, 5);
});

test('changed evidence format cannot be presented as fixes against a previous engine baseline', () => {
  const older = { id: 'a', projectId: 'project', mode: 'local', scope: 'project', status: 'completed', issues: [], settings: { enabledRules: ['todo'] } };
  assert.equal(compareScans({ ...older, id: 'b', settings: { ...older.settings, localRuleVersion: 2 } }, older).available, false);
});
