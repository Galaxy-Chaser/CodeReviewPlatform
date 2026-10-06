const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { recoverDataLock } = require('../lib/data-lock');
const { restoreBackup } = require('../lib/backup');

test('real review/readiness workflow survives restart and backup, and blocks changed code and newer failed attempts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-readiness-'));
  const source = path.join(dir, 'project'), data = path.join(dir, 'data');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'pom.xml'), '<project/>');
  const file = path.join(source, 'A.java');
  const faulty = 'class A { void run() { try {} catch (Exception e) {} } }';
  await fs.writeFile(file, faulty);
  const probe = require('node:net').createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const base = `http://127.0.0.1:${port}`;
  let child;
  /** Launch an isolated data directory and wait for the server's ready message. */
  async function start() {
    child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, PORT: String(port), HEALTH_DATA_DIR: data, SONAR_TOKEN: '', GITHUB_TOKEN: '' }, windowsHide: true });
    await new Promise((resolve, reject) => { child.stdout.on('data', s => { if (s.toString().includes('Code Health Center:')) resolve(); }); child.stderr.on('data', s => reject(Error(s.toString()))); child.on('error', reject); });
  }
  /** Stop only this fixture's child and recover its lock after forced Windows termination. */
  async function stop() {
    if (child?.exitCode === null) await new Promise(r => { child.once('exit', r); child.kill(); });
    if (await fs.stat(path.join(data, '.owner-lock')).then(() => true, () => false)) await recoverDataLock(data);
  }
  t.after(async () => { await stop(); await fs.rm(dir, { recursive: true, force: true }); });
  await start();
  async function call(route, payload) {
    const response = await fetch(base + route, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : undefined);
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  }
  const item = await call('/api/projects', { name: '验收验证', key: 'readiness', path: source });
  assert.equal((await call('/api/readiness', { projectId: item.id })).status, 'NOT_CHECKED');
  /** Run real rules on representative source, polling only the isolated scan. */
  async function scan() {
    const started = await call('/api/scans', { projectId: item.id, mode: 'local' });
    for (let i = 0; i < 300; i++) {
      const result = await call('/api/report?id=' + started.id);
      if (result.status !== 'running') return result;
      await new Promise(r => setTimeout(r, 20));
    }
    throw Error('Fixture scan timed out');
  }
  const first = await scan(); assert.equal(first.issues.length, 1);
  const decision = { id: first.id, trackingId: first.issues[0].trackingId, status: 'dismissed', reason: '人工检查确认并记录异常分支理由' };
  await call('/api/issues/review', decision);
  assert.equal((await call('/api/readiness', { projectId: item.id })).status, 'BLOCKED');
  await stop(); await start();
  assert.equal((await call('/api/report?id=' + first.id)).issues[0].review.status, 'dismissed');
  await fs.writeFile(file, '\n\n' + faulty);
  const shifted = await scan(); assert.equal(shifted.issues[0].review.status, 'dismissed');
  assert.equal((await call('/api/issues?reviewStatus=dismissed')).total, 1);
  const tasks = await call('/api/export', { scanId: shifted.id, kind: 'tasks' });
  assert.match(await (await fetch(base + tasks.url)).text(), /人工检查确认并记录异常分支理由/);
  const exported = await call('/api/export', { reviewStatus: 'dismissed' });
  assert.equal((await (await fetch(base + exported.url)).json())[0].review.status, 'dismissed');
  await fs.writeFile(file, 'class A {}');
  const clean = await scan(); assert.equal(clean.issues.length, 0);
  assert.equal((await call('/api/readiness', { projectId: item.id })).status, 'PENDING');
  const state = await call('/api/state');
  const acceptance = Object.fromEntries(state.checklist.map(c => [c.id, { checked: true, evidence: '代表性验收流程验证证据，不是业务测试声明' }]));
  await call('/api/acceptance', { id: clean.id, acceptance });
  assert.equal((await call('/api/readiness', { projectId: item.id })).status, 'READY');
  await fs.writeFile(file, 'class A { int value; }');
  const stale = await call('/api/readiness', { projectId: item.id });
  assert.equal(stale.status, 'BLOCKED'); assert.equal(stale.sourceCheck.status, 'STALE');
  assert.equal((await call('/api/report?id=' + clean.id)).acceptanceSourceCheck.status, 'CURRENT');
  await fs.writeFile(file, faulty);
  const returned = await scan(); assert.equal(returned.issues[0].review.status, 'open'); assert.equal(returned.issues[0].review.event, 'returned');
  await call('/api/issues/review', { ...decision, id: returned.id, trackingId: returned.issues[0].trackingId, status: 'confirmed' });
  await fs.writeFile(file, 'class A { void run() { try {} catch (RuntimeException e) {} } }');
  const changed = await scan(); assert.equal(changed.issues[0].review.event, 'changed'); assert.equal(changed.issues[0].review.prior.status, 'confirmed');
  await fs.writeFile(file, '/* unclosed');
  const failed = await scan(); assert.equal(failed.status, 'failed');
  const latest = await call('/api/readiness', { projectId: item.id });
  assert.equal(latest.reportId, failed.id); assert.equal(latest.status, 'BLOCKED');
  assert.equal((await call('/api/readiness', { id: clean.id })).status, 'BLOCKED');
  const backup = await call('/api/backup', {});
  const restored = path.join(dir, 'restored'); await restoreBackup(path.join(data, 'backups', backup.file), restored);
  const saved = JSON.parse(await fs.readFile(path.join(restored, 'details', changed.id + '.json'), 'utf8'));
  assert.equal(saved.issues[0].review.prior.status, 'confirmed'); assert.ok(saved.issueReviewLedger.length);
});
