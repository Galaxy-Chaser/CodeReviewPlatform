const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { defaults, validatePolicy, applyPolicy } = require('../lib/project-policy');
const { suiteCounts, collectTestEvidence } = require('../lib/test-evidence');
const { compareScans } = require('../lib/reports');
const xml = (tests = 5, skipped = 1, failures = 0, errors = 0) => `<?xml version="1.0"?><testsuite name="Example" tests="${tests}" skipped="${skipped}" failures="${failures}" errors="${errors}"><testcase name="example"/></testsuite>`;

test('zero supported source files cannot pass a local gate even when no issues are found', () => {
  const r = { mode: 'local', scope: 'project', metrics: { files: 0 }, issues: [] };
  assert.equal(applyPolicy(r, { status: 'PASSED', checks: [] }).status, 'UNKNOWN');
  assert.equal(applyPolicy({ ...r, metrics: { files: 1 } }, { status: 'PASSED', checks: [] }).status, 'PASSED');
});

test('project policies reject malformed controls and preserve optional threshold inheritance', () => {
  assert.deepEqual(validatePolicy(defaults), defaults);
  for (const input of [null, [], { ...defaults, requireFull: 1 }, { ...defaults, minTests: 0.1 }, { ...defaults, minTests: -1 }, { ...defaults, gate: { coverage: 101, duplication: 5 } }]) assert.throws(() => validatePolicy(input));
});

test('Sonar success never overrides known local high risk; missing policy evidence never passes', () => {
  const clean = { mode: 'local', issues: [] }, passed = { status: 'PASSED', checks: [] };
  assert.equal(applyPolicy({ ...clean, mode: 'full', issues: [{ severity: 'HIGH', type: 'LOCAL' }] }, passed).status, 'FAILED');
  assert.equal(applyPolicy({ ...clean, policy: { ...defaults, requireFull: true } }, passed).status, 'UNKNOWN');
  assert.equal(applyPolicy({ ...clean, policy: { ...defaults, minTests: 1 } }, passed).status, 'UNKNOWN');
  assert.equal(applyPolicy({ ...clean, policy: { ...defaults, requireBrief: true } }, passed).status, 'FAILED');
  assert.equal(applyPolicy({ ...clean, policy: { ...defaults, blockMedium: true }, issues: [{ severity: 'MEDIUM' }] }, passed).status, 'FAILED');
  assert.equal(applyPolicy(clean, { status: 'UNKNOWN', checks: [] }).status, 'UNKNOWN');
  assert.equal(applyPolicy(clean, passed).status, 'PASSED');
});

test('test minima exclude skipped cases and failures block even with minimum disabled', () => {
  const scan = { mode: 'full', issues: [], policy: { ...defaults, minTests: 2 } }, gate = { status: 'PASSED' };
  const skipped = { available: true, executed: 1, skipped: 4, failures: 0, errors: 0 };
  assert.equal(applyPolicy({ ...scan, buildTests: skipped }, gate).status, 'FAILED');
  assert.equal(applyPolicy({ ...scan, buildTests: { ...skipped, executed: 2 } }, gate).status, 'PASSED');
  assert.equal(applyPolicy({ ...scan, policy: defaults, buildTests: { ...skipped, failures: 1 } }, gate).status, 'FAILED');
});

test('build evidence records real suite counts and rejects inconsistent, external or unsupported XML', () => {
  assert.deepEqual(suiteCounts(xml()), { tests: 5, skipped: 1, executed: 4, failures: 0, errors: 0 });
  for (const source of [xml(1, 2), xml(1, 0, 2), '<testsuites/>', xml().replace('tests="5"', 'tests="NaN"'), xml().replace('tests="5"', 'tests="5" tests="500"'), '<!DOCTYPE x>' + xml(), xml().replace('</testsuite>', '')]) assert.throws(() => suiteCounts(source));
});

test('Maven report collection covers modules and excludes skipped counts, sources and symlinks; any invalid report invalidates totals', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-tests-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [folder, source] of [['target/surefire-reports', xml()], ['module/target/failsafe-reports', xml(2, 0)]]) {
    await fs.mkdir(path.join(root, folder), { recursive: true }); await fs.writeFile(path.join(root, folder, 'TEST-Example.xml'), source);
  }
  await fs.mkdir(path.join(root, 'target/generated-sources'), { recursive: true });
  await fs.writeFile(path.join(root, 'target/generated-sources/TEST-Fake.xml'), xml(1000, 0));
  const result = await collectTestEvidence(root);
  assert.equal(result.available, true); assert.equal(result.executed, 6); assert.equal(result.skipped, 1); assert.equal(result.reports.length, 2);
  const stale = new Date('2000-01-01T00:00:00Z');
  await fs.utimes(path.join(root, 'target/surefire-reports/TEST-Example.xml'), stale, stale);
  await fs.utimes(path.join(root, 'module/target/failsafe-reports/TEST-Example.xml'), stale, stale);
  assert.equal((await collectTestEvidence(root, Date.now())).available, false);
  await fs.writeFile(path.join(root, 'target/surefire-reports/TEST-Bad.xml'), '<invalid/>');
  assert.equal((await collectTestEvidence(root)).available, false);
  const empty = path.join(root, 'empty'); await fs.mkdir(empty); assert.equal((await collectTestEvidence(empty)).available, false);
});

test('effective requirements and thresholds must match for baseline comparisons; unchanged resaves remain comparable', () => {
  const before = { id: 'a', projectId: 'p', mode: 'local', scope: 'project', status: 'completed', issues: [], policy: { ...defaults, id: 'old' }, settings: { gate: { coverage: 60, duplication: 5 } } };
  assert.equal(compareScans({ ...before, id: 'b', policy: { ...defaults, id: 'new' } }, before).available, true);
  assert.equal(compareScans({ ...before, policy: { ...defaults, requireFull: true } }, before).available, false);
  assert.equal(compareScans({ ...before, settings: { gate: { coverage: 80, duplication: 5 } } }, before).available, false);
});
