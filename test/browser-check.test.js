const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { completeBrowserReport, browserCheckView } = require('../lib/browser-check');
const { scenarios } = require('../scripts/check-browser');
const { sourceSnapshot } = require('../lib/source-snapshot');
const { createBackup, restoreBackup } = require('../lib/backup');

test('a partial browser run, repeated rows and later source edits cannot masquerade as a complete pass', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-browser-proof-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app.js'), 'original');
  const r = { kind: 'browser', status: 'PASSED', sourceCheck: { status: 'CURRENT' }, sourceSnapshot: await sourceSnapshot(root), scenarios: scenarios.map(([id, name]) => ({ id, name, status: 'PASSED' })) };
  assert.equal(completeBrowserReport(r), true); assert.equal((await browserCheckView(root, r)).status, 'PASSED');
  for (const rows of [r.scenarios.slice(1), r.scenarios.map((s, i) => i ? s : { ...s, status: 'NOT_RUN' }), [...r.scenarios.slice(1), r.scenarios[1]]]) {
    assert.equal(completeBrowserReport({ ...r, scenarios: rows }), false); assert.equal((await browserCheckView(root, { ...r, scenarios: rows })).status, 'FAILED');
  }
  await fs.writeFile(path.join(root, 'app.js'), 'changed'); assert.equal((await browserCheckView(root, r)).status, 'STALE');
});

test('browser report and screenshot survive backup; missing referenced pictures prevent claiming a complete backup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-browser-backup-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); await fs.mkdir(path.join(data, 'reports'), { recursive: true });
  const id = crypto.randomUUID(), image = `browser-${id}-project.png`, file = `report-${id}.json`;
  const state = { storageVersion: 1, projects: [], scans: [], githubReviews: [], browserCheckId: id, settings: { sonarUrl: 'http://127.0.0.1:9000', java8Home: '', java21Home: '', enabledRules: [], gate: { coverage: 60, duplication: 5 } } };
  await fs.writeFile(path.join(data, 'state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(data, 'reports', file), JSON.stringify({ id, kind: 'browser', status: 'FAILED', images: [image] }));
  await fs.writeFile(path.join(data, 'reports', image), Buffer.from([137, 80, 78, 71]));
  const backup = await createBackup(data, state), restored = path.join(root, 'restored'); await restoreBackup(path.join(data, 'backups', backup.file), restored);
  assert.deepEqual(await fs.readFile(path.join(restored, 'reports', image)), Buffer.from([137, 80, 78, 71]));
  await fs.unlink(path.join(data, 'reports', image)); await assert.rejects(createBackup(data, state), /ENOENT/);
});
