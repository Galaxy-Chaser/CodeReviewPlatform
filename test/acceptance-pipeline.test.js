const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { template, validatePlan, setCaseResult, pipelineGaps, evaluatePipeline, planMarkdown } = require('../lib/acceptance-pipeline');
const { acceptanceStatus, checklist } = require('../lib/acceptance');
const { summarize } = require('../lib/report-store');

test('acceptance badges cannot bypass pending or failed scenarios when human boxes are checked', () => {
  const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const code = source.slice(source.indexOf('function acceptanceBadge('), source.indexOf('/** A read-only PR workflow'));
  const context = { state: { checklist } }; vm.createContext(context); vm.runInContext(code, context);
  const r = fixture(false); r.acceptanceStatus = 'PENDING';
  assert.match(context.acceptanceBadge(r), /等待场景与人工验收/);
  r.acceptanceStatus = 'REVIEWED'; r.readiness = { status: 'BLOCKED' };
  assert.match(context.acceptanceBadge(r), /验收受阻/); assert.doesNotMatch(context.acceptanceBadge(r), /人工验收已记录/);
  delete r.readiness; assert.match(context.acceptanceBadge(r), /人工验收已记录/);
});

/** 创建代表性完整报告；自动证据为逻辑测试数据，不声称本机运行过 Maven。 */
function fixture(full = true) {
  const plan = { ...template(), id: crypto.randomUUID(), confirmed: true, requireFull: full, requireBrief: false, minTests: full ? 2 : 0,
    cases: template().cases.slice(0, 2) };
  return { id: crypto.randomUUID(), projectId: crypto.randomUUID(), startedAt: '2026-10-06T00:00:00Z', mode: full ? 'full' : 'local', scope: 'project', status: 'completed', localCompleted: true,
    preflight: { ready: true }, issues: [], gate: { status: 'PASSED', checks: [] }, sourceSnapshot: { digest: 'original' },
    build: full ? { status: 'completed' } : undefined, buildTests: full ? { available: true, executed: 2, skipped: 0, failures: 0, errors: 0 } : undefined,
    acceptancePipeline: { plan, results: {} }, acceptanceSourceCheck: { status: 'CURRENT', digest: 'original' },
    acceptance: Object.fromEntries(checklist.map(c => [c.id, { checked: true, evidence: '代表性验收证据，仅验证平台逻辑' }])) };
}
const current = { status: 'CURRENT', digest: 'original', checkedAt: '2026-10-06T01:00:00Z', reason: '纳入范围的代码与报告一致' };
const passed = { status: 'passed', actual: '实际结果符合明确的业务预期', evidence: '在隔离环境执行指定输入并核对结果' };
function fill(report) { for (const c of report.acceptancePipeline.plan.cases) setCaseResult(report, c.id, passed, current); return report; }

test('template covers thirty cases across eight categories, while malformed plans and unbounded payloads are rejected', () => {
  const p = template(); assert.equal(p.cases.length, 30); assert.equal(new Set(p.cases.map(c => c.category)).size, 8); assert.equal(p.confirmed, false);
  assert.equal(validatePlan(p).cases.length, 30);
  for (const changed of [null, { ...p, cases: [] }, { ...p, cases: [...p.cases, p.cases[0]] }, { ...p, requireFull: false }, { ...p, minTests: -1 }, { ...p, cases: p.cases.map(c => ({ ...c, required: false })) }, { ...p, cases: [{ ...p.cases[0], id: '../outside' }] }, { ...p, cases: [{ ...p.cases[0], expected: '' }] }]) assert.throws(() => validatePlan(changed));
  assert.throws(() => validatePlan({ ...p, cases: p.cases.map(c => ({ ...c, input: '中'.repeat(1000), steps: '文'.repeat(1000), expected: '字'.repeat(1000) })) }), /48 KB/);
});

test('each scenario can block acceptance; five human boxes alone cannot prove the pipeline is complete', () => {
  const r = fixture();
  assert.equal(acceptanceStatus(r), 'PENDING'); assert.equal(pipelineGaps(r).counts.pending, 2);
  fill(r); assert.equal(acceptanceStatus(r), 'REVIEWED'); assert.equal(evaluatePipeline(r, current).status, 'READY');
  for (const c of r.acceptancePipeline.plan.cases) {
    setCaseResult(r, c.id, { ...passed, status: 'failed', actual: '实际结果与预期不符，返回了错误值' }, current);
    assert.equal(acceptanceStatus(r), 'BLOCKED'); assert.equal(evaluatePipeline(r, current).status, 'BLOCKED');
    assert.equal(r.gate.status, 'PASSED');
    setCaseResult(r, c.id, passed, current);
    assert.ok(r.acceptancePipeline.results[c.id].history.some(h => h.status === 'failed'));
  }
  assert.equal(evaluatePipeline(r, current, 'new-attempt').status, 'BLOCKED');
  assert.equal(evaluatePipeline(r, current, r.id, 'new-plan').status, 'BLOCKED');
  assert.equal(evaluatePipeline(r, { status: 'STALE', reason: '代码变化' }).status, 'BLOCKED');
  r.status = 'failed'; assert.equal(evaluatePipeline(r, current).status, 'BLOCKED');
});

