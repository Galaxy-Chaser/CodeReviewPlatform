const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { WorkspaceStore, saveRecord, changeTask, validateDocument, activeLease, taskCoordination } = require('../lib/workspace');
const human = { type: 'human', id: '', name: '本地用户' }, agent = { type: 'agent', id: crypto.randomUUID(), name: 'fixture agent' };
const scope = () => {}, projectId = crypto.randomUUID();
function empty() { return { format: 'CodeHealthWorkspace', version: 1, revision: 0, requirements: [], tasks: [], knowledge: [] }; }
function req(doc) { return saveRecord(doc, 'requirements', { projectId, title: '异常处理', description: '保存异常分支的真实需求', criteria: '异常时保留原数据并提供清楚反馈', allowedPaths: 'src/service，禁止修改其他项目' }, human, scope); }
function task(doc, requirementId = '') { return saveRecord(doc, 'tasks', { projectId, requirementId, title: '处理异常分支', description: '实现需求并验证实际结果', criteria: '验证正常、异常和重复输入', requireReport: false }, human, scope); }
function act(doc, row, action, who = human, extra = {}, now) { return changeTask(doc, { id: row.id, expectedVersion: row.version, action, ...extra }, who, scope, now); }
const submission = { summary: '处理了真实异常分支并保持原有数据', tests: '实际运行正常和异常用例，结果符合预期', changedFiles: ['src/A.java'] };

test('requirement edits invalidate active and completed task evidence; manual edits require current versions', () => {
  const doc = empty(), r = req(doc), t = task(doc, r.id);
  act(doc, t, 'claim', agent);
  const old = r.version; saveRecord(doc, 'requirements', { ...r, expectedVersion: old, criteria: '增加重复提交也必须保留原数据' }, human, scope);
  assert.throws(() => act(doc, t, 'submit', agent, { submission }), /需求已变化/);
  assert.throws(() => saveRecord(doc, 'tasks', { ...t, expectedVersion: t.version }, human, scope), /释放/);
  act(doc, t, 'release', human, { reason: '需求已经变化，释放并更新任务条件' });
  saveRecord(doc, 'tasks', { ...t, expectedVersion: t.version, criteria: r.criteria }, human, scope);
  act(doc, t, 'claim'); act(doc, t, 'submit', human, { submission });
  assert.throws(() => act(doc, t, 'approve', agent, { reason: 'agent 不能批准自己的提交结果' }), /不能批准/);
  act(doc, t, 'approve', human, { reason: '人工已核对实际需求与提交证据' });
  assert.equal(t.status, 'done'); assert.equal(t.requirementVersion, r.version);
  assert.throws(() => saveRecord(doc, 'requirements', { ...r, expectedVersion: old }, human, scope), /记录已变化/);
  const before = t.requirementVersion; saveRecord(doc, 'requirements', { ...r, expectedVersion: r.version, criteria: '新版本还要求权限错误结果明确' }, human, scope);
  assert.notEqual(before, r.version); assert.equal(t.history.at(-1).action, 'approve');
  act(doc, t, 'reopen', human, { reason: '需求版本变化，重新打开并按新条件处理' });
  saveRecord(doc, 'tasks', { ...t, expectedVersion: t.version, criteria: r.criteria }, human, scope);
  assert.equal(t.requirementVersion, r.version); assert.equal(t.status, 'ready');
});

test('leases reject duplicate claims, wrong owners and expired submits; expiration allows a new claim', () => {
  const doc = empty(), t = task(doc), now = Date.now(), second = { ...agent, id: crypto.randomUUID() };
  act(doc, t, 'claim', agent, {}, now);
  assert.throws(() => act(doc, t, 'claim', second, {}, now), /已被领取/);
  assert.throws(() => act(doc, t, 'submit', second, { submission }, now), /失效/);
  assert.throws(() => act(doc, t, 'heartbeat', second, {}, now), /不属于/);
  act(doc, t, 'heartbeat', agent, {}, now + 1000); assert.ok(activeLease(t, now + 1800500));
  assert.throws(() => act(doc, t, 'submit', agent, { submission }, now + 1801001), /失效/);
  act(doc, t, 'claim', second, {}, now + 1801001); assert.equal(t.claim.actor.id, second.id);
  act(doc, t, 'submit', second, { submission }, now + 1801002); act(doc, t, 'reject', human, { reason: '缺少真实边界证据，需要重新执行验证' });
  assert.equal(t.status, 'ready'); assert.deepEqual(t.history.find(h => h.action === 'submit').detail.changedFiles, ['src/A.java']);
});

