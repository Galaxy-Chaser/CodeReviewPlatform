const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { syncIndex, syncView } = require('../lib/work-sync');
const { validateDocument } = require('../lib/workspace');
const { recoverDataLock } = require('../lib/data-lock');
const ROOT = path.resolve(__dirname, '..');

/** count 是每类记录数量；构造真实边界内的隔离工作区，不读取用户项目或凭据。 */
function fixture(count) {
  const projectIds = Array.from({ length: count === 10 ? 2 : 30 }, () => crypto.randomUUID());
  const now = Date.now(), at = new Date(now).toISOString(), future = new Date(now + 1800000).toISOString();
  const history = [{ at, actor: { type: 'human', id: '', name: 'Measurement' }, action: 'create', detail: 'Representative historical evidence. '.repeat(20) }];
  const row = n => ({ id: crypto.randomUUID(), projectId: projectIds[n % projectIds.length], version: 1, title: `Fixture ${n}`, createdAt: at, updatedAt: at, history });
  const requirements = Array.from({ length: count }, (_, n) => ({ ...row(n), description: 'Representative requirement. '.repeat(40), criteria: 'Check actual scope and behavior.', allowedPaths: 'docs/**' }));
  const tasks = Array.from({ length: count }, (_, n) => ({ ...row(n), requirementId: requirements[n].id, requirementVersion: 1,
    description: 'Representative task description. '.repeat(40), criteria: 'Check boundaries and retain evidence.', requireReport: false,
    status: n % 5 ? 'ready' : 'in_progress', claim: n % 5 ? null : { actor: { type: 'agent', id: crypto.randomUUID(), name: 'Fixture agent' }, expiresAt: future }, submission: null }));
  const knowledge = Array.from({ length: count }, (_, n) => ({ ...row(n), projectId: n % 5 ? projectIds[n % projectIds.length] : '', status: n % 2 ? 'draft' : 'published',
    symptom: 'Representative symptom. '.repeat(20), cause: 'Representative cause. '.repeat(20), solution: 'Representative solution. '.repeat(20), verification: 'Representative verification. '.repeat(20), tags: ['fixture'], source: null }));
  const doc = validateDocument({ format: 'CodeHealthWorkspace', version: 1, revision: 1, requirements, tasks, knowledge }, new Set(projectIds));
  return { doc, projectIds, now };
}

/** values 是实际测量值；固定排序计算分位数，不将一次快请求当作总体平均。 */
function timing(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { medianMs: at(0.5), p95Ms: at(0.95), totalMs: values.reduce((sum, n) => sum + n, 0), samples: values.length };
}

/** data 提供固定元数据与时间；五批重复轮询记录 CPU 与耗时，GC 后只观察仍保留的堆。 */
function measureCore(data) {
  const index = syncIndex(data.doc), results = [];
  for (const [kind, scopes, publishedOnly] of [
    ['tasks', null, false], ['tasks', data.projectIds, false], ['requirements', [data.projectIds[0]], false], ['knowledge', [...data.projectIds, ''], true]
  ]) {
    const expected = syncView(index, kind, scopes, publishedOnly, data.now).token;
    global.gc(); const heapBefore = process.memoryUsage().heapUsed, cpu = process.cpuUsage(), batches = [], elapsedBatchesMs = [];
    let totalWallMs = 0;
    for (let batch = 0; batch < 5; batch++) {
      const start = performance.now();
      for (let n = 0; n < 200; n++) assert.equal(syncView(index, kind, scopes, publishedOnly, data.now).token, expected);
      const elapsed = performance.now() - start;
      totalWallMs += elapsed; elapsedBatchesMs.push(elapsed); batches.push(elapsed / 200);
    }
    const used = process.cpuUsage(cpu); global.gc();
    const batchTiming = timing(batches);
    results.push({ kind, projectScope: scopes ? scopes.length : 'all', publishedOnly, calls: 1000,
      timing: { medianBatchMeanMsPerCall: batchTiming.medianMs, p95BatchMeanMsPerCall: batchTiming.p95Ms, totalWallMs, elapsedBatchesMs, batches: 5, callsPerBatch: 200 },
      cpuMs: (used.user + used.system) / 1000, retainedHeapDeltaBytes: process.memoryUsage().heapUsed - heapBefore });
  }
  return results;
}

