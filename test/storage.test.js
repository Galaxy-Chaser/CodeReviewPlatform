const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ReportStore, summarize } = require('../lib/report-store');

/** Model substantial historic findings and evidence, including baseline and interrupted scans. */
function report() {
  return { id: crypto.randomUUID(), projectId: 'project', mode: 'local', scope: 'project', status: 'completed', startedAt: new Date().toISOString(),
    gate: { status: 'FAILED' }, logs: 'build output\n'.repeat(1000), issues: Array.from({ length: 200 }, (_, i) => ({ id: String(i), file: 'A.java', line: i + 1,
      severity: 'HIGH', rule: 'empty-catch', type: 'LOCAL', message: 'Handle exception', excerpt: 'catch(Exception error) {}' })),
    settings: { enabledRules: ['empty-catch'] }, acceptance: { tests: { checked: false, evidence: 'Not yet verified' } } };
}

test('history migration retains full reports and baseline while reducing the resident index', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReportStore(root), original = Array.from({ length: 60 }, report);
  const state = { scans: structuredClone(original), githubReviews: [], projects: [{ id: 'project', baselineId: original[50].id }] };
  const before = Buffer.byteLength(JSON.stringify(state));
  await store.migrate(state);
  const after = Buffer.byteLength(JSON.stringify(state));
  assert.ok(after < before * .05, `index ${after} should be below 5% of legacy ${before}`);
  for (const i of [0, 29, 50, 59]) assert.deepEqual(await store.get(original[i].id), original[i]);
  assert.equal(state.projects[0].baselineId, original[50].id);
  assert.equal(state.scans[0].issueCount, 200);
  assert.equal(state.scans[0].severityCounts.HIGH, 200);
  assert.equal(state.scans[0].issues, undefined);
  assert.equal(state.scans[0].logs, undefined);
  assert.equal(state.scans[0].acceptance, undefined);
  // Reopening already migrated metadata must never overwrite stored details with empty issues.
  await new ReportStore(root).migrate(state);
  assert.deepEqual(await store.get(original[50].id), original[50]);
  t.diagnostic(`60 representative reports: ${before} bytes inline -> ${after} bytes indexed (${(after / before * 100).toFixed(2)}%)`);
});

test('report writes remain ordered, evidence survives reload, and unsafe IDs cannot reach disk', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReportStore(root), initial = report();
  await Promise.all([store.put(initial), store.put({ ...initial, logs: 'second version' })]);
  assert.equal((await store.get(initial.id)).logs, 'second version');
  assert.equal((await store.get(initial.id)).acceptance.tests.evidence, 'Not yet verified');
  await assert.rejects(store.get('../../state'));
  assert.throws(() => store.put({ ...initial, id: '../bad' }));
  assert.equal(summarize({ ...initial, issues: [] }).issueCount, 0);
});

test('interrupted inline and indexed scans become honest failure reports on restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ReportStore(root);
  const first = { ...report(), status: 'running' }, second = summarize({ ...report(), status: 'running', issues: [] });
  const state = { scans: [first, second], githubReviews: [] };
  await store.migrate(state);
  for (const entry of state.scans) { assert.equal(entry.status, 'failed'); assert.match((await store.get(entry.id)).error, /已中断/); }
  assert.equal((await store.get(first.id)).issues.length, 200);
});