test('case evidence is bounded, mandatory cases cannot be waived, and source changes invalidate declarations', () => {
  const r = fixture(false), c = r.acceptancePipeline.plan.cases[0];
  assert.throws(() => setCaseResult(r, c.id, { ...passed, status: 'notApplicable' }, current));
  assert.throws(() => setCaseResult(r, c.id, { ...passed, evidence: 'short' }, current));
  assert.throws(() => setCaseResult(r, c.id, { ...passed, actual: 'x'.repeat(1001) }, current));
  assert.throws(() => setCaseResult(r, 'unknown', passed, current));
  setCaseResult(r, c.id, passed, { status: 'STALE', digest: 'different', checkedAt: current.checkedAt });
  assert.equal(pipelineGaps(r).counts.invalid, 1);
  assert.equal(evaluatePipeline(r, current).status, 'PENDING');
  r.acceptancePipeline.plan.cases[1].required = false;
  setCaseResult(r, r.acceptancePipeline.plan.cases[1].id, { ...passed, status: 'notApplicable', actual: '此项目没有相应业务分支，说明不适用理由' }, current);
  assert.equal(pipelineGaps(r).counts.notApplicable, 1);
  setCaseResult(r, c.id, passed, current); assert.equal(evaluatePipeline(r, current).status, 'READY');
  setCaseResult(r, c.id, { status: 'pending', actual: '', evidence: '' }, current);
  assert.equal(evaluatePipeline(r, current).status, 'PENDING'); assert.equal(r.acceptancePipeline.results[c.id].origin, 'human');
});

test('full pipeline requires current automatic test data and obeys failures, minima, skipped cases and task requirements', () => {
  const r = fill(fixture());
  const examples = [
    { mode: 'local' }, { scope: 'changed' }, { buildTests: undefined },
    { buildTests: { available: false, reason: '没有新报告' } },
    { buildTests: { ...r.buildTests, executed: 1 } },
    { buildTests: { ...r.buildTests, failures: 1 } },
    { buildTests: { ...r.buildTests, errors: 1 } }, { gate: { status: 'UNKNOWN' } }
  ];
  for (const example of examples) assert.equal(evaluatePipeline({ ...r, ...example }, current).status, 'BLOCKED');
  r.acceptancePipeline.plan.noSkipped = true; r.buildTests.skipped = 1;
  assert.equal(evaluatePipeline(r, current).status, 'BLOCKED');
  r.buildTests.skipped = 0; r.acceptancePipeline.plan.requireBrief = true;
  assert.equal(evaluatePipeline(r, current).status, 'BLOCKED');
  r.codingBrief = { goal: '目标', scope: '范围', acceptance: '场景', tests: '测试计划' };
  assert.equal(evaluatePipeline(r, current).status, 'READY');
  r.acceptancePipeline.plan.confirmed = false; assert.equal(acceptanceStatus(r), 'BLOCKED');
});

test('pipeline exports preserve fixed requirements and failed evidence, while resident summaries omit all detailed inputs', () => {
  const r = fixture(false);
  setCaseResult(r, r.acceptancePipeline.plan.cases[0].id, { ...passed, status: 'failed' }, current);
  const summary = summarize(r), text = planMarkdown({ name: '示例项目' }, r.acceptancePipeline.plan, r, evaluatePipeline(r, current));
  assert.equal(summary.pipelineCounts.failed, 1); assert.equal(summary.pipelinePlanId, r.acceptancePipeline.plan.id);
  assert.equal(summary.acceptancePipeline, undefined); assert.ok(!JSON.stringify(summary).includes(passed.evidence));
  assert.match(text, /来源：人工声明/); assert.match(text, /failed/); assert.match(text, /输入与前置条件/); assert.match(text, /未满足的条件/);
  assert.ok(text.includes(r.acceptancePipeline.plan.id)); assert.equal(evaluatePipeline(r, current).stages[3].status, 'NOT_REQUIRED');
  setCaseResult(r, r.acceptancePipeline.plan.cases[0].id, passed, current);
  const revised = planMarkdown({ name: '示例项目' }, r.acceptancePipeline.plan, r, evaluatePipeline(r, current));
  assert.match(revised, /历史记录：failed/); assert.match(revised, /历史验证证据/);
});
