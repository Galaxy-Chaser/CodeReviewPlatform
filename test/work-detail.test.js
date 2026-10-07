const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Run actual handoff/detail templates and the shared cancellation coordinator with controllable transport. */
function fixture() {
  const work = fs.readFileSync(path.join(__dirname, '../public/work.js'), 'utf8'), ui = fs.readFileSync(path.join(__dirname, '../public/ui.js'), 'utf8'), app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const pending = [], rendered = [], timeouts = [], context = vm.createContext({ AbortController,
    AbortSignal: { timeout: () => { const controller = new AbortController(); timeouts.push(controller); return controller.signal; }, any: signals => AbortSignal.any(signals) }, viewedScanId: null, viewedPipelineId: null,
    workFormRow: null, workFormKind: null, workStatuses: { ready: '待领取' }, time: value => value, workHistoryDetail: () => '',
    api: (url, data, signal) => new Promise((resolve, reject) => pending.push({ url, signal, resolve, reject })) });
  vm.runInContext(ui.slice(ui.indexOf('let detailReadController')), context);
  Object.assign(context, { listData: {}, listRequests: {}, workData: null, githubPullData: null, stopWorkSync: () => {} });
  vm.runInContext(ui.slice(ui.indexOf('function releaseViewMemory('), ui.indexOf('\ndocument.addEventListener', ui.indexOf('function releaseViewMemory('))), context);
  vm.runInContext(app.slice(app.indexOf('function e('), app.indexOf('function time(')), context);
  vm.runInContext(app.slice(app.indexOf('function button('), app.indexOf('function toast(')), context);
  vm.runInContext(work.slice(work.indexOf('async function workRead('), work.indexOf('/** 连接页')), context);
  context.modal = (title, html) => { vm.runInContext('cancelDetailRead()', context); rendered.push({ title, html }); };
  context.workForm = (kind, row) => { context.workFormKind = kind; context.workFormRow = row; context.modal('Editor', row.title); };
  const result = (title = 'Current task') => ({ task: { id: 'task', title, description: 'Actual task', criteria: 'Actual checks', status: 'ready', requireReport: false, requirementVersion: 1, history: [] },
    requirement: { title: 'Current requirement', version: 2, allowedPaths: 'docs only', criteria: 'Check the real handoff' }, knowledge: [],
    coordination: { nextStep: 'Update the task before claiming', blockers: [{ message: 'Requirement changed' }], assessedAt: 'fixed time', limits: 'State snapshot only', historyRemaining: 99,
      ownership: { status: 'NONE', owner: null }, requirement: { status: 'CHANGED' }, submissionRequirement: { status: 'NONE' }, actions: ['edit', 'block'] } });
  return { context, pending, rendered, timeouts, result, run: code => vm.runInContext(code, context) };
}

test('task details use one context snapshot, expose current scope and suppress blocked actions', async () => {
  const f = fixture(), read = f.run("workDetail('tasks', 'task')");
  assert.equal(f.pending.length, 1); assert.equal(f.pending[0].url, '/api/work/context?id=task');
  f.pending[0].resolve(f.result()); await read;
  assert.equal(f.context.workFormRow.title, 'Current task'); assert.equal(f.rendered.length, 1);
  assert.match(f.rendered[0].html, /docs only/); assert.match(f.rendered[0].html, /Check the real handoff/);
  assert.match(f.rendered[0].html, /Requirement changed/); assert.doesNotMatch(f.rendered[0].html, /data-task-action="claim"/);
  assert.match(f.rendered[0].html, /data-action="work-edit"/); assert.equal(f.run('detailReadController'), null);
});

test('closed or replaced handoff reads cannot reopen a dialog or overwrite an unsaved editing snapshot', async () => {
  for (const editing of [false, true]) {
    const f = fixture(), read = f.run("workDetail('tasks', 'task')");
    f.run('cancelDetailRead()'); if (editing) f.context.workFormRow = { title: 'Unsaved input' };
    assert.equal(f.pending[0].signal.aborted, true); f.pending[0].resolve(f.result('Old response')); await read;
    assert.equal(f.rendered.length, 0); assert.equal(f.context.workFormRow?.title, editing ? 'Unsaved input' : undefined);
  }
});

