const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { recoverDataLock } = require('../lib/data-lock');
const { restoreBackup } = require('../lib/backup');

test('real pipeline records require actual case evidence, resist stale edits, freeze versions, and survive archive/restart/backup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-pipeline-')), source = path.join(root, 'source'), data = path.join(root, 'data');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'pom.xml'), '<project/>');
  const file = path.join(source, 'PipelineDemo.java'), original = 'class PipelineDemo {}'; await fs.writeFile(file, original);
  const probe = require('node:net').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`; let child;
  /** 每次启动独立数据目录；测试不会读取或改写平台的生产报告。 */
  async function start() {
    child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, PORT: String(port), HEALTH_DATA_DIR: data, SONAR_TOKEN: '', GITHUB_TOKEN: '', JAVA8_HOME: '', JAVA21_HOME: '' }, windowsHide: true });
    await new Promise((resolve, reject) => { child.stdout.on('data', s => { if (s.toString().includes('Code Health Center:')) resolve(); }); child.stderr.on('data', s => reject(Error(s.toString()))); child.on('error', reject); });
  }
  async function stop() {
    if (child?.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill(); });
    if (await fs.stat(path.join(data, '.owner-lock')).then(() => true, () => false)) await recoverDataLock(data);
  }
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); }); await start();
  /** 返回完整 HTTP 状态，允许明确断言验证失败和并发冲突。 */
  async function request(route, payload, expected = 200) {
    const response = await fetch(base + route, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : undefined);
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  assert.equal((await request('/api/iteration-check')).status, 'NOT_CHECKED');
  await request('/api/iteration-check/run', { command: 'not-allowed' }, 400);
  const project = await request('/api/projects', { name: '流水线流程验证', key: 'pipeline', path: source }, 201);
  const p = await request('/api/pipeline/plan?projectId=' + project.id); assert.equal(p.template.cases.length, 30); assert.equal(p.plan, null);
  const planInput = { ...p.template, requireFull: false, requireBrief: false, minTests: 0, cases: [p.template.cases[0], { ...p.template.cases[1], required: false }] };
  const draft = await request('/api/pipeline/plan', { projectId: project.id, expectedId: '', plan: planInput });
  await request('/api/pipeline/run', { projectId: project.id }, 400);
  let plan = await request('/api/pipeline/plan', { projectId: project.id, expectedId: draft.id, plan: { ...planInput, confirmed: true } });
  await request('/api/pipeline/plan', { projectId: project.id, expectedId: draft.id, plan: { ...planInput, confirmed: true } }, 409);
  /** 实际运行扫描并等到完整报告落盘，不以开始请求成功作为执行成功。 */
  async function run() {
    const started = await request('/api/pipeline/run', { projectId: project.id }, 202);
    // 执行结果出现后，还要等待最终落盘结束；核对请求不能与最终保存竞争。
    for (let i = 0; i < 300; i++) {
      const r = await request('/api/report?id=' + started.id), current = await request('/api/state');
      if (r.status !== 'running' && !current.active) return r;
      await new Promise(r => setTimeout(r, 20));
    }
    throw Error('Pipeline fixture timed out');
  }
  const scan = await run(); assert.equal(scan.status, 'completed'); assert.equal(scan.localCompleted, true);
  let view = await request('/api/pipeline/check', { id: scan.id });
  assert.equal(view.summary.status, 'PENDING'); assert.equal(view.summary.stages.length, 8); assert.equal(view.summary.stages[3].status, 'NOT_REQUIRED');
  const state = await request('/api/state');
  const acceptance = Object.fromEntries(state.checklist.map(c => [c.id, { checked: true, evidence: '代表性流程验证证据，仅验证平台状态和保存行为' }]));
  assert.equal((await request('/api/acceptance', { id: scan.id, acceptance })).status, 'PENDING');
  const result = { status: 'passed', actual: '真实本地示例规则检查完成，行为符合平台预期', evidence: '代表性流程验证，不代表业务场景自动测试已经执行' };
  async function record(caseId, values, timestamp = '') { return request('/api/pipeline/result', { id: scan.id, caseId, expectedRecordedAt: timestamp, result: values }); }
  await request('/api/pipeline/result', { id: scan.id, caseId: plan.cases[0].id, result: { ...result, status: 'notApplicable' } }, 400);
  await request('/api/pipeline/result', { id: scan.id, caseId: 'unknown', result }, 400);
  await record(plan.cases[0].id, result);
  const done = await record(plan.cases[1].id, { ...result, status: 'notApplicable', actual: '该示例无业务分支，本记录用于验证不适用流程' });
  assert.equal(done.summary.status, 'READY');
  assert.equal((await request('/api/readiness', { projectId: project.id })).status, 'READY');
  const recorded = (await request('/api/report?id=' + scan.id)).acceptancePipeline.results[plan.cases[0].id];
  await request('/api/pipeline/result', { id: scan.id, caseId: plan.cases[0].id, expectedRecordedAt: '', result }, 409);
  const failed = await record(plan.cases[0].id, { ...result, status: 'failed', actual: '输入返回错误值，结果与预期不同' }, recorded.recordedAt);
  assert.equal(failed.summary.status, 'BLOCKED');
  assert.equal((await request('/api/readiness', { projectId: project.id })).status, 'BLOCKED');
  await record(plan.cases[0].id, result, failed.result.recordedAt);
  await fs.writeFile(file, 'class PipelineDemo { int modified; }');
  assert.equal((await request('/api/pipeline/check', { id: scan.id })).summary.status, 'BLOCKED');
  const latestCase = (await request('/api/report?id=' + scan.id)).acceptancePipeline.results[plan.cases[0].id];
  const stale = await record(plan.cases[0].id, result, latestCase.recordedAt); assert.equal(stale.result.sourceStatus, 'STALE');
  await fs.writeFile(file, original);
  const reverted = await request('/api/pipeline/check', { id: scan.id }); assert.equal(reverted.summary.status, 'PENDING'); assert.equal(reverted.summary.counts.invalid, 1);
  await record(plan.cases[0].id, result, stale.result.recordedAt);
  const exported = await request('/api/pipeline/export', { id: scan.id });
  const markdown = await (await fetch(base + exported.url)).text(); assert.match(markdown, /逐|输入与前置条件/); assert.ok(markdown.includes(plan.id)); assert.match(markdown, /来源：人工声明/);
  const tasks = await request('/api/export', { scanId: scan.id, kind: 'tasks' }); assert.ok((await (await fetch(base + tasks.url)).text()).includes(plan.id));
  plan = await request('/api/pipeline/plan', { projectId: project.id, expectedId: plan.id, plan: { ...planInput, confirmed: true, name: '修改后的项目方案' } });
  assert.equal((await request('/api/pipeline/check', { id: scan.id })).summary.status, 'BLOCKED');
  assert.equal((await request('/api/report?id=' + scan.id)).acceptancePipeline.plan.name, '代码实现质量验收');
  const next = await run(); assert.deepEqual(next.acceptancePipeline.results, {});
  await request('/api/reports/archive', { id: scan.id });
  assert.equal((await request('/api/pipeline/report?id=' + scan.id)).report.acceptancePipeline.results[plan.cases[0].id].status, 'passed');
  await stop(); await start();
  assert.equal((await request('/api/pipeline/plan?projectId=' + project.id)).plan.id, plan.id);
  await request('/api/reports/restore', { id: scan.id });
  // No Java or Sonar dependencies are configured. A full plan must record an honest automatic-stage failure.
  plan = await request('/api/pipeline/plan', { projectId: project.id, expectedId: plan.id, plan: { ...planInput, confirmed: true, requireFull: true, minTests: 2, noSkipped: true, requireBrief: true } });
  const full = await run(); assert.equal(full.status, 'failed');
  const fullView = await request('/api/pipeline/check', { id: full.id }); assert.equal(fullView.summary.status, 'BLOCKED');
  await request('/api/pipeline/result', { id: full.id, caseId: plan.cases[0].id, result }, 400);
  const backup = await request('/api/backup', {}, 201), restored = path.join(root, 'restored');
  await restoreBackup(path.join(data, 'backups', backup.file), restored);
  const restoredPlan = JSON.parse(await fs.readFile(path.join(restored, 'pipelines', plan.id + '.json'), 'utf8'));
  assert.equal(restoredPlan.minTests, 2);
  const oldReport = JSON.parse(await fs.readFile(path.join(restored, 'details', scan.id + '.json'), 'utf8'));
  assert.ok(oldReport.acceptancePipeline.results[plan.cases[0].id].history.some(r => r.status === 'failed'));
  const index = await request('/api/state'); assert.ok(!JSON.stringify(index).includes(result.evidence)); assert.equal(index.projects[0].pipelinePlan.caseCount, 2);
  // 没有规则支持的文件时，不能把零问题当作质量通过。
  await fs.unlink(file);
  plan = await request('/api/pipeline/plan', { projectId: project.id, expectedId: plan.id, plan: { ...planInput, confirmed: true } });
  const empty = await run(); assert.equal(empty.status, 'completed'); assert.equal(empty.gate.status, 'UNKNOWN');
  assert.equal((await request('/api/pipeline/check', { id: empty.id })).summary.status, 'BLOCKED');
});
