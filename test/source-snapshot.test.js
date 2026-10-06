const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { sourceSnapshot, compareSnapshot } = require('../lib/source-snapshot');
const { acceptanceStatus } = require('../lib/acceptance');

/** Create temporary source/configuration evidence without running project code. */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'pom.xml'), '<project/>');
  await fs.writeFile(path.join(root, 'A.java'), 'class A {}');
  return root;
}
test('fingerprints track content and paths, include configuration, exclude generated outputs and never contain source', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'application.yaml'), 'password: private-fixture-secret');
  const initial = await sourceSnapshot(root); assert.equal(initial.files.length, 3); assert.ok(!JSON.stringify(initial).includes('private-fixture-secret'));
  await fs.mkdir(path.join(root, 'target')); await fs.writeFile(path.join(root, 'target', 'Generated.java'), 'ignored');
  await fs.utimes(path.join(root, 'A.java'), new Date(), new Date());
  assert.equal(compareSnapshot(initial, await sourceSnapshot(root)).status, 'CURRENT');
  await fs.writeFile(path.join(root, 'A.java'), 'class B {}');
  await fs.rename(path.join(root, 'pom.xml'), path.join(root, 'renamed.xml'));
  const changed = compareSnapshot(initial, await sourceSnapshot(root));
  assert.equal(changed.status, 'STALE'); assert.deepEqual(changed.counts, { added: 1, removed: 1, modified: 1 });
});
test('bounded differences, missing evidence and Git base changes never report current', async t => {
  const root = await fixture(t), saved = await sourceSnapshot(root);
  assert.equal(compareSnapshot(null, saved).status, 'UNKNOWN');
  assert.equal(compareSnapshot(saved, saved, 'commit-a', 'commit-b').status, 'STALE');
  for (let n = 0; n < 40; n++) await fs.writeFile(path.join(root, `New${n}.java`), 'class New {}');
  const changes = compareSnapshot(saved, await sourceSnapshot(root));
  assert.equal(changes.counts.added, 40); assert.equal(changes.changes.length, 25);
  const report = { status: 'completed', gate: { status: 'PASSED' }, acceptanceSourceCheck: changes };
  assert.equal(acceptanceStatus(report), 'BLOCKED');
});
test('oversized files, cancellation and timeouts fail explicitly without partial successful fingerprints', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'Large.xml'), 'x'.repeat(5 * 1024 * 1024 + 1));
  await assert.rejects(sourceSnapshot(root), /5 MB/);
  await assert.rejects(sourceSnapshot(root, { signal: AbortSignal.abort() }), /停止/);
  await assert.rejects(sourceSnapshot(root, { timeoutMs: -1 }), /超时/);
});

test('web service and UI source changes invalidate current evidence; generated reports do not', async t => {
  const root = await fixture(t);
  for (const file of ['server.js', 'module.mjs', 'module.cjs', 'view.ts', 'view.tsx', 'view.jsx', 'index.html', 'theme.css']) await fs.writeFile(path.join(root, file), 'original');
  const saved = await sourceSnapshot(root);
  for (const file of ['server.js', 'module.mjs', 'module.cjs', 'view.ts', 'view.tsx', 'view.jsx', 'index.html', 'theme.css']) {
    await fs.writeFile(path.join(root, file), 'modified');
    assert.equal(compareSnapshot(saved, await sourceSnapshot(root)).status, 'STALE', file);
    await fs.writeFile(path.join(root, file), 'original');
  }
  for (const directory of ['outputs', 'dist', 'coverage']) {
    await fs.mkdir(path.join(root, directory)); await fs.writeFile(path.join(root, directory, 'result.json'), 'generated');
  }
  assert.equal(compareSnapshot(saved, await sourceSnapshot(root)).status, 'CURRENT');
  assert.equal(compareSnapshot({ ...saved, version: 1 }, await sourceSnapshot(root)).status, 'UNKNOWN');
});
