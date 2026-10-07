const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { reviewPull, repository, patchRanges, listPulls } = require('../lib/github');
const { checklist, validateAcceptance, acceptanceStatus } = require('../lib/acceptance');
const { scanLocal } = require('../lib/rules');
const { tasksMarkdown } = require('../lib/reports');
const { writeSarif } = require('../lib/sarif');

/** Represent a GitHub snapshot including the real blob hash and full diff metadata. */
function fixture(options = {}) {
  const source = options.source || 'class Change {\n String password = "liveCredential987";\n void run() { try {} catch(Exception e) {} }\n}\n';
  const sha = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
  const rows = source.trimEnd().split('\n');
  const file = { filename: 'src/Change.java', status: 'added', additions: rows.length, deletions: 0, sha, patch: `@@ -0,0 +1,${rows.length} @@\n${rows.map(r => '+' + r).join('\n')}`, ...options.file };
  const pr = { title: 'Quality', head: { sha: 'a'.repeat(40), repo: { full_name: 'owner/fork' } }, base: { sha: 'b'.repeat(40) }, changed_files: 1, ...options.pr };
  const calls = [];
  const get = async (endpoint, token) => {
    calls.push([endpoint, token]);
    if (endpoint.endsWith('/files?per_page=100')) return [file];
    if (endpoint.includes('/contents/')) return { type: 'file', encoding: 'base64', sha, size: Buffer.byteLength(source), content: Buffer.from(source).toString('base64'), ...options.content };
    return calls.length > 1 && options.updated ? { ...pr, head: { ...pr.head, sha: 'c'.repeat(40) } } : pr;
  };
  return { get, calls, file };
}

test('PR snapshot finds new risks, masks credentials and exports fixed commit evidence', async () => {
  const f = fixture();
  const report = await reviewPull('https://github.com/owner/repo', 12, 'private-token', undefined, f.get);
  assert.equal(report.gate.status, 'FAILED');
  assert.deepEqual(report.issues.map(i => i.rule).sort(), ['empty-catch', 'hardcoded-secret']);
  assert.equal(report.checkedFiles, 1);
  assert.ok(f.calls.some(([endpoint]) => endpoint.includes('ref=' + 'a'.repeat(40))));
  assert.ok(f.calls.every(([, token]) => token === 'private-token'));
  assert.ok(!JSON.stringify(report).includes('liveCredential987'));
  assert.ok(!JSON.stringify(report).includes('private-token'));
  const markdown = tasksMarkdown(report, { name: 'PR' });
  assert.match(markdown, /HEAD：aaaaaaaa/);
  assert.match(markdown, /人工验收记录/);
  assert.match(markdown, /GitHub PR 改动/);
  const chunks = [];
  await writeSarif({ write: async (buffer, offset, length) => { chunks.push(Buffer.from(buffer.subarray(offset, offset + length))); return { bytesWritten: length }; } }, report);
  const sarif = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(sarif.runs[0].results.length, 2); assert.equal(sarif.runs[0].properties.gateStatus, 'FAILED');
  assert.equal(sarif.runs[0].versionControlProvenance[0].revisionId, report.headSha);
  assert.ok(!JSON.stringify(sarif).includes('liveCredential987')); assert.ok(!JSON.stringify(sarif).includes('private-token'));
});

test('PR missing or truncated patches, deleted files and excluded folders never produce a false pass', async () => {
  for (const file of [{ patch: null }, { additions: 50 }, { status: 'removed' }, { filename: 'target/Change.java' }]) {
    const f = fixture({ file });
    const report = await reviewPull('owner/repo', 1, '', undefined, f.get);
    assert.equal(report.gate.status, 'UNKNOWN');
    assert.equal(report.checkedFiles, 0);
  }
});

test('PR update, invalid blob, oversized PR and unsafe paths are rejected', async () => {
  for (const options of [{ updated: true }, { content: { content: Buffer.from('tampered').toString('base64') } }, { pr: { changed_files: 101 } }, { file: { filename: '../Change.java' } }]) {
    const f = fixture(options);
    await assert.rejects(reviewPull('owner/repo', 1, '', undefined, f.get));
  }
  assert.throws(() => repository('https://evil.example/repo'));
  await assert.rejects(reviewPull('owner/repo', -1, ''));
});

test('PR findings stay within changed lines and pure deletions retain surviving context', async () => {
  const f = fixture({ source: 'class Change {\n void old() { List.of(); }\n void added() {}\n}\n', file: { patch: '@@ -2,1 +2,2 @@\n void old() { List.of(); }\n+ void added() {}', additions: 1, status: 'modified' } });
  const report = await reviewPull('owner/repo', 1, '', undefined, f.get);
  assert.equal(report.issues.length, 0);
  assert.equal(report.gate.status, 'PASSED');
  assert.deepEqual(patchRanges('@@ -4,2 +4,1 @@\n- log(error);\n }'), [[3, 4]]);
});

test('PR selection lists open requests with a stated 30 item limit', async () => {
  const result = await listPulls('owner/repo', '', async endpoint => {
    assert.match(endpoint, /state=open/); assert.match(endpoint, /per_page=30/);
    return [{ number: 7, title: 'Test', user: { login: 'developer' }, draft: true }];
  });
  assert.equal(result.limit, 30); assert.equal(result.pulls[0].number, 7);
});

test('acceptance requires real evidence and never overrides failed or incomplete automatic checks', () => {
  const input = Object.fromEntries(checklist.map(c => [c.id, { checked: true, evidence: '验证边界情况并确认符合预期' }]));
  const acceptance = validateAcceptance(input);
  assert.equal(acceptanceStatus({ status: 'completed', gate: { status: 'PASSED' }, acceptance }), 'REVIEWED');
  for (const status of ['FAILED', 'UNKNOWN']) assert.equal(acceptanceStatus({ status: 'completed', gate: { status }, acceptance }), 'BLOCKED');
  assert.equal(acceptanceStatus({ status: 'completed', gate: { status: 'PASSED' } }), 'PENDING');
  input.tests.evidence = 'OK'; assert.throws(() => validateAcceptance(input), /至少 8 字/);
  assert.throws(() => validateAcceptance({}));
});

test('risk rules flag operations, redact evidence and exclude literal/comment examples', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-rules-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'Risk.java'), 'class Risk {\n String token = "credentialValue";\n void run() { Runtime.getRuntime().exec("command"); }\n // String password = "ignoredValue";\n String example = "password = \\"not-real\\"";\n}\n');
  await fs.writeFile(path.join(root, 'V2__drop.sql'), "-- DROP TABLE ignored;\nSELECT 'TRUNCATE TABLE text';\nDROP TABLE accounts;\n");
  const result = await scanLocal(root);
  assert.deepEqual(result.issues.map(i => i.rule).sort(), ['destructive-sql', 'hardcoded-secret', 'process-execution']);
  assert.ok(!JSON.stringify(result).includes('credentialValue'));
});