test('concurrent disk mutations give only one agent the task and preserve evidence across rereads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-work-lock-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(root), row = await store.mutate(doc => task(doc));
  const results = await Promise.allSettled([agent, { ...agent, id: crypto.randomUUID() }].map(who => store.mutate(doc => changeTask(doc, { id: row.id, expectedVersion: row.version, action: 'claim' }, who, scope))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const read = await new WorkspaceStore(root).read(); assert.equal(read.tasks[0].status, 'in_progress'); assert.equal(read.tasks[0].history.length, 2);
  const bytes = await fs.readFile(store.file, 'utf8');
  await assert.rejects(store.mutate(doc => { doc.tasks[0].title = ''; }), /名称/);
  assert.equal(await fs.readFile(store.file, 'utf8'), bytes);
});

test('bounded inputs, cross-project relationships, report references and history cannot silently corrupt evidence', () => {
  const doc = empty(), r = req(doc), t = task(doc, r.id);
  assert.throws(() => saveRecord(structuredClone(doc), 'tasks', { ...t, id: '', projectId: crypto.randomUUID() }, human, scope), /其他项目/);
  assert.throws(() => saveRecord(empty(), 'requirements', { projectId, title: 'x', description: 'x', criteria: 'x', allowedPaths: 'x' }, agent, scope), /只能提议/);
  act(doc, t, 'claim'); assert.throws(() => act(doc, t, 'submit', human, { submission: { ...submission, changedFiles: ['../other/secret'] } }), /相对路径/);
  act(doc, t, 'submit', human, { submission: { ...submission, reportId: crypto.randomUUID() } });
  assert.throws(() => validateDocument(doc, new Set([projectId]), new Map()), /扫描引用/);
  assert.throws(() => validateDocument(doc, new Set()), /项目引用/);
  const missingScan = structuredClone(doc); missingScan.tasks[0].requireReport = true; missingScan.tasks[0].submission.reportId = '';
  assert.throws(() => validateDocument(missingScan), /扫描证据缺失/);
  const badSource = structuredClone(doc), sourceReport = crypto.randomUUID(); badSource.tasks[0].source = { reportId: sourceReport };
  const submissionReport = badSource.tasks[0].submission.reportId;
  assert.throws(() => validateDocument(badSource, new Set([projectId]), new Map([[submissionReport, projectId], [sourceReport, crypto.randomUUID()]])), /扫描引用/);
  const bounded = empty(), row = task(bounded); row.history = Array(100).fill(row.history[0]);
  assert.throws(() => act(bounded, row, 'block', human, { reason: '有 100 条历史时应明确拒绝继续保存' }), /100 条历史/);
});

test('submission provenance survives requirement changes, rebinds and rework without relabeling old evidence as current', () => {
  const doc = empty(), r = req(doc), t = task(doc, r.id);
  act(doc, t, 'claim'); act(doc, t, 'submit', human, { submission: { ...submission, requirementVersion: 999 } });
  assert.equal(t.submission.requirementId, r.id); assert.equal(t.submission.requirementVersion, 1);
  assert.equal(taskCoordination(doc, t, human).submissionRequirement.status, 'CURRENT');
  const original = structuredClone(t.submission);
  act(doc, t, 'approve', human, { reason: '人工核对当前需求与实际测试结果' });
  saveRecord(doc, 'requirements', { ...r, expectedVersion: r.version, criteria: '新版还需检查边界输入的结果' }, human, scope);
  act(doc, t, 'reopen', human, { reason: '需求发生变化，按新版条件重新处理' });
  saveRecord(doc, 'tasks', { ...t, expectedVersion: t.version, criteria: r.criteria }, human, scope);
  const rebound = taskCoordination(doc, t, human);
  assert.equal(rebound.requirement.status, 'CURRENT'); assert.equal(rebound.submissionRequirement.status, 'CHANGED');
  assert.deepEqual(t.submission, original); validateDocument(doc);
  act(doc, t, 'claim'); act(doc, t, 'submit', human, { submission });
  assert.equal(t.submission.requirementVersion, 2); assert.equal(taskCoordination(doc, t, human).submissionRequirement.status, 'CURRENT');
  assert.deepEqual(t.history.find(h => h.action === 'submit').detail, original);
  act(doc, t, 'reject', human, { reason: '先保留记录，再检查独立任务的场景' });
  saveRecord(doc, 'tasks', { ...t, expectedVersion: t.version, requirementId: '' }, human, scope);
  assert.equal(taskCoordination(doc, t, human).submissionRequirement.status, 'CHANGED');
  act(doc, t, 'claim'); act(doc, t, 'submit', human, { submission });
  assert.equal(t.submission.requirementId, ''); assert.equal(t.submission.requirementVersion, null);
  assert.equal(taskCoordination(doc, t, human).submissionRequirement.status, 'CURRENT');
  act(doc, t, 'reject', human, { reason: '将原独立任务关联到真实的项目需求' });
  saveRecord(doc, 'tasks', { ...t, expectedVersion: t.version, requirementId: r.id }, human, scope);
  assert.equal(taskCoordination(doc, t, human).submissionRequirement.status, 'CHANGED');
});

test('legacy evidence remains readable as unknown; invalid or foreign submission bindings cannot be restored', () => {
  const doc = empty(), r = req(doc), t = task(doc, r.id);
  act(doc, t, 'claim'); act(doc, t, 'submit', human, { submission });
  const legacy = structuredClone(doc); delete legacy.tasks[0].submission.requirementId; delete legacy.tasks[0].submission.requirementVersion;
  validateDocument(legacy); assert.equal(taskCoordination(legacy, legacy.tasks[0], human).submissionRequirement.status, 'UNKNOWN');
  const foreign = saveRecord(doc, 'requirements', { ...r, id: '', projectId: crypto.randomUUID() }, human, scope);
  for (const provenance of [{ requirementId: r.id }, { requirementVersion: 1 }, { requirementId: r.id, requirementVersion: 0 },
    { requirementId: r.id, requirementVersion: 2 }, { requirementId: '', requirementVersion: 1 }, { requirementId: foreign.id, requirementVersion: 1 }]) {
    const invalid = structuredClone(doc); invalid.tasks[0].submission = { ...submission, ...provenance };
    assert.throws(() => validateDocument(invalid), /版本|编号|项目/);
  }
});
