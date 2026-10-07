const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { writeSarif } = require('../lib/sarif');

/** Fixed saved-report examples include private fields which the portable result must omit. */
function report(issues = []) {
  return { id: crypto.randomUUID(), status: 'completed', mode: 'local', scope: 'project', issues,
    settings: { localRuleVersion: 3, token: 'private-token' }, gate: { status: 'FAILED' }, logs: 'private-log',
    sourceSnapshot: { digest: 'd'.repeat(64), root: 'C:/private-root' } };
}
function issue(extra = {}) { return { type: 'LOCAL', rule: 'empty-catch', severity: 'HIGH', message: '异常需要明确处理', file: 'src/Change.java', line: 4, ...extra }; }
/** Simulate short filesystem writes to verify byte-accurate Unicode and incremental fragments. */
async function output(scan, partial = false) {
  const chunks = [];
  await writeSarif({ write: async (buffer, offset, length) => {
    const bytesWritten = partial ? Math.min(7, length) : length;
    chunks.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten))); return { bytesWritten };
  } }, scan);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('mixed-tool SARIF preserves findings, original risk and reviews without exporting private bodies or suppressing findings', async () => {
  const scan = report([issue({ endLine: 6, review: { status: 'dismissed', reason: 'private-review' }, excerpt: 'private-source' }),
    issue({ type: 'BUG', rule: 'java:S100', severity: 'MAJOR', message: 'Sonar finding' }), issue({ severity: 'LOW' })]);
  scan.mode = 'full'; scan.sonarGate = { status: 'ERROR' }; const before = JSON.stringify(scan), result = await output(scan, true);
  assert.equal(result.version, '2.1.0'); assert.equal(result.runs.length, 2);
  const [local, sonar] = result.runs;
  assert.equal(local.tool.driver.name, 'CodeHealth local rules'); assert.equal(local.tool.driver.version, '3');
  assert.equal(sonar.tool.driver.name, 'SonarQube'); assert.equal(sonar.tool.driver.version, undefined);
  assert.equal(sonar.conversion.tool.driver.name, 'CodeHealth SARIF exporter');
  assert.equal(local.results.length, 2); assert.equal(sonar.results.length, 1); assert.equal(local.tool.driver.rules.length, 1);
  assert.equal(local.results[0].level, 'error'); assert.equal(local.results[1].level, 'note'); assert.equal(sonar.results[0].level, 'warning');
  assert.equal(local.results[0].properties.reviewStatus, 'dismissed'); assert.equal(local.results[0].suppressions, undefined);
  assert.deepEqual(local.results[0].locations[0].physicalLocation.region, { startLine: 4, endLine: 6 });
  assert.equal(local.properties.gateStatus, 'FAILED'); assert.equal(local.properties.recordedSourceDigest, 'd'.repeat(64));
  assert.equal(sonar.properties.sonarGateStatus, 'ERROR');
  assert.equal(local.originalUriBaseIds['%SRCROOT%'].uri, undefined);
  for (const secret of ['private-token', 'private-log', 'private-root', 'private-review', 'private-source']) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(JSON.stringify(scan), before);
});

test('all severities map consistently; URI paths preserve literal reserved characters and missing lines stay unknown', async () => {
  const risks = ['BLOCKER', 'CRITICAL', 'HIGH', 'MAJOR', 'MEDIUM', 'MINOR', 'LOW', 'INFO'];
  const result = await output(report(risks.map(severity => issue({ severity, file: 'src\\中文 #?%2e%2e\\Change.java' }))));
  assert.deepEqual(result.runs[0].results.map(r => r.level), ['error', 'error', 'error', 'warning', 'warning', 'note', 'note', 'note']);
  const physical = result.runs[0].results[0].locations[0].physicalLocation;
  assert.equal(physical.artifactLocation.uri, 'src/%E4%B8%AD%E6%96%87%20%23%3F%252e%252e/Change.java');
  assert.equal(physical.artifactLocation.uriBaseId, '%SRCROOT%');
  const unknown = await output(report([issue({ line: undefined })]));
  assert.equal(unknown.runs[0].results[0].locations[0].physicalLocation.region, undefined);
  const multiline = await output(report([issue({ message: '实际问题\n第二行说明 🔍' })]), true);
  assert.equal(multiline.runs[0].results[0].message.text, '实际问题\n第二行说明 🔍');
});

