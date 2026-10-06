const { test } = require('node:test');
const assert = require('node:assert/strict');
const { identify, carryReviews, setReview } = require('../lib/issue-review');
const { readiness } = require('../lib/readiness');
const { checklist } = require('../lib/acceptance');
const { options, issuePage } = require('../lib/queries');

/** Build representative reports; content evidence and source hashes can vary independently. */
function report(id, excerpt = 'catch (Exception e) {}', hash = 'file-a') {
  return { id, projectId: 'project', status: 'completed', mode: 'local', scope: 'project',
    settings: { localRuleVersion: 3, enabledRules: ['empty-catch'] }, gate: { status: 'FAILED' },
    sourceSnapshot: { files: [{ file: 'A.java', sha256: hash }] },
    issues: [{ type: 'LOCAL', rule: 'empty-catch', file: 'A.java', line: 4, excerpt, severity: 'HIGH', message: '空异常处理' }] };
}

test('review decisions survive matching scans and shifted lines, while changed or returning findings reopen', () => {
  const a = carryReviews(report('a'), null);
  assert.throws(() => setReview(a, a.issues[0].trackingId, 'dismissed', 'short'));
  assert.throws(() => setReview(a, 'unknown', 'dismissed', '已人工核对业务异常处理'));
  setReview(a, a.issues[0].trackingId, 'dismissed', '已人工核对业务异常处理');
  assert.equal(a.gate.status, 'FAILED');
  const b = report('b', undefined, 'file-b'); b.issues[0].line = 18;
  carryReviews(b, a); assert.equal(b.issues[0].review.status, 'dismissed');
  setReview(b, b.issues[0].trackingId, 'fixing', '重新确认后安排修复此问题');
  assert.equal(b.issues[0].review.history[0].status, 'dismissed');
  const changed = carryReviews(report('c', 'catch (IOException e) {}'), b);
  assert.equal(changed.issues[0].review.status, 'open'); assert.equal(changed.issues[0].review.event, 'changed');
  assert.equal(changed.issues[0].review.prior.status, 'fixing');
  const clean = report('clean'); clean.issues = []; carryReviews(clean, b);
  const returned = carryReviews(report('returned'), clean);
  assert.equal(returned.issues[0].review.status, 'open'); assert.equal(returned.issues[0].review.event, 'returned');
  assert.equal(returned.issues[0].review.prior.reason, '重新确认后安排修复此问题');
  const again = carryReviews(report('again'), returned);
  assert.equal(again.issues[0].review.status, 'open');
  const isolated = report('isolated'); isolated.projectId = 'another'; carryReviews(isolated, a);
  assert.equal(isolated.issues[0].review, undefined);
  const upgraded = report('upgraded'); upgraded.settings.localRuleVersion = 4; carryReviews(upgraded, a);
  assert.equal(upgraded.issues[0].review, undefined);
});

test('masked evidence and ambiguous duplicates cannot reuse dismissals after content changes', () => {
  const a = report('a', 'String password = "[REDACTED]";'); a.issues[0].rule = 'hardcoded-secret';
  carryReviews(a); setReview(a, a.issues[0].trackingId, 'dismissed', '这是经过确认的示例占位符');
  const b = structuredClone(a); b.id = 'b'; b.sourceSnapshot.files[0].sha256 = 'new-secret'; delete b.issues[0].review;
  carryReviews(b, a); assert.equal(b.issues[0].review.status, 'open');
  const duplicates = report('dupes'); duplicates.issues.push({ ...duplicates.issues[0], line: 10 });
  carryReviews(duplicates); assert.notEqual(duplicates.issues[0].trackingId, duplicates.issues[1].trackingId);
  setReview(duplicates, duplicates.issues[0].trackingId, 'dismissed', '已确认第一个异常分支有效');
  const edited = report('edited', undefined, 'edited-file'); edited.issues.push({ ...edited.issues[0], line: 10 });
  carryReviews(edited, duplicates); assert.equal(edited.issues[0].review.status, 'open');
});

test('readiness uses latest attempts and fresh code evidence without changing historical acceptance', () => {
  assert.equal(readiness(null, null).status, 'NOT_CHECKED');
  const r = report('pass'); r.gate.status = 'PASSED';
  r.acceptance = Object.fromEntries(checklist.map(c => [c.id, { checked: true, evidence: '人工实际验证符合预期结果' }]));
  r.acceptanceSourceCheck = { status: 'CURRENT' };
  assert.equal(readiness(r, { status: 'CURRENT' }, r.id).status, 'READY');
  assert.equal(readiness(r, null, r.id).status, 'BLOCKED');
  assert.equal(readiness(r, { status: 'STALE', reason: '文件变化' }, r.id).status, 'BLOCKED');
  assert.equal(r.acceptanceSourceCheck.status, 'CURRENT');
  assert.equal(readiness(r, { status: 'CURRENT' }, 'new-failed').status, 'BLOCKED');
  delete r.acceptance;
  assert.equal(readiness(r, { status: 'CURRENT' }, r.id).status, 'PENDING');
  r.status = 'failed'; assert.equal(readiness(r, { status: 'CURRENT' }, r.id).status, 'BLOCKED');
  r.status = 'running'; assert.match(readiness(r, { status: 'CURRENT' }, r.id).next, /等待/);
});

test('review evidence limits reject new writes without discarding existing decisions', () => {
  const r = carryReviews(report('bounded'));
  setReview(r, r.issues[0].trackingId, 'confirmed', '原判断有明确人工验证证据');
  const original = structuredClone(r.issues[0].review);
  r.issueReviewLedger.push({ trackingId: 'large', rule: 'todo', file: 'B.java', review: { status: 'confirmed', reason: 'x'.repeat(2 * 1024 * 1024) } });
  assert.throws(() => setReview(r, r.issues[0].trackingId, 'dismissed', '另一个具有完整理由的新判断'), /2 MB/);
  assert.deepEqual(r.issues[0].review, original);
  assert.deepEqual(r.issueReviewLedger[0].review, original);
});

test('review filtering retains dismissed issues in totals and returns them only in the requested review filter', async () => {
  const r = carryReviews(report('a')); setReview(r, r.issues[0].trackingId, 'dismissed', '已人工核对业务异常处理');
  const state = { projects: [{ id: 'project' }], scans: [r] };
  assert.equal((await issuePage(state, async () => r, options())).total, 1);
  assert.equal((await issuePage(state, async () => r, options({ reviewStatus: 'dismissed' }))).total, 1);
  assert.equal((await issuePage(state, async () => r, options({ reviewStatus: 'open' }))).total, 0);
  assert.throws(() => options({ reviewStatus: 'invalid' }));
  assert.equal(identify(r)[0].review.reason, '已人工核对业务异常处理');
});
