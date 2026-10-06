const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceSnapshot } = require('../lib/source-snapshot');
const { scenarios } = require('../scripts/check-browser');
const { completeIterationReport, iterationCheckView, runIterationCheck } = require('../lib/iteration-check');
const { createBackup, restoreBackup } = require('../lib/backup');

/** 为组合规则提供有明确范围的代表性证据；真实整套运行另由页面和命令行验证。 */
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-iteration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'app.js'), 'original');
  const snapshot = await sourceSnapshot(root);
  const platform = { id: crypto.randomUUID(), status: 'PASSED', sourceSnapshot: snapshot, sourceCheck: { status: 'CURRENT' }, tests: { tests: 1, pass: 1 },
    checks: ['JavaScript 语法', '全部自动测试', '执行期间代码版本'].map(name => ({ name, passed: true })),
    testOutput: '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n' };
  const browser = { id: crypto.randomUUID(), kind: 'browser', status: 'PASSED', sourceSnapshot: snapshot, sourceCheck: { status: 'CURRENT' },
    scenarios: scenarios.map(([id, name]) => ({ id, name, status: 'PASSED' })), images: [] };
  const options = { platformRunner: async () => platform, browserRunner: async ({ id, output }) => {
    browser.id = id; await fs.writeFile(output, JSON.stringify(browser, null, 2)); return { report: browser };
  } };
  return { root, platform, browser, options };
}

test('one iteration requires complete tests, complete browser evidence and matching source; view detects later edits', async t => {
  const f = await fixture(t), { report } = await runIterationCheck(f.root, f.options);
  assert.equal(report.status, 'PASSED'); assert.equal(completeIterationReport(report), true);
  assert.equal((await iterationCheckView(f.root, report)).status, 'PASSED');
  for (const bad of [
    { ...report, stage: 'browser' }, { ...report, platform: null }, { ...report, browser: { ...report.browser, scenarios: [] } },
    { ...report, platform: { ...report.platform, testOutput: '# pass 1' } },
    { ...report, browser: { ...report.browser, sourceSnapshot: { digest: 'different' } } }
  ]) { assert.equal(completeIterationReport(bad), false); assert.equal((await iterationCheckView(f.root, bad)).status, 'FAILED'); }
  await fs.writeFile(path.join(f.root, 'app.js'), 'edited');
  assert.equal((await iterationCheckView(f.root, report)).status, 'STALE');
});

test('latest incomplete run is durable before work; platform failure stops browser and source changes between stages fail', async t => {
  const f = await fixture(t); let browserCalled = false;
  const output = path.join(f.root, 'outputs', 'current.json');
  const result = await runIterationCheck(f.root, { ...f.options, output,
    onStart: async initial => { const saved = JSON.parse(await fs.readFile(output, 'utf8')); assert.equal(saved.id, initial.id); assert.equal(saved.status, 'FAILED'); },
    platformRunner: async () => ({ ...f.platform, status: 'FAILED' }), browserRunner: async () => { browserCalled = true; }
  });
  assert.equal(result.report.status, 'FAILED'); assert.equal(browserCalled, false); assert.equal(result.report.browser, undefined);
  const changed = await runIterationCheck(f.root, { ...f.options, platformRunner: async () => {
    await fs.writeFile(path.join(f.root, 'app.js'), 'between stages'); return f.platform;
  } });
  assert.equal(changed.report.status, 'FAILED'); assert.equal(changed.report.sourceCheck.status, 'STALE');
  const interrupted = { kind: 'iteration', status: 'FAILED', stage: 'starting' };
  assert.equal((await iterationCheckView(f.root, interrupted)).status, 'FAILED');
  const thrown = await runIterationCheck(f.root, { ...f.options, platformRunner: async () => { throw Error('fixture interruption'); } });
  assert.equal(thrown.report.status, 'FAILED'); assert.match(thrown.report.error, /fixture interruption/);
});

test('iteration backup preserves all linked reports and screenshots and refuses missing evidence', async t => {
  const f = await fixture(t), data = path.join(f.root, 'data'), id = crypto.randomUUID();
  const reportPath = path.join(data, 'reports', `report-${id}.json`);
  const runner = f.options.browserRunner;
  f.options.browserRunner = async opts => {
    f.browser.images = [`browser-${opts.id}-project.png`];
    await fs.writeFile(path.join(path.dirname(opts.output), f.browser.images[0]), Buffer.from([137, 80, 78, 71]));
    return runner(opts);
  };
  const { report } = await runIterationCheck(f.root, { ...f.options, id, output: reportPath });
  const state = { storageVersion: 1, projects: [], scans: [], githubReviews: [], iterationCheckId: id,
    settings: { sonarUrl: 'http://127.0.0.1:9000', java8Home: '', java21Home: '', enabledRules: [], gate: { coverage: 60, duplication: 5 } } };
  await fs.writeFile(path.join(data, 'state.json'), JSON.stringify(state));
  const backup = await createBackup(data, state), destination = path.join(f.root, 'restored');
  await restoreBackup(path.join(data, 'backups', backup.file), destination);
  assert.equal(JSON.parse(await fs.readFile(path.join(destination, 'state.json'), 'utf8')).iterationCheckId, id);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, 'reports', `report-${id}.json`), 'utf8')), report);
  assert.deepEqual(await fs.readFile(path.join(destination, 'reports', report.browser.images[0])), Buffer.from([137, 80, 78, 71]));
  await fs.unlink(path.join(data, 'reports', `report-${report.platform.id}.json`));
  await assert.rejects(createBackup(data, state), /ENOENT/);
});
