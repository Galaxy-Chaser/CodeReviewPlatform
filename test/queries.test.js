const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../lib/report-store');
const { options, compactState, historyPage, issuePage, matchingIssues } = require('../lib/queries');

/** Representative archive retains details outside the metadata index, including a much older latest project. */
function archive() {
  const reports = new Map();
  const state = { projects: [{ id: 'a', baselineId: 'scan-500' }, { id: 'b' }], settings: {}, scans: [], githubReviews: [] };
  for (let i = 0; i < 600; i++) {
    const report = { id: `scan-${i}`, projectId: i === 599 ? 'b' : 'a', startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 600 - i)).toISOString(), status: 'completed', scope: 'project', mode: 'local',
      gate: { status: 'FAILED' }, logs: 'large history log '.repeat(500), issues: Array.from({ length: 65 }, (_, n) => ({ severity: n % 2 ? 'LOW' : 'HIGH', rule: 'todo', message: 'Finding', file: 'A.java', line: n + 1, excerpt: `Evidence ${n}` })) };
    reports.set(report.id, report); state.scans.push(summarize(report));
  }
  const partial = { ...reports.get('scan-0'), id: 'partial', scope: 'changed', issues: [{ severity: 'HIGH', message: 'partial only', file: 'A.java', line: 1 }] };
  reports.set(partial.id, partial); state.scans.unshift(summarize(partial));
  const loaded = [], load = async id => { loaded.push(id); return reports.get(id); };
  return { state, reports, load, loaded };
}

test('dashboard snapshot is bounded, keeps old latest reports and baselines, and contains no details', () => {
  const { state } = archive();
  const view = compactState(state);
  assert.ok(view.scans.length < 50);
  assert.equal(view.stats.scans, 601); assert.equal(view.stats.issues, 130); assert.equal(view.stats.highRisk, 66);
  assert.ok(view.scans.some(s => s.id === 'scan-599'));
  assert.ok(view.scans.some(s => s.id === 'scan-500'));
  assert.equal(view.projectIssues, undefined);
  assert.ok(view.scans.every(s => s.issues === undefined && s.logs === undefined));
});

test('server issue pages count all latest matches while loading only selected whole-project reports', async () => {
  const f = archive();
  const first = await issuePage(f.state, f.load, options({ limit: 25 }));
  assert.equal(first.total, 130); assert.equal(first.rows.length, 25);
  assert.deepEqual(f.loaded, ['scan-0', 'scan-599']);
  const second = await issuePage(f.state, f.load, options({ offset: 25, limit: 25 }));
  assert.equal(second.rows[0].line, 26);
  assert.ok(!second.rows.some(i => i.message === 'partial only'));
  f.loaded.length = 0;
  const selected = await issuePage(f.state, f.load, options({ projectId: 'b', severity: 'HIGH', search: 'Evidence 64' }));
  assert.equal(selected.total, 1); assert.equal(selected.rows[0].line, 65);
  assert.deepEqual(f.loaded, ['scan-599']);
});

test('page boundary clamping and export iteration preserve every matching issue in the same order', async () => {
  const f = archive();
  const full = [];
  for await (const row of matchingIssues(f.state, f.load, options({ projectId: 'a', severity: 'HIGH' }))) full.push(row);
  assert.equal(full.length, 33);
  const pages = [];
  for (const offset of [0, 25]) pages.push(...(await issuePage(f.state, f.load, options({ projectId: 'a', severity: 'HIGH', offset }))).rows);
  assert.deepEqual(pages, full);
  const last = await issuePage(f.state, f.load, options({ projectId: 'a', severity: 'HIGH', offset: 999 }));
  assert.equal(last.offset, 25); assert.deepEqual(last.rows, full.slice(25));
  const empty = await issuePage(f.state, f.load, options({ search: 'does not exist', offset: 999 }));
  assert.equal(empty.offset, 0); assert.deepEqual(empty.rows, []);
});

test('history queries support complete archive pages and explicit scope/status filters', () => {
  const f = archive();
  const first = historyPage(f.state, options({}));
  assert.equal(first.total, 601); assert.equal(first.rows.length, 25);
  const last = historyPage(f.state, options({ offset: 9999 }));
  assert.equal(last.offset, 600); assert.equal(last.rows[0].id, 'scan-599');
  assert.equal(historyPage(f.state, options({ mode: 'changed' })).total, 1);
  assert.equal(historyPage(f.state, options({ mode: 'local' })).total, 600);
  assert.equal(historyPage(f.state, options({ status: 'failed' })).total, 0);
  assert.equal(historyPage(f.state, options({ projectId: 'b' })).rows[0].id, 'scan-599');
  assert.throws(() => historyPage(f.state, options({}), 'invalid'));
});

test('malformed query options fail explicitly instead of producing empty or misleading pages', () => {
  for (const input of [{ limit: 0 }, { offset: -1 }, { offset: '1e3' }, { limit: 101 }, { severity: 'unknown' }, { status: 'success' }, { mode: 'maybe' }, { search: 'x'.repeat(501) }]) assert.throws(() => options(input));
});
