const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { testCounts, runPlatformCheck, platformCheckView } = require('../lib/platform-check');
const { createBackup, restoreBackup } = require('../lib/backup');

test('test evidence rejects missing, partial, inconsistent, failed and skipped TAP summaries', () => {
  const summary = (pass = 2, fail = 0, skipped = 0) => `# tests 2\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n`;
  assert.equal(testCounts(summary()).passed, true);
  for (const text of ['', '# tests 2\n# pass 2', summary(1, 1), summary(1, 0, 1), summary(3)]) assert.equal(testCounts(text).passed, false);
});

/** 执行真正的小型 Node 工程，避免只测试伪造的成功状态。 */
test('real platform checks distinguish passing tests, failures, source changes and syntax errors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-self-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'test')); const file = path.join(root, 'test', 'example.test.js');
  const passing = "const t = require('node:test'); t('actual example', () => {});";
  await fs.writeFile(file, passing);
  const passed = await runPlatformCheck(root); assert.equal(passed.status, 'PASSED', JSON.stringify(passed)); assert.equal(passed.tests.pass, 1);
  assert.equal((await platformCheckView(root, passed)).status, 'PASSED');
  await fs.writeFile(file, passing + '\n// changed');
  assert.equal((await platformCheckView(root, passed)).status, 'STALE');
  await fs.writeFile(file, "const t = require('node:test'); t('actual failure', () => { throw Error('expected fixture failure'); });");
  const failed = await runPlatformCheck(root); assert.equal(failed.status, 'FAILED'); assert.equal(failed.tests.fail, 1);
  await fs.writeFile(file, "const t = require('node:test'); const fs = require('node:fs'); t('change during execution', () => fs.writeFileSync('service.js', 'changed')); ");
  await fs.writeFile(path.join(root, 'service.js'), 'original');
  const changed = await runPlatformCheck(root); assert.equal(changed.tests.pass, 1); assert.equal(changed.status, 'FAILED'); assert.equal(changed.sourceCheck.status, 'STALE');
  await fs.writeFile(file, 'const = invalid');
  const invalid = await runPlatformCheck(root); assert.equal(invalid.status, 'FAILED'); assert.match(invalid.error, /语法检查失败/);
  assert.equal((await platformCheckView(root, null)).status, 'NOT_CHECKED');
});

test('platform result and its current reference survive a real backup and restore', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-self-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); await fs.mkdir(path.join(data, 'reports'), { recursive: true });
  const id = require('node:crypto').randomUUID(), state = { storageVersion: 1, projects: [], scans: [], githubReviews: [], platformCheckId: id,
    settings: { sonarUrl: 'http://127.0.0.1:9000', java8Home: '', java21Home: '', gate: { coverage: 60, duplication: 5 }, enabledRules: [] } };
  const file = `report-${id}.json`, content = JSON.stringify({ id, status: 'FAILED', tests: { pass: 0, fail: 1 } });
  await fs.writeFile(path.join(data, 'state.json'), JSON.stringify(state)); await fs.writeFile(path.join(data, 'reports', file), content);
  const backup = await createBackup(data, state), restored = path.join(root, 'restored');
  await restoreBackup(path.join(data, 'backups', backup.file), restored);
  assert.equal(JSON.parse(await fs.readFile(path.join(restored, 'state.json'))).platformCheckId, id);
  assert.equal(await fs.readFile(path.join(restored, 'reports', file), 'utf8'), content);
});