/** data 是已验证的隔离样本；启动真实平台，测量空闲内存和二十个已授权 agent 的加速请求。 */
async function measureService(data) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'health-collaboration-measure-')), dataDir = path.join(temp, 'data');
  const serviceDeadline = Date.now() + 60000;
  let child, stopped, deadline;
  try {
    await fs.mkdir(path.join(dataDir, 'work'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'work/workspace.json'), JSON.stringify(data.doc));
    await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ featureVersion: 2, storageVersion: 1, scans: [], githubReviews: [], archivedReports: [], settings: {},
      projects: data.projectIds.map((id, n) => ({ id, name: `Fixture project ${n}`, key: `fixture-${n}`, path: temp })) }));
    const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { windowsHide: true,
      env: { ...process.env, PORT: String(port), HEALTH_DATA_DIR: dataDir, SONAR_TOKEN: '', GITHUB_TOKEN: '' } });
    stopped = new Promise(resolve => child.once('close', resolve));
    await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(Error('Isolated service startup timed out')), 15000);
      child.stdout.on('data', value => { if (value.toString().includes('Code Health Center:')) resolve(); });
      child.once('error', reject); child.once('exit', () => reject(Error('Isolated service stopped before readiness')));
      child.stderr.on('data', value => reject(Error('Isolated service error: ' + value.toString().slice(0, 1500))));
    }); clearTimeout(deadline);
    const base = `http://127.0.0.1:${port}`, samples = [], tokens = [];
    const call = async (route, token, body, expectedStatus = 200) => {
      if (Date.now() >= serviceDeadline) throw Error('Isolated service measurement exceeded 60 seconds');
      const start = performance.now(), response = await fetch(base + route, { signal: AbortSignal.timeout(Math.max(1, Math.min(15000, serviceDeadline - Date.now()))),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
      const raw = await response.text(); assert.equal(response.status, expectedStatus);
      return { value: JSON.parse(raw), bytes: Buffer.byteLength(raw), ms: performance.now() - start };
    };
    for (let n = 0; n < 20; n++) tokens.push((await call('/api/work/agents/register', null, { name: `Measurement ${n}`, projectIds: data.projectIds })).value.token);
    const initial = (await call('/api/agent/sync', tokens[0])).value.token;
    const warmMemory = (await call('/api/health')).value.memory;
    await new Promise(resolve => setTimeout(resolve, 5000));
    const idleMemory = (await call('/api/health')).value.memory;
    const wall = performance.now();
    for (let round = 0; round < 10; round++) {
      const batch = await Promise.all(tokens.map(token => call('/api/agent/sync', token)));
      for (const sample of batch) { assert.equal(sample.value.token, initial); samples.push(sample); }
    }
    const wallMs = performance.now() - wall, burstMemory = (await call('/api/health')).value.memory;
    const agentList = (await call('/api/agent/list', tokens[0])).value;
    assert.equal(agentList.token, initial); assert.ok(agentList.rows.length <= 25);
    await call('/api/work/agents/revoke', null, { id: (await call('/api/work/agents')).value.agents[0].id });
    await call('/api/agent/sync', tokens[0], undefined, 401);
    return { agents: 20, rounds: 10, requests: samples.length, wallMs, latency: timing(samples.map(sample => sample.ms)), responseBytes: samples.reduce((n, sample) => n + sample.bytes, 0),
      warmMemory, idleMemory, burstMemory, idleSeconds: 5, listAgreement: true, revocationRejected: true };
  } finally {
    clearTimeout(deadline);
    if (child) { if (child.pid && child.exitCode === null) child.kill(); await stopped; }
    if (await fs.stat(path.join(dataDir, '.owner-lock')).then(() => true, () => false)) await recoverDataLock(dataDir);
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/** 固定两种样本与次数；只在 outputs 写入测量报告，不修改现有项目数据。 */
async function main() {
  if (process.argv.length !== 2 || !global.gc) throw Error('Run: node --expose-gc scripts/measure-collaboration.js');
  const source = {};
  for (const file of ['lib/work-sync.js', 'lib/workspace.js', 'lib/work-api.js', 'server.js', 'scripts/measure-collaboration.js']) source[file] = crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, file))).digest('hex');
  const report = { status: 'RUNNING', id: crypto.randomUUID(), startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, source, cases: [],
    limits: ['Fixed synthetic fixtures, one machine and runtime; timings are observations, not performance gates.', 'Core percentiles describe five batch means, not 1,000 individual request latencies; CPU accounting can be coarse on this platform.', 'HTTP requests are accelerated bursts, not the normal five-second browser schedule; summed latency overlaps concurrent requests.', 'Memory values are process snapshots; GC heap deltas are not allocation totals or proof of a universal memory bound.', 'No browser, JDK, Maven or Sonar resource cost is included.'] };
  for (const count of [10, 1000]) {
    const data = fixture(count);
    report.cases.push({ records: count * 3, workspaceBytes: Buffer.byteLength(JSON.stringify(data.doc)), projects: data.projectIds.length, core: measureCore(data), service: await measureService(data) });
  }
  report.status = 'PASSED'; report.finishedAt = new Date().toISOString();
  const directory = path.join(ROOT, 'outputs', 'collaboration-measurement'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `report-${report.id}.json`); await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(`Collaboration measurement passed: ${file}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
