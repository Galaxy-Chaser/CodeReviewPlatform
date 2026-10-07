const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { createBackup, restoreBackup } = require('../lib/backup');
const { acquireDataLock, recoverDataLock } = require('../lib/data-lock');
const { ReportStore } = require('../lib/report-store');
const { writeSarif } = require('../lib/sarif');

/** Build real persisted index/detail files and authored evidence, with exports and unrelated files to test selection. */
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'health-backup-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'data'); await fs.mkdir(root);
  const projectId = crypto.randomUUID(), briefId = crypto.randomUUID(), reportId = crypto.randomUUID();
  const policy = { requireBrief: false, requireFull: true, minTests: 1, blockMedium: false, gate: null };
  const report = { id: reportId, projectId, status: 'completed', mode: 'local', scope: 'project', policy, gate: { status: 'UNKNOWN' }, issues: [], logs: '真实日志 中文', acceptance: { tests: { checked: true, evidence: '手工验证示例证据，不是自动运行声明' } } };
  const summary = await new ReportStore(root).put(report);
  const state = { storageVersion: 1, projects: [{ id: projectId, name: '迁移验证', key: 'backup-test', path: root, baselineId: reportId, codingBrief: { id: briefId, ready: false, missing: ['允许改动范围'] } }], scans: [summary], githubReviews: [], settings: { enabledRules: ['todo'], sonarUrl: 'http://127.0.0.1:9000', java8Home: '', java21Home: '', gate: { coverage: 60, duplication: 5 } } };
  state.projects[0].policy = policy;
  await fs.mkdir(path.join(root, 'briefs')); await fs.writeFile(path.join(root, 'briefs', briefId + '.json'), JSON.stringify({ id: briefId, goal: '真实需求中文' }));
  await fs.mkdir(path.join(root, 'reports')); await fs.writeFile(path.join(root, 'reports', 'tasks-' + reportId + '.md'), '验收与修复清单\n');
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(root, '.env'), 'never-include-credential');
  return { root, parent, state, reportId, briefId };
}

test('compressed backup restores exact state, reports, evidence, baseline, brief and export without overwriting', async t => {
  const { root, parent, state, reportId, briefId } = await fixture(t), result = await createBackup(root, state);
  const archive = path.join(root, 'backups', result.file), raw = gunzipSync(await fs.readFile(archive)).toString();
  assert.ok(!raw.includes('never-include-credential')); assert.ok(!raw.includes('owner-lock'));
  const destination = path.join(parent, 'restored');
  const restored = await restoreBackup(archive, destination);
  assert.equal(restored.files, 4);
  for (const name of ['state.json', 'details/' + reportId + '.json', 'briefs/' + briefId + '.json', 'reports/tasks-' + reportId + '.md']) assert.deepEqual(await fs.readFile(path.join(root, name)), await fs.readFile(path.join(destination, name)));
  await assert.rejects(restoreBackup(archive, destination), /目标已存在/);
  const lock = await acquireDataLock(destination); await lock.release();
});

test('portable SARIF exports survive backup and restore byte for byte; partial and unrelated extensions stay excluded', async t => {
  const { root, parent, state, reportId } = await fixture(t);
  const report = JSON.parse(await fs.readFile(path.join(root, 'details', reportId + '.json'), 'utf8'));
  const filename = 'sarif-' + crypto.randomUUID() + '.sarif', source = path.join(root, 'reports', filename);
  const handle = await fs.open(source, 'wx'); try { await writeSarif(handle, report); } finally { await handle.close(); }
  await fs.writeFile(source + '.tmp', 'unfinished-export');
  await fs.writeFile(source.replace('.sarif', '.json'), 'unrelated-extension');
  const backup = await createBackup(root, state), destination = path.join(parent, 'sarif-restored');
  const restored = await restoreBackup(path.join(root, 'backups', backup.file), destination);
  assert.equal(restored.files, 5);
  assert.deepEqual(await fs.readFile(path.join(destination, 'reports', filename)), await fs.readFile(source));
  const names = await fs.readdir(path.join(destination, 'reports'));
  assert.ok(!names.some(name => name.endsWith('.tmp'))); assert.ok(!names.includes(filename.replace('.sarif', '.json')));
});

test('corruption, missing completion, unsafe paths and duplicate files never publish a restore destination', async t => {
  const { root, parent, state } = await fixture(t), result = await createBackup(root, state);
  const rows = gunzipSync(await fs.readFile(path.join(root, 'backups', result.file))).toString().trimEnd().split('\n').map(JSON.parse);
  const cases = [
    rows.map(r => r.sha256 ? { ...r, sha256: 'bad' } : r),
    rows.slice(0, -1),
    rows.map(r => r.file === 'state.json' ? { ...r, file: '../escape.json' } : r),
    [rows[0], rows[1], rows[1], ...rows.slice(2)]
  ];
  for (let i = 0; i < cases.length; i++) {
    const corrupt = path.join(parent, `corrupt-${i}.gz`), destination = path.join(parent, `invalid-${i}`);
    await fs.writeFile(corrupt, gzipSync(cases[i].map(r => JSON.stringify(r)).join('\n') + '\n'));
    await assert.rejects(restoreBackup(corrupt, destination));
    assert.equal(await fs.stat(destination).then(() => true, () => false), false);
  }
});

test('missing referenced details cannot produce a complete backup', async t => {
  const { root, state, reportId } = await fixture(t);
  await fs.unlink(path.join(root, 'details', reportId + '.json'));
  await assert.rejects(createBackup(root, state));
  assert.deepEqual(await fs.readdir(path.join(root, 'backups')), []);
});

test('directory ownership refuses other owners and live recovery; released directories can be reopened', async t => {
  const { root } = await fixture(t), first = await acquireDataLock(root);
  await assert.rejects(acquireDataLock(path.join(root, '.')), /已被占用/);
  await assert.rejects(recoverDataLock(root), /仍在运行/);
  await first.release(); const next = await acquireDataLock(root);
  await first.release(); await assert.rejects(acquireDataLock(root), /已被占用/);
  await next.release();
});

test('confirmed dead owners recover once under competing recovery attempts', async t => {
  const { root } = await fixture(t);
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  await new Promise(resolve => dead.once('exit', resolve));
  const directory = path.join(root, '.owner-lock'); await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: dead.pid, nonce: crypto.randomUUID() }));
  const results = await Promise.allSettled([recoverDataLock(root), recoverDataLock(root)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const next = await acquireDataLock(root); await next.release();
});