test('empty, changed-scope and fixed-commit PR exports describe recorded scope without claiming current source or test success', async () => {
  const empty = await output(report()); assert.deepEqual(empty.runs[0].results, []);
  const changed = await output({ ...report([issue()]), scope: 'changed', gate: { status: 'UNKNOWN' } });
  assert.equal(changed.runs[0].properties.scanScope, 'changed'); assert.equal(changed.runs[0].properties.gateStatus, 'UNKNOWN');
  const pr = await output({ ...report([issue()]), scope: 'github', repository: 'owner/repo', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) });
  assert.deepEqual(pr.runs[0].versionControlProvenance, [{ repositoryUri: 'https://github.com/owner/repo', revisionId: 'a'.repeat(40) }]);
  assert.equal(pr.runs[0].properties.baseSha, 'b'.repeat(40)); assert.equal(pr.runs[0].properties.scanScope, 'github');
  assert.equal(pr.runs[0].results[0].partialFingerprints, undefined);
  assert.match(pr.runs[0].properties.limits, /不证明/);
});

test('incomplete, malformed or unsafe reports are rejected before writing any bytes', async () => {
  const invalid = [
    { ...report(), status: 'running' }, { ...report(), status: 'failed' }, { ...report(), issues: null },
    { ...report(), issues: Array(20001).fill(issue()) }, { ...report(), mode: 'invented' }, { ...report(), scope: '' },
    { ...report(), gate: { status: 'invented' } }, { ...report(), scope: 'changed', mode: 'full' },
    ...['../escape.java', 'src/../escape.java', '/root/escape.java', 'C:\\escape.java', '\\\\host\\share.java', 'https://evil.invalid/a.java', 'src//A.java', 'src/./A.java', 'src/A\n.java', ''].map(file => report([issue({ file })])),
    ...[0, -1, 2.5, '4', NaN].map(line => report([issue({ line })])),
    report([issue({ endLine: 2 })]), report([issue({ line: undefined, endLine: 5 })]), report([issue({ type: 'invented' })]),
    report([issue({ severity: 'invented' })]), report([issue({ message: '' })]), report([issue({ rule: '' })]),
    report([issue({ message: 'x'.repeat(10001) })]), { ...report(), scope: 'github', repository: '../bad', headSha: 'x', baseSha: 'x' },
    { ...report(), scope: 'github', repository: 'owner/..', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
    { ...report(), scope: 'github', repository: 'owner/repo', headSha: 'a'.repeat(41), baseSha: 'b'.repeat(40) }
  ];
  for (const scan of invalid) {
    let writes = 0;
    await assert.rejects(writeSarif({ write: async () => { writes++; return { bytesWritten: 1 }; } }, scan));
    assert.equal(writes, 0);
  }
});

test('large exports retain duplicates and all 20000 findings while writing bounded fragments; byte limits reject instead of truncating', async () => {
  let findings = 0, maxFragment = 0;
  const sink = { write: async (buffer, offset, length) => { maxFragment = Math.max(maxFragment, length); if (buffer.toString('utf8', offset, offset + length).includes('"ruleId"')) findings++; return { bytesWritten: length }; } };
  await writeSarif(sink, report(Array(20000).fill(issue())));
  assert.equal(findings, 20000); assert.ok(maxFragment < 4096);
  await assert.rejects(writeSarif(sink, report(Array(1700).fill(issue({ message: 'x'.repeat(10000) })))), /16 MiB/);
});

test('short or failing writes never silently produce a successful SARIF export', async () => {
  await assert.rejects(writeSarif({ write: async () => ({ bytesWritten: 0 }) }, report([issue()])), /写入失败/);
  await assert.rejects(writeSarif({ write: async () => { throw Error('Disk full'); } }, report([issue()])), /Disk full/);
});

test('Markdown repair evidence also labels unknown lines instead of inventing locations', () => {
  const { tasksMarkdown } = require('../lib/reports');
  const scan = { ...report([issue({ line: undefined })]), sourceSnapshot: undefined };
  const markdown = tasksMarkdown(scan, { name: 'Unknown location' });
  assert.match(markdown, /src\/Change.java:行号未提供/); assert.ok(!markdown.includes(':undefined'));
});
