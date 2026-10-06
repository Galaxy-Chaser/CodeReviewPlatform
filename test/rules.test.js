const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanLocal, codeOnly } = require('../lib/rules');
const { evaluateGate, importAnalysis } = require('../lib/sonar');
const http = require('node:http');

test('known faulty Java fixture produces exactly five actionable findings', async () => {
  const result = await scanLocal(path.join(__dirname, '../examples/java8-fixture'));
  assert.equal(result.files, 3);
  assert.equal(result.issues.length, 5);
  assert.deepEqual(result.issues.map(i => i.rule).sort(), ['debug-output', 'empty-catch', 'java8-api', 'migration-version', 'todo']);
  assert.equal(result.issues.find(i => i.rule === 'java8-api').line, 9);
});
test('strings, comments and build outputs do not cause compatibility findings', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-rules-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'Safe.java'), '// List.of()\nclass Safe { String s = "System.out.println()"; /* catch(e) {} */ }');
  await fs.mkdir(path.join(dir, 'target'));
  await fs.writeFile(path.join(dir, 'target', 'Generated.java'), 'List.of();');
  const result = await scanLocal(dir);
  assert.equal(result.issues.length, 0);
  assert.equal(result.files, 1);
  assert.equal(codeOnly('/* x\nx */').split('\n').length, 2);
});
test('disabled local rules are excluded', async () => {
  const result = await scanLocal(path.join(__dirname, '../examples/java8-fixture'), ['todo']);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].rule, 'todo');
});
test('Java 8 starter has no local findings', async () => {
  const result = await scanLocal(path.join(__dirname, '../examples/java8-starter'));
  assert.equal(result.files, 2);
  assert.equal(result.issues.length, 0);
});
test('duplicate versions are scoped to migration directories', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-sql-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ['a', 'b']) { await fs.mkdir(path.join(dir, name)); await fs.writeFile(path.join(dir, name, 'V1__init.sql'), 'select 1;'); }
  assert.equal((await scanLocal(dir)).issues.length, 0);
});
test('new code gates use thresholds and never pass absent measures', () => {
  const gate = { coverage: 60, duplication: 5 };
  assert.equal(evaluateGate({ new_coverage: 60, new_duplicated_lines_density: 5 }, [], gate).status, 'PASSED');
  assert.equal(evaluateGate({ new_coverage: 59, new_duplicated_lines_density: 4 }, [], gate).status, 'FAILED');
  assert.equal(evaluateGate({}, [], gate).status, 'UNKNOWN');
  assert.equal(evaluateGate({ new_coverage: 99, new_duplicated_lines_density: 0 }, [{ severity: 'CRITICAL', type: 'BUG' }], gate).status, 'FAILED');
  assert.equal(evaluateGate({ new_coverage: 99, new_duplicated_lines_density: 0 }, [{ severity: 'MINOR', type: 'VULNERABILITY' }], gate).status, 'FAILED');
});
test('Sonar integration imports measures, all issues and separate server gate', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    const url = new URL(req.url, 'http://localhost');
    let data;
    if (url.pathname === '/api/measures/component') data = { component: { measures: [{ metric: 'coverage', value: '77.3' }, { metric: 'new_coverage', period: { value: '81' } }, { metric: 'new_duplicated_lines_density', period: { value: '2' } }, { metric: 'security_hotspots', value: '3' }] } };
    if (url.pathname === '/api/issues/search') data = { paging: { total: 1 }, issues: [{ key: 'x', rule: 'java:S1', component: 'bid:src/A.java', line: 7, message: 'Fix', severity: 'MAJOR', type: 'CODE_SMELL', status: 'OPEN' }] };
    if (url.pathname === '/api/qualitygates/project_status') data = { projectStatus: { status: 'ERROR' } };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const report = await importAnalysis({ sonarUrl: `http://127.0.0.1:${server.address().port}`, gate: { coverage: 60, duplication: 5 } }, 'bid', 'test-token');
  assert.equal(report.metrics.coverage, 77.3);
  assert.equal(report.metrics.security_hotspots, 3);
  assert.equal(report.issues[0].file, 'src/A.java');
  assert.equal(report.gate.status, 'PASSED');
  assert.equal(report.sonarGate.status, 'ERROR');
});
