const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { changedLines, filterChanged } = require('../lib/git-changes');
const { scanLocal } = require('../lib/rules');
const { compareScans, repairTasks } = require('../lib/reports');
const { preflight } = require('../lib/preflight');
const execute = promisify(execFile);

/** Create an isolated repository and remove only this generated test directory afterwards. */
async function repo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) => execute(process.env.GIT_EXECUTABLE || 'git', ['-C', root, '-c', 'user.name=Health test', '-c', 'user.email=test@local', ...args], { windowsHide: true });
  await git('init');
  await fs.writeFile(path.join(root, 'pom.xml'), '<project/>');
  return { root, git };
}
test('Git changed scan excludes historic issues and includes staged, unstaged and untracked changes', async t => {
  const { root, git } = await repo(t);
  await fs.writeFile(path.join(root, 'Old.java'), 'class Old {\n void run() {\n System.out.println("old");\n }\n}\n');
  await git('add', '.'); await git('commit', '-m', 'baseline');
  await fs.appendFile(path.join(root, 'Old.java'), '// TODO staged\n'); await git('add', 'Old.java');
  await fs.appendFile(path.join(root, 'Old.java'), '// TODO unstaged\n');
  await fs.writeFile(path.join(root, '新增 示例.java'), 'List.of("new");\n');
  const changes = await changedLines(root);
  assert.deepEqual(changes.ranges['Old.java'], [[6, 7]]);
  const findings = filterChanged((await scanLocal(root)).issues, changes);
  assert.equal(findings.length, 3);
  assert.ok(!findings.some(i => i.rule === 'debug-output'));
  assert.ok(findings.some(i => i.file === '新增 示例.java'));
});
test('initial repositories include all source files; clean committed projects have no changes', async t => {
  const { root, git } = await repo(t);
  await fs.writeFile(path.join(root, 'First.java'), 'List.of();');
  await git('add', '.');
  const initial = await changedLines(root);
  assert.equal(initial.head, null);
  assert.deepEqual(initial.files, ['First.java']);
  await git('commit', '-m', 'first');
  assert.deepEqual((await changedLines(root)).files, []);
});
test('pure deletion that empties a catch is detected in changed-code scans', async t => {
  const { root, git } = await repo(t);
  await fs.writeFile(path.join(root, 'A.java'), 'class A { void a() { try {} catch(Exception e) {\n throw e;\n} } }\n');
  await git('add', '.'); await git('commit', '-m', 'baseline');
  await fs.writeFile(path.join(root, 'A.java'), 'class A { void a() { try {} catch(Exception e) {\n} } }\n');
  const findings = filterChanged((await scanLocal(root)).issues, await changedLines(root));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'empty-catch');
});
test('monorepo scopes use paths relative to the registered Maven project', async t => {
  const { root, git } = await repo(t);
  const sub = path.join(root, 'module'); await fs.mkdir(sub);
  await fs.writeFile(path.join(sub, 'A.java'), 'class A {}\n');
  await git('add', '.'); await git('commit', '-m', 'baseline');
  await fs.appendFile(path.join(sub, 'A.java'), '// TODO new\n');
  assert.deepEqual((await changedLines(sub)).files, ['A.java']);
});
test('changed migration checks preserve cross-file context and multi-line catch matching', async t => {
  const { root, git } = await repo(t);
  await fs.writeFile(path.join(root, 'V1__existing.sql'), 'select 1;');
  await git('add', '.'); await git('commit', '-m', 'baseline');
  await fs.writeFile(path.join(root, 'V1_0__new.sql'), 'select 2;');
  const changes = await changedLines(root);
  const findings = filterChanged((await scanLocal(root)).issues, changes);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'migration-version');
  assert.equal(filterChanged([{ rule: 'empty-catch', file: 'A.java', line: 1, endLine: 4 }], { files: ['A.java'], ranges: { 'A.java': [[3, 3]] } }).length, 1);
});
test('comparison resists shifted lines and refuses partial scopes or different rules', () => {
  const make = issues => ({ id: 'old', projectId: 'p', mode: 'local', scope: 'project', status: 'completed', settings: { enabledRules: ['todo'] }, issues, metrics: { coverage: 60 } });
  const before = make([{ id: 'a', type: 'LOCAL', rule: 'todo', file: 'A.java', line: 1, excerpt: '// TODO item' }]);
  const after = { ...make([{ ...before.issues[0], line: 6 }]), id: 'new', metrics: { coverage: 70 } };
  const comparison = compareScans(after, before);
  assert.equal(comparison.added.length, 0);
  assert.equal(comparison.removed.length, 0);
  assert.equal(comparison.delta.coverage, 10);
  assert.equal(compareScans({ ...after, scope: 'changed' }, before).available, false);
  assert.equal(compareScans({ ...after, settings: { enabledRules: [] } }, before).available, false);
  assert.equal(compareScans({ ...after, issues: [] }, before).removed.length, 1);
  assert.equal(compareScans(after, { ...before, issues: [before.issues[0], before.issues[0]] }).removed.length, 1);
  assert.equal(repairTasks({ issues: [{ file: 'a', severity: 'LOW' }, { file: 'b', severity: 'HIGH' }] })[0].severity, 'HIGH');
});
test('local readiness requires no JDK, Docker or token and rejects missing Git roots', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'pom.xml'), '<project/>');
  assert.equal((await preflight({ path: root }, {}, '', 'local', 'project')).ready, true);
  const check = await preflight({ path: root }, {}, '', 'local', 'changed');
  assert.equal(check.ready, false);
  assert.match(check.checks.find(c => c.name === 'Git 改动范围').detail, /Git/);
});
