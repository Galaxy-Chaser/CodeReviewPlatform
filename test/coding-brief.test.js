const test = require('node:test');
const assert = require('node:assert/strict');
const { fields, validateBrief, briefStatus, briefMarkdown } = require('../lib/coding-brief');
const { checklist, reviewReadiness } = require('../lib/acceptance');
const draft = () => Object.fromEntries(fields.map(f => [f.id, '']));

test('task requirements distinguish saved drafts from complete plans and reject unbounded or non-text values', () => {
  const incomplete = validateBrief(draft());
  assert.equal(briefStatus(incomplete).ready, false);
  assert.equal(briefStatus(incomplete).missing.length, 4);
  const complete = validateBrief(Object.fromEntries(fields.map(f => [f.id, '  representative task text  '])));
  assert.equal(complete.goal, 'representative task text');
  assert.deepEqual(briefStatus(complete), { ready: true, missing: [] });
  for (const value of [null, [], { ...draft(), goal: null }, { ...draft(), tests: 'x'.repeat(3001) }]) assert.throws(() => validateBrief(value));
});

test('portable instructions preserve multiline requirements and never claim that a plan proves tests passed', () => {
  const markdown = briefMarkdown({ name: 'QA project' }, { ...draft(), id: 'exact-version', updatedAt: 'saved-time', goal: 'First line\n# second line' });
  assert.match(markdown, /exact-version/); assert.match(markdown, /> First line\n> # second line/);
  assert.match(markdown, /草稿，缺少/); assert.match(markdown, /未运行的测试必须明确标为未运行/);
});

test('review gaps retain automatic blockers despite all human boxes being checked and explain partial coverage', () => {
  const acceptance = Object.fromEntries(checklist.map(c => [c.id, { checked: true, evidence: 'Representative manually reviewed evidence' }]));
  const report = { status: 'completed', mode: 'local', scope: 'changed', gate: { status: 'FAILED' }, acceptance };
  const blocked = reviewReadiness(report);
  assert.equal(blocked.status, 'BLOCKED'); assert.equal(blocked.missing.length, 0); assert.equal(blocked.blockers.length, 1);
  assert.ok(blocked.limits.some(x => x.includes('没有执行编译')));
  assert.ok(blocked.limits.some(x => x.includes('仅检查改动')));
  assert.ok(blocked.limits.some(x => x.includes('未绑定')));
  assert.equal(reviewReadiness({ ...report, gate: { status: 'UNKNOWN' } }).status, 'BLOCKED');
  const pending = reviewReadiness({ ...report, gate: { status: 'PASSED' }, acceptance: {}, codingBrief: draft() });
  assert.equal(pending.status, 'PENDING'); assert.equal(pending.missing.length, 5);
  assert.ok(pending.limits.some(x => x.includes('草稿')));
  const reviewed = reviewReadiness({ ...report, gate: { status: 'PASSED' } });
  assert.equal(reviewed.status, 'REVIEWED'); assert.ok(reviewed.limits.some(x => x.includes('没有执行编译')));
});