test('latest detail wins, obsolete errors are ignored, and a real read error permits retry', async () => {
  const f = fixture(), old = f.run("workDetail('tasks', 'old')"), current = f.run("workDetail('tasks', 'new')");
  f.pending[1].resolve(f.result('New response')); await current; f.pending[0].reject(Error('Late old failure')); await old;
  assert.equal(f.rendered[0].title, 'New response');
  const failed = f.run("workDetail('tasks', 'retry')"); f.pending[2].reject(Error('Connection interrupted'));
  await assert.rejects(failed, /Connection interrupted/); assert.equal(f.run('detailReadController'), null);
  const retry = f.run("workDetail('tasks', 'retry')"); f.pending[3].resolve(f.result('Recovered')); await retry;
  assert.equal(f.rendered[1].title, 'Recovered');
});

test('authored task and suggested-knowledge titles are escaped as literal text', async () => {
  const f = fixture(), read = f.run("workDetail('tasks', 'task')"), result = f.result('<img src=x onerror=alert(1)>');
  result.knowledge = [{ id: 'knowledge', title: '<script>bad()</script>' }];
  result.requirement.allowedPaths = '<b>docs only</b>';
  f.pending[0].resolve(result); await read;
  assert.equal(f.rendered[0].title, '&lt;img src=x onerror=alert(1)&gt;');
  assert.match(f.rendered[0].html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.doesNotMatch(f.rendered[0].html, /<script>|<img/);
  assert.match(f.rendered[0].html, /&lt;b&gt;docs only&lt;\/b&gt;/);
});

test('navigation cancels an outstanding handoff read even before a dialog has opened', async () => {
  const f = fixture(), read = f.run("workDetail('tasks', 'task')");
  f.run("releaseViewMemory('settings')"); assert.equal(f.pending[0].signal.aborted, true);
  f.pending[0].resolve(f.result('Obsolete page')); await read;
  assert.equal(f.rendered.length, 0); assert.equal(f.context.workFormRow, null);
});

test('a detail timeout reports retry, releases its slot and allows a new successful read', async () => {
  const f = fixture(), read = f.run("workDetail('tasks', 'task')");
  f.timeouts[0].abort(); assert.equal(f.pending[0].signal.aborted, true);
  f.pending[0].reject(Object.assign(Error('Timed out'), { name: 'TimeoutError' }));
  await assert.rejects(read, /读取协作详情超时/); assert.equal(f.run('detailReadController'), null);
  const retry = f.run("workDetail('tasks', 'task')"); f.pending[1].resolve(f.result('Recovered after timeout')); await retry;
  assert.equal(f.rendered[0].title, 'Recovered after timeout');
});

test('delayed edit reads cannot reopen a closed dialog, replace a newer form or cross navigation', async () => {
  for (const replacement of ['close', 'edit', 'navigate']) {
    const f = fixture(), old = f.run("workEdit('tasks', 'old')");
    assert.equal(f.pending[0].url, '/api/work/detail?kind=tasks&id=old');
    if (replacement === 'navigate') f.run("releaseViewMemory('settings')");
    else if (replacement === 'edit') f.context.workForm('tasks', { title: 'Unsaved new form' });
    else f.run('cancelDetailRead()');
    assert.equal(f.pending[0].signal.aborted, true);
    f.pending[0].resolve({ row: { title: 'Obsolete editor' } }); await old;
    assert.equal(f.rendered.length, replacement === 'edit' ? 1 : 0);
    assert.equal(f.context.workFormRow?.title, replacement === 'edit' ? 'Unsaved new form' : undefined);
  }
  const f = fixture(), old = f.run("workEdit('tasks', 'old')"), latest = f.run("workEdit('tasks', 'latest')");
  f.pending[1].resolve({ row: { title: 'Latest editor' } }); await latest;
  f.pending[0].reject(Error('Obsolete failure')); await old;
  assert.equal(f.rendered.length, 1); assert.equal(f.context.workFormRow.title, 'Latest editor');
});

test('the latest evidence warning survives task rebinding and distinguishes unrecorded legacy versions', async () => {
  for (const [status, warning] of [['CHANGED', '旧需求，需重新验证'], ['UNKNOWN', '未记录需求版本，需核对并重新验证'], ['CURRENT', '']]) {
    const f = fixture(), read = f.run("workDetail('tasks', 'task')"), result = f.result();
    result.coordination.requirement.status = 'CURRENT'; result.task.requirementVersion = 2;
    result.coordination.submissionRequirement.status = status;
    result.task.submission = { summary: 'Historical work', changedFiles: ['docs/result.md'], tests: 'Original executed checks' };
    f.pending[0].resolve(result); await read;
    if (warning) assert.ok(f.rendered[0].html.includes(warning));
    else assert.doesNotMatch(f.rendered[0].html, /旧需求，需重新验证|未记录需求版本/);
    assert.match(f.rendered[0].html, /Original executed checks/);
  }
});
