const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reportView } = require('../lib/report-view');
const { repairTasks, repairTaskPage } = require('../lib/reports');

test('display evidence stays small while preserving counts, version proof and comparison outcomes', () => {
  const issues = Array.from({ length: 1000 }, (_, n) => ({ severity: 'HIGH', file: `src/File${n}.java`, message: 'Finding '.repeat(30), rule: 'empty-catch', line: n + 1 }));
  const report = { id: 'report', status: 'completed', scope: 'project', gate: { status: 'FAILED', checks: [] }, issues,
    logs: 'Actual scan log', sourceSnapshot: { digest: 'abc123', scope: 'project', files: Array.from({ length: 2000 }, (_, n) => ({ file: `src/File${n}.java`, digest: 'x'.repeat(64) })) },
    issueReviewLedger: issues, codingBrief: { goal: 'Original requirement' }, comparison: { available: true, added: issues.slice(0, 40), removed: issues.slice(0, 10), unchanged: 960, delta: { complexity: 2 } } };
  const before = JSON.stringify(report), view = reportView(report);
  assert.equal(view.issueCount, 1000); assert.equal(view.severityCounts.HIGH, 1000);
  assert.deepEqual(view.sourceSnapshot, { digest: 'abc123', scope: 'project', fileCount: 2000 });
  assert.equal(view.comparison.addedCount, 40); assert.equal(view.comparison.removedCount, 10);
  assert.equal(view.comparison.unchanged, 960); assert.equal(view.comparison.delta.complexity, 2);
  assert.equal(view.logs, report.logs); assert.equal(view.gate.status, 'FAILED');
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < Buffer.byteLength(before) / 100);
  assert.equal(JSON.stringify(report), before);
  assert.equal(reportView({ ...report, comparison: { available: false, reason: 'Different scope' } }).comparison.reason, 'Different scope');
});

test('repair pages match complete exports without missing or repeated findings, including equal occurrences', () => {
  const scan = { issues: Array.from({ length: 62 }, (_, n) => ({ file: `src/${n % 3}.java`, severity: n % 2 ? 'LOW' : 'HIGH', rule: 'empty-catch', line: n + 1, trackingId: String(n) })) };
  const before = JSON.stringify(scan), all = repairTasks(scan), pages = [0, 25, 50].map(offset => repairTaskPage(scan, offset));
  assert.deepEqual(pages.map(page => page.tasks.length), [25, 25, 12]);
  assert.deepEqual(pages.flatMap(page => page.tasks), all);
  assert.equal(new Set(pages.flatMap(page => page.tasks.map(task => task.trackingId))).size, 62);
  assert.equal(pages[2].tasks[0].number, 51); assert.equal(pages[2].tasks[11].number, 62);
  assert.equal(repairTaskPage(scan, 100).tasks.length, 0);
  assert.equal(repairTaskPage({ issues: [] }).total, 0);
  for (const offset of [-1, 0.5, NaN, 10000001]) assert.throws(() => repairTaskPage(scan, offset));
  assert.equal(JSON.stringify(scan), before);
});

test('PR detail requests only display evidence and the selected repair page', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const functions = source.slice(source.indexOf('async function githubDetail('), source.indexOf('function modal(')) +
    source.slice(source.indexOf('function repairTaskList('), source.indexOf('/** Load only 25'));
  const requests = [], rendered = [];
  const context = vm.createContext({
    beginDetailRead: () => ({ current: () => true }),
    api: async url => {
      requests.push(url);
      return url.includes('/report/view') ? { repository: 'owner/repo', number: 12, title: 'Review', gate: { status: 'FAILED' }, notes: [], changedFiles: 2, checkedFiles: 2, touchedTests: 0 }
        : { tasks: [{ number: 26, message: 'Second page finding', severity: 'HIGH', file: 'Flow.java', rule: 'empty-catch', line: 27, excerpt: 'catch (Exception e) {}', advice: 'Handle exceptions', verification: 'Run tests' }], total: 26, offset: 25, limit: 25 };
    }, e: value => String(value ?? ''), badge: value => value, acceptanceBadge: () => 'blocked', severityNames: { HIGH: 'High' },
    button: (title, action, attrs) => `<button data-action="${action}" ${attrs}>${title}</button>`,
    issueReviewControls: () => 'Review controls', modal: (title, html) => rendered.push({ title, html })
  });
  vm.runInContext(functions, context); await vm.runInContext("githubDetail('report-id', 25)", context);
  assert.deepEqual(requests, ['/api/report/view?id=report-id', '/api/tasks/page?id=report-id&offset=25']);
  assert.match(rendered[0].html, /26\. Second page finding/); assert.match(rendered[0].html, /Review controls/);
  assert.match(rendered[0].html, /catch \(Exception e\) \{\}/); assert.match(rendered[0].html, /data-github="true"/);
  assert.match(rendered[0].html, /上一页/); assert.doesNotMatch(rendered[0].html, /下一页/);
});
