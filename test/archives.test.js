const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ArchiveStore, archiveReports, restoreReport, archivedPage, protectionReason } = require('../lib/archives');
const { ReportStore } = require('../lib/report-store');
const { createBackup, restoreBackup } = require('../lib/backup');

/** Use actual persisted reports to verify offloading, evidence retention and backup restoration. */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-archives-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectId = randomUUID(), store = new ArchiveStore(root), details = new ReportStore(root);
  const state = { projects: [{ id: projectId, key: 'archive-test', name: '归档验证', path: root }], scans: [], githubReviews: [], archivedReports: [], settings: { sonarUrl: 'http://127.0.0.1:9000', java8Home: '', java21Home: '', enabledRules: ['todo'], gate: { coverage: 60, duplication: 5 } } };
  state.storageVersion = 1;
  for (let n = 0; n < 35; n++) state.scans.push(await details.put({ id: randomUUID(), projectId, startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 40 - n)).toISOString(), status: 'completed', scope: 'project', mode: 'local', issues: [{ severity: 'HIGH', message: '真实风险', file: 'A.java', line: 1 }], gate: { status: 'FAILED' }, logs: '中文证据' }));
  state.projects[0].baselineId = state.scans[34].id;
  return { root, state, store, details };
}

test('latest results and baselines cannot be hidden, invalid batches do not partially archive', async t => {
  const { state, store } = await fixture(t), before = JSON.stringify(state);
  assert.match(protectionReason(state, state.scans[0]), /最新/);
  assert.match(protectionReason(state, state.scans[34]), /基线/);
  await assert.rejects(archiveReports(state, [state.scans[1].id, state.scans[0].id], store), /不能归档/);
  await assert.rejects(archiveReports(state, [state.scans[1].id, state.scans[1].id], store));
  assert.equal(JSON.stringify(state), before);
  const whole = state.scans[0]; state.scans.unshift({ ...whole, id: randomUUID(), scope: 'changed' });
  assert.match(protectionReason(state, whole), /完整范围/);
  state.githubReviews = [{ id: randomUUID(), scope: 'github', repository: 'a/b', number: 1 }];
  assert.match(protectionReason(state, state.githubReviews[0]), /最新检查/);
});

test('archive pages remain bounded, preserve report bytes and restore chronological order', async t => {
  const { state, store, details } = await fixture(t), ids = state.scans.slice(1, 34).map(r => r.id);
  const bytes = await fs.readFile(details.file(ids[0]));
  const before = Buffer.byteLength(JSON.stringify(state));
  await archiveReports(state, ids, store);
  assert.equal(state.scans.length, 2); assert.equal(state.archivedReports.length, 33);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < before / 2);
  assert.deepEqual(await fs.readFile(details.file(ids[0])), bytes);
  const page = await archivedPage(state, { offset: 100, limit: 25 }, store);
  assert.equal(page.total, 33); assert.equal(page.offset, 25); assert.equal(page.rows.length, 8);
  assert.equal((await archivedPage(state, { offset: 0, limit: 25, projectId: 'missing' }, store)).total, 0);
  const latest = state.scans[0].id;
  await restoreReport(state, ids[5], store); await restoreReport(state, ids[0], store);
  assert.equal(state.scans[0].id, latest); assert.equal(state.scans[1].id, ids[0]);
  assert.equal(state.archivedReports.length, 31);
});

test('backup carries archived evidence and retired projects, restored archives remain usable', async t => {
  const { root, state, store, details } = await fixture(t), id = state.scans[1].id;
  await archiveReports(state, [id], store); state.projects[0].archivedAt = new Date().toISOString();
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(state));
  const backup = await createBackup(root, state), destination = path.join(root, 'restored');
  await restoreBackup(path.join(root, 'backups', backup.file), destination);
  const restored = JSON.parse(await fs.readFile(path.join(destination, 'state.json'), 'utf8'));
  assert.ok(restored.projects[0].archivedAt); assert.deepEqual(restored.archivedReports, [id]);
  assert.deepEqual(await new ReportStore(destination).get(id), await details.get(id));
  await restoreReport(restored, id, new ArchiveStore(destination));
  assert.equal(restored.scans[1].id, id);
});
