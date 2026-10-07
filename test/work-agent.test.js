const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { recoverDataLock } = require('../lib/data-lock');
const { restoreBackup } = require('../lib/backup');

test('real HTTP and local agent CLI collaborate, enforce scopes/review, link issues, and survive restart/backup without credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-agent-flow-')), data = path.join(root, 'data'), source = path.join(root, 'source');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'pom.xml'), '<project/>'); await fs.writeFile(path.join(source, 'A.java'), 'class A { void run() { try {} catch (Exception e) {} } }');
  const probe = require('node:net').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`; let child;
  async function start() {
    child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, PORT: String(port), HEALTH_DATA_DIR: data, SONAR_TOKEN: '', GITHUB_TOKEN: '' }, windowsHide: true });
    await new Promise((resolve, reject) => { child.stdout.on('data', s => { if (s.toString().includes('Code Health Center:')) resolve(); }); child.stderr.on('data', s => reject(Error(s.toString()))); child.on('error', reject); });
  }
  async function stop() { if (child?.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill(); }); if (await fs.stat(path.join(data, '.owner-lock')).then(() => true, () => false)) await recoverDataLock(data); }
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); }); await start();
  async function call(route, payload, token, expected = 200) {
    const response = await fetch(base + route, { ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}), headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  }
  const p = await call('/api/projects', { name: 'agent 协作示例', key: 'agent-flow', path: source }, null, 201);
  const other = await call('/api/projects', { name: '其他项目', key: 'other-flow', path: source }, null, 201);
  const create = (kind, record) => call('/api/work/save', { kind, record });
  const req = (await create('requirements', { projectId: p.id, title: '异常处理文档', description: '梳理异常处置与验证流程', criteria: '说明正常、异常和恢复步骤', allowedPaths: 'docs，仅文档，禁止改动其他目录' })).row;
  const task = (await create('tasks', { projectId: p.id, requirementId: req.id, title: '异常处理说明', description: '实现完整的说明并实际验证', criteria: req.criteria, requireReport: false })).row;
  const outsider = (await create('tasks', { projectId: other.id, title: '其他项目任务', description: '其他项目的独立任务说明', criteria: '不能被未授权 agent 读取或修改', requireReport: false })).row;
  const a = await call('/api/work/agents/register', { name: 'CLI fixture agent', projectIds: [p.id] });
  const b = await call('/api/work/agents/register', { name: 'second fixture agent', projectIds: [p.id] });
  const sync = async (kind = 'tasks', token = a.token) => (await call('/api/agent/sync?kind=' + kind, null, token)).token;
  const initialToken = await sync(); assert.match(initialToken, /^[a-f0-9]{64}$/);
  assert.equal((await call('/api/agent/list', null, a.token)).token, initialToken);
  assert.equal(await sync(), initialToken);
  await call('/api/agent/sync?projectId=' + other.id, null, a.token, 403);
  await call('/api/agent/sync?kind=requirements', null, a.token, 403);
  await call('/api/agent/sync?offset=0', null, a.token, 400);
  await call('/api/work/sync?kind=invalid', null, null, 403);
  await call('/api/work/task', { id: outsider.id, expectedVersion: outsider.version, action: 'claim' });
  assert.equal(await sync(), initialToken);
  await call('/api/agent/context?id=' + task.id, null, null, 401);
  await call('/api/agent/context?id=' + outsider.id, null, a.token, 403);
  await call('/api/work/task', { id: task.id, expectedVersion: task.version, action: 'claim' }, a.token, 403);
  await call('/api/settings', { settings: {} }, a.token, 403);
  /** 实际启动独立本地 agent 进程，不用测试替身冒充参与流程。 */
  async function cli(args, expected = 0) {
    const proc = spawn(process.execPath, [path.join(__dirname, '../scripts/local-agent.js'), ...args], { env: { ...process.env, HEALTH_PLATFORM_URL: base, HEALTH_AGENT_TOKEN: a.token }, windowsHide: true });
    let stdout = '', stderr = ''; proc.stdout.on('data', s => stdout += s); proc.stderr.on('data', s => stderr += s);
    const code = await new Promise((r, reject) => { proc.on('error', reject); proc.on('close', r); }); assert.equal(code, expected, stderr); return expected ? stderr : JSON.parse(stdout);
  }
  assert.equal((await cli(['list'])).rows.length, 1); assert.equal((await cli(['context', task.id])).requirement.id, req.id);
  assert.equal((await cli(['sync', '--project', p.id, '--kind', 'tasks'])).token, initialToken);
  await cli(['sync', '--status', 'ready'], 1);
  assert.equal((await cli(['list', '--project', p.id, '--status', 'ready', '--offset', '0'])).total, 1);
  const claimed = (await cli(['claim', task.id])).row; assert.equal(claimed.claim.actor.id, a.agent.id);
  const claimedToken = await sync(); assert.notEqual(claimedToken, initialToken);
  assert.equal(await sync('tasks', b.token), claimedToken);
  await call('/api/agent/task', { id: task.id, expectedVersion: claimed.version, action: 'claim' }, b.token, 409);
  assert.equal(await sync(), claimedToken);
  const renewed = (await cli(['heartbeat', task.id])).row;
  const evidenceFile = path.join(root, 'evidence.json'); await fs.writeFile(evidenceFile, JSON.stringify({ summary: '完成异常处置说明并核对恢复步骤', tests: '实际执行代表性正常和异常用例，文档说明与结果一致', changedFiles: ['docs/recovery.md'] }));
  const submitted = (await cli(['submit', task.id, '--file', evidenceFile])).row; assert.equal(submitted.status, 'review'); assert.ok(submitted.version > renewed.version);
  await call('/api/agent/task', { id: task.id, expectedVersion: submitted.version, action: 'approve', reason: 'agent 不能自己批准自己的处理结果' }, a.token, 403);
  await call('/api/work/task', { id: task.id, expectedVersion: task.version, action: 'approve', reason: '旧版本不应覆盖最新 agent 操作结果' }, null, 409);
  const done = (await call('/api/work/task', { id: task.id, expectedVersion: submitted.version, action: 'approve', reason: '人工核对实际文档范围及验证记录后确认' })).row;
  assert.equal(done.status, 'done'); assert.equal((await call('/api/work/list?kind=requirements')).rows.find(r => r.id === req.id).done, 1);
  const draftFile = path.join(root, 'draft.json'); await fs.writeFile(draftFile, JSON.stringify({ projectId: p.id, title: '异常处理说明经验', symptom: '异常场景缺少操作与恢复说明', cause: '原文档未记录边界和失败结果', solution: '补充按实际情况验证过的操作步骤', verification: '实际复验异常并检查数据保留情况', tags: ['异常', '文档'], source: { taskId: task.id } }));
  const draft = (await cli(['knowledge', '--file', draftFile])).row;
  const knowledgeToken = await sync('knowledge');
  assert.equal((await call('/api/agent/list?kind=knowledge', null, a.token)).total, 0);
  await call('/api/agent/knowledge/publish', { id: draft.id, expectedVersion: draft.version, publish: true, reason: 'agent 不能发布未经人工审核的知识' }, a.token, 403);
  await call('/api/work/knowledge/publish', { id: draft.id, expectedVersion: draft.version, publish: true, reason: '人工核对来源任务与复用说明后发布' });
  assert.notEqual(await sync('knowledge'), knowledgeToken);
  assert.equal((await cli(['context', task.id])).knowledge[0].id, draft.id);
  assert.equal((await cli(['knowledge-list', '--search', '异常'])).total, 1);
  assert.equal((await call('/api/work/list?kind=knowledge&search=' + encodeURIComponent('异常'))).total, 1);
  const scan = await call('/api/scans', { projectId: p.id, mode: 'local' }, null, 202); let report;
  for (let i = 0; i < 300; i++) { report = await call('/api/report?id=' + scan.id); if (report.status !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(report.status, 'completed');
  const repair = (await call('/api/work/from-issue', { projectId: p.id, source: { reportId: report.id, trackingId: report.issues[0].trackingId } })).row;
  await call('/api/work/from-issue', { projectId: p.id, source: repair.source }, null, 409);
  const humanClaim = (await call('/api/work/task', { id: repair.id, expectedVersion: repair.version, action: 'claim' })).row;
  const pending = (await call('/api/work/task', { id: repair.id, expectedVersion: humanClaim.version, action: 'submit', submission: { summary: '代表性提交，尚未修复高风险异常问题', tests: '真实本地扫描仍发现高风险，本轮不可验收', changedFiles: [], reportId: report.id } })).row;
  await call('/api/work/task', { id: repair.id, expectedVersion: pending.version, action: 'approve', reason: '此报告存在实际高风险，不应批准完成' }, null, 409);
  const returned = (await call('/api/work/task', { id: repair.id, expectedVersion: pending.version, action: 'reject', reason: '真实问题仍然存在，请修复并重新扫描提交' })).row;
  await fs.writeFile(path.join(source, 'A.java'), 'class A {}');
  const cleanScan = await call('/api/scans', { projectId: p.id, mode: 'local' }, null, 202); let clean;
  for (let i = 0; i < 300; i++) { clean = await call('/api/report?id=' + cleanScan.id); if (clean.status !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(clean.status, 'completed'); assert.equal(clean.issues.length, 0);
  const checks = (await call('/api/state')).checklist;
  await call('/api/acceptance', { id: clean.id, acceptance: Object.fromEntries(checks.map(c => [c.id, { checked: true, evidence: '代表性平台验收声明，只验证保存与门禁流程，不声称业务全覆盖' }])) });
  const retry = (await call('/api/agent/task', { id: repair.id, expectedVersion: returned.version, action: 'claim' }, a.token)).row;
  const revised = (await call('/api/agent/task', { id: repair.id, expectedVersion: retry.version, action: 'submit', submission: { summary: '实际移除示例空捕获并重新扫描', tests: '实际扫描返回零问题，本地检查范围通过，未执行 Java 构建', changedFiles: ['A.java'], reportId: clean.id } }, a.token)).row;
  await fs.writeFile(path.join(source, 'A.java'), 'class A { int changed; }');
  await call('/api/work/task', { id: repair.id, expectedVersion: revised.version, action: 'approve', reason: '代码已变化，不能沿用刚才的扫描批准任务' }, null, 409);
  await fs.writeFile(path.join(source, 'A.java'), 'class A {}');
  assert.equal((await call('/api/work/task', { id: repair.id, expectedVersion: revised.version, action: 'approve', reason: '核对最新本地扫描、当前源码和代表性人工验收记录后通过' })).row.status, 'done');
  await call('/api/work/agents/revoke', { id: b.agent.id }); await call('/api/agent/list', null, b.token, 401);
  await call('/api/agent/sync', null, b.token, 401);
  const saved = await fs.readFile(path.join(data, 'work/workspace.json'), 'utf8'); assert.ok(!saved.includes(a.token)); assert.ok(!saved.includes(b.token));
  const backup = await call('/api/backup', {}, null, 201), restored = path.join(root, 'restored'); await restoreBackup(path.join(data, 'backups', backup.file), restored);
  assert.equal(await fs.readFile(path.join(restored, 'work/workspace.json'), 'utf8'), saved);
  await stop(); await start(); await call('/api/agent/list', null, a.token, 401);
  assert.equal((await call('/api/work/detail?kind=tasks&id=' + task.id)).row.status, 'done'); assert.equal((await call('/api/work/list?kind=knowledge')).rows[0].status, 'published');
});
