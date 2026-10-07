const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findingSummary, findingFilters } = require('../lib/finding-view');
const { repairTasks, repairTaskPage } = require('../lib/reports');

test('summary counts every original risk and review state, distinguishes partial/unknown records and stays bounded', () => {
  const severities = ['BLOCKER', 'CRITICAL', 'HIGH', 'MAJOR', 'MEDIUM', 'MINOR', 'LOW', 'INFO', '__proto__'];
  const reviews = [undefined, 'confirmed', 'fixing', 'dismissed', 'future'];
  const report = { status: 'completed', gate: { status: 'FAILED' }, issues: severities.map((severity, n) => ({ severity, file: n ? 'B.java' : 'A.java',
    message: 'PRIVATE BODY', excerpt: 'PRIVATE SOURCE', review: reviews[n % 5] ? { status: reviews[n % 5], reason: 'PRIVATE REASON', history: ['PRIVATE HISTORY'] } : undefined })) };
  const before = JSON.stringify(report), summary = findingSummary(report);
  assert.deepEqual(summary.risk, { high: 3, medium: 2, low: 3, unknown: 1 });
  assert.deepEqual(summary.review, { open: 2, confirmed: 2, fixing: 2, dismissed: 2, unknown: 1 });
  assert.equal(summary.total, 9); assert.equal(summary.files, 2); assert.equal(summary.complete, true);
  assert.ok(!JSON.stringify(summary).includes('PRIVATE')); assert.ok(!JSON.stringify(summary).includes('.java'));
  for (const status of ['running', 'failed']) assert.equal(findingSummary({ ...report, status }).complete, false);
  assert.deepEqual(findingSummary({ issueCount: 10, status: 'completed' }), { available: false, complete: false });
  const missing = findingSummary({ ...report, issues: [{ severity: 'HIGH' }] }); assert.equal(missing.files, 0); assert.equal(missing.missingFiles, 1);
  const large = findingSummary({ ...report, issues: Array(20000).fill(report.issues[0]) }); assert.equal(large.total, 20000); assert.ok(JSON.stringify(large).length < 400);
  assert.equal(findingSummary({ status: 'completed', issues: [] }).total, 0);
  assert.equal(JSON.stringify(report), before);
});

test('combined risk/review pages retain complete report numbering, duplicates and original decisions', () => {
  const severities = ['HIGH', 'MAJOR', 'INFO', '__proto__'], reviews = ['open', 'confirmed', 'fixing', 'dismissed', 'unknown'];
  const report = { status: 'completed', gate: { status: 'FAILED' }, sonarGate: { status: 'OK' }, issues: Array.from({ length: 123 }, (_, n) => ({
    severity: severities[n % 4], file: `src/${n % 3}.java`, line: n + 1, rule: 'empty-catch', message: 'Finding', trackingId: String(n), review: { status: reviews[n % 5] } })) };
  const original = JSON.stringify(report), all = repairTasks(report);
  for (const risk of ['all', 'high', 'medium', 'low']) for (const review of ['all', 'active', 'open', 'confirmed', 'fixing', 'dismissed']) {
    const expected = all.filter(issue => (risk === 'all' || issue.severity === { high: 'HIGH', medium: 'MAJOR', low: 'INFO' }[risk]) &&
      (review === 'all' || (review === 'active' ? issue.review.status !== 'dismissed' : issue.review.status === review)));
    const actual = [];
    for (let offset = 0; offset < Math.max(1, expected.length); offset += 25) {
      const page = repairTaskPage(report, offset, { risk, review });
      assert.equal(page.total, expected.length); assert.equal(page.summary.total, 123); assert.ok(page.tasks.length <= 25);
      actual.push(...page.tasks);
    }
    assert.deepEqual(actual, expected);
  }
  assert.equal(JSON.stringify(report), original);
});

test('a shrinking filtered last page returns to available work without treating zero matches as zero findings', () => {
  const report = { status: 'completed', gate: { status: 'FAILED' }, issues: Array.from({ length: 62 }, (_, n) => ({ severity: 'HIGH', file: 'A.java', rule: 'empty-catch', message: 'Duplicate finding', trackingId: String(n) })) };
  assert.equal(repairTaskPage(report, 50, { review: 'open' }).tasks[0].number, 51);
  for (const issue of report.issues.slice(50)) issue.review = { status: 'dismissed' };
  const page = repairTaskPage(report, 50, { review: 'open' });
  assert.equal(page.offset, 25); assert.equal(page.total, 50); assert.equal(page.tasks[0].number, 26); assert.equal(page.tasks.at(-1).number, 50);
  for (const issue of report.issues) issue.review = { status: 'dismissed' };
  const empty = repairTaskPage(report, 50, { review: 'active' });
  assert.equal(empty.offset, 0); assert.equal(empty.total, 0); assert.equal(empty.tasks.length, 0);
  assert.equal(empty.summary.total, 62); assert.equal(empty.summary.risk.high, 62); assert.equal(report.gate.status, 'FAILED');
  assert.equal(repairTasks(report).length, 62);
});

test('focus filters reject ambiguous, unknown or malformed inputs', () => {
  assert.deepEqual(findingFilters(), { risk: 'all', review: 'all' });
  for (const value of [null, [], 'all', { extra: 'x' }, { risk: '' }, { risk: 'HIGH' }, { risk: 1 }, { review: '' }, { review: 'unknown' }, { review: null }]) assert.throws(() => findingFilters(value));
});
