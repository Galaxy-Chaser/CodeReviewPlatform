const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Run the actual request coordinator with controllable delayed responses, independent of network timing. */
function coordinator() {
  const pending = [], renders = [], records = {};
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const fragment = source.slice(0, source.indexOf('/** Escape every user-controlled'));
  const document = { querySelector: selector => selector === '#quality-records' ? records : null, activeElement: {} };
  const context = vm.createContext({ document, AbortController, URLSearchParams,
    api: (url, data, signal) => new Promise(resolve => pending.push({ url, signal, resolve })),
    render: () => renders.push('render'), qualityRecords: list => JSON.stringify(list.rows) });
  vm.runInContext(fragment + "\nstate = {revision: 1}; page = 'issues';", context);
  return { context, pending, renders, records, run: code => vm.runInContext(code, context) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('an older delayed search cannot replace a newer result, even if its aborted response still resolves', async () => {
  const f = coordinator();
  f.run("search='old'; currentList('issues'); search='new'; currentList('issues');");
  assert.equal(f.pending[0].signal.aborted, true);
  f.pending[1].resolve({ rows: [{ message: 'new result' }], total: 1, offset: 0, limit: 25, revision: 1 }); await tick();
  f.pending[0].resolve({ rows: [{ message: 'old result' }], total: 1, offset: 0, limit: 25, revision: 1 }); await tick();
  assert.equal(f.run('listData.issues.rows[0].message'), 'new result');
  assert.equal(f.renders.length, 1);
});
test('quality page responses update only records, preserving an in-progress GitHub form', async () => {
  const f = coordinator();
  f.run("page='quality'; currentList('quality');");
  f.pending[0].resolve({ rows: [{ id: 'review' }], total: 1, offset: 0, limit: 25, revision: 1 }); await tick();
  assert.equal(f.renders.length, 0);
  assert.equal(f.records.outerHTML, '[{"id":"review"}]');
});

/** Exercise actual detail functions with delayed responses that deliberately ignore cancellation. */
function detailCoordinator() {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../public/ui.js'), 'utf8');
  const pending = [], rendered = [], dialog = { open: true, scrollTop: 0 };
  const context = vm.createContext({ AbortController, state: { projects: [] }, viewedScanId: 'first', viewedPipelineId: null,
    $: () => dialog, e: value => String(value ?? ''), time: value => value, badge: () => '', progress: () => '',
    reviewSummaryPanel: () => '', gateEvidence: () => '', sourceVersionPanel: () => '', stat: () => '', metric: () => '', num: () => '', button: () => '', issueCount: value => value.issueCount,
    api: (url, data, signal) => new Promise(resolve => pending.push({ url, signal, resolve })) });
  vm.runInContext(ui.slice(ui.indexOf('let detailReadController')), context);
  context.modal = (title, html) => { vm.runInContext('cancelDetailRead(); viewedScanId = null; viewedPipelineId = null;', context); rendered.push({ title, html }); };
  vm.runInContext(app.slice(app.indexOf('async function scanDetail('), app.indexOf('async function exportReport(')), context);
  const report = id => ({ id, status: 'completed', gate: { status: 'FAILED' }, comparison: { available: false }, metrics: {}, logs: id });
  return { context, pending, rendered, dialog, report, run: code => vm.runInContext(code, context) };
}

test('late polling results cannot reopen a closed report or overwrite an editing dialog', async () => {
  for (const close of [true, false]) {
    const f = detailCoordinator(), read = f.run("scanDetail('first', true)");
    if (close) { f.dialog.open = false; f.run('cancelDetailRead()'); }
    else f.context.modal('Editing evidence', 'Unsaved input');
    assert.equal(f.pending[0].signal.aborted, true);
    f.pending[0].resolve(f.report('first')); await read;
    assert.equal(f.rendered.length, close ? 0 : 1);
    if (!close) assert.equal(f.rendered[0].html, 'Unsaved input');
  }
});

test('latest detail request wins when older results arrive last', async () => {
  const f = detailCoordinator(), first = f.run("scanDetail('first')"), second = f.run("scanDetail('second')");
  assert.equal(f.pending[0].signal.aborted, true);
  f.pending[1].resolve(f.report('second')); await second;
  f.pending[0].resolve(f.report('first')); await first;
  assert.equal(f.rendered.length, 1); assert.match(f.rendered[0].html, /second/);
  assert.equal(f.run('detailReadController'), null);
});

test('failed detail requests release their slot and background reads do not cancel foreground work', async () => {
  const f = detailCoordinator(), app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  f.context.fetch = async () => { throw new Error('Connection interrupted'); };
  vm.runInContext(app.slice(app.indexOf('async function api('), app.indexOf('async function refresh(')), f.context);
  await assert.rejects(f.run("scanDetail('first', true)"), /Connection interrupted/);
  assert.equal(f.run('detailReadController'), null);
  assert.equal(f.run("beginDetailRead(true, 'scan', 'first') !== null"), true);
  f.run('cancelDetailRead(); beginDetailRead();');
  assert.equal(f.run("beginDetailRead(true, 'scan', 'first')"), null);
});

/** Load the real repair and PR detail functions; delayed test transports may ignore aborted signals. */
function repairCoordinator() {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const ui = fs.readFileSync(path.join(__dirname, '../public/ui.js'), 'utf8');
  const pending = [], rendered = [], dialog = { open: true };
  const context = vm.createContext({ AbortController, URLSearchParams, state: { projects: [] },
    viewedScanId: null, viewedPipelineId: null, repairReturn: null, reviewNames: {}, severityNames: {},
    $: () => dialog, e: value => String(value ?? ''), time: value => value, badge: value => value || '',
    button: () => '', acceptanceBadge: () => '', issueReviewControls: () => '', issueLine: value => value,
    api: (url, data, signal) => new Promise(resolve => pending.push({ url, signal, resolve })) });
  vm.runInContext(ui.slice(ui.indexOf('let detailReadController')), context);
  context.modal = (title, html) => { vm.runInContext('cancelDetailRead(); repairReturn = null;', context); rendered.push({ title, html }); };
  vm.runInContext(app.slice(app.indexOf('function reviewSummaryPanel('), app.indexOf('/** Compare stable')), context);
  vm.runInContext(app.slice(app.indexOf('async function githubDetail('), app.indexOf('function modal(')), context);
  const result = filters => ({ scan: { gate: { status: 'FAILED' } }, filters, summary: { available: true, complete: true, total: 62,
    files: 1, risk: { high: 62, medium: 0, low: 0, unknown: 0 }, review: { open: 61, confirmed: 1, fixing: 0, dismissed: 0, unknown: 0 } },
    total: 0, offset: 0, limit: 25, tasks: [] });
  const pr = { gate: { status: 'FAILED' }, notes: [], repository: 'owner/repo', number: 1, title: 'fixed report' };
  return { context, pending, rendered, result, pr, run: code => vm.runInContext(code, context) };
}

test('latest repair and PR filters win; late results cannot replace a closed or editing dialog', async () => {
  for (const github of [false, true]) {
    const f = repairCoordinator(), method = github ? 'githubDetail' : 'showTasks', width = github ? 2 : 1;
    const first = f.run(`${method}('report', 25, {risk:'high', review:'open'})`);
    const second = f.run(`${method}('report', 0, {risk:'medium', review:'confirmed'})`);
    assert.equal(f.pending[0].signal.aborted, true);
    assert.match(f.pending[width * 2 - 1].url, /risk=medium&review=confirmed/);
    if (github) f.pending[width].resolve(f.pr);
    f.pending[width * 2 - 1].resolve(f.result({ risk: 'medium', review: 'confirmed' })); await second;
    if (github) f.pending[0].resolve(f.pr);
    f.pending[width - 1].resolve(f.result({ risk: 'high', review: 'open' })); await first;
    assert.equal(f.rendered.length, 1); assert.match(f.rendered[0].html, /原.*门禁|FAILED/);
    assert.match(f.rendered[0].html, /报告全部 62 条/); assert.match(f.rendered[0].html, /没有匹配问题/);
    assert.equal(f.run('repairReturn.risk'), 'medium'); assert.equal(f.run('repairReturn.review'), 'confirmed');
    assert.equal(f.run('repairReturn.offset'), 0); assert.equal(f.run('repairReturn.github'), github);
    for (const editing of [false, true]) {
      const start = f.pending.length, delayed = f.run(`${method}('report', 0, {risk:'high', review:'open'})`);
      if (editing) f.context.modal('Editing review', 'Unsaved reason'); else f.run('cancelDetailRead()');
      assert.equal(f.pending[start].signal.aborted, true);
      if (github) f.pending[start].resolve(f.pr);
      f.pending[start + width - 1].resolve(f.result({ risk: 'high', review: 'open' })); await delayed;
      assert.equal(f.rendered.length, editing ? 2 : 1);
      if (editing) assert.equal(f.rendered.at(-1).html, 'Unsaved reason');
    }
  }
});

test('a failed filter restores the displayed selection; an older error cannot undo a newer choice', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const container = { dataset: { id: 'report', github: 'false', risk: 'all', review: 'all' } };
  const risk = { value: 'high' }, review = { value: 'open' }, pending = [], notices = []; let listener, present = true;
  const context = vm.createContext({ document: { addEventListener: (kind, handler) => { listener = handler; }, contains: () => present, querySelectorAll: () => [] },
    $: selector => selector === '#repair-risk' ? risk : review, toast: text => notices.push(text),
    showTasks: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  vm.runInContext(app.slice(app.indexOf("document.addEventListener('change'"), app.indexOf('let searchTimer;')), context);
  const event = { target: { id: 'repair-risk', closest: () => container } };
  const first = listener(event); risk.value = 'medium'; const second = listener(event);
  pending[0].reject(new Error('older failure')); await first;
  assert.equal(risk.value, 'medium'); assert.equal(notices.length, 0);
  pending[1].reject(new Error('current failure')); await second;
  assert.equal(risk.value, 'all'); assert.equal(review.value, 'all'); assert.match(notices[0], /current failure/);
  risk.value = 'low'; const closed = listener(event); present = false;
  pending[2].reject(new Error('closed failure')); await closed;
  assert.equal(risk.value, 'low'); assert.equal(notices.length, 1);
});

test('pending filters disable old paging and review actions until the current result or failure arrives', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const handlers = {}, requests = [], edits = [], risk = { value: 'high' }, review = { value: 'all' };
  const container = { dataset: { id: 'report', github: 'false', risk: 'all', review: 'all' } };
  const controls = [
    { disabled: false, dataset: { action: 'tasks-page', id: 'report', offset: '25', risk: 'all', review: 'all' } },
    { disabled: false, dataset: { action: 'issue-review', id: 'report' } },
    { disabled: true, dataset: { action: 'tasks-page', id: 'report', offset: '0' } }
  ];
  const context = vm.createContext({ document: { addEventListener: (kind, handler) => { handlers[kind] = handler; }, contains: () => true, querySelectorAll: () => controls },
    $: selector => selector === '#repair-risk' ? risk : review, toast: () => {}, issueReviewModal: () => edits.push('edit'),
    showTasks: (id, offset, filters) => new Promise((resolve, reject) => requests.push({ id, offset, filters, resolve, reject })) });
  vm.runInContext(app.slice(app.indexOf("document.addEventListener('click'"), app.indexOf("document.addEventListener('submit'")) +
    app.slice(app.indexOf("document.addEventListener('change'"), app.indexOf('let searchTimer;')), context);
  const event = { target: { id: 'repair-risk', closest: () => container } };
  const first = handlers.change(event);
  assert.ok(controls.every(control => control.disabled));
  for (const control of controls) await handlers.click({ target: { closest: () => control } });
  assert.equal(requests.length, 1); assert.equal(edits.length, 0); assert.equal(requests[0].filters.risk, 'high');
  risk.value = 'medium'; const second = handlers.change(event);
  requests[0].reject(new Error('old failure')); await first;
  assert.ok(controls.every(control => control.disabled)); assert.equal(risk.value, 'medium');
  requests[1].reject(new Error('current failure')); await second;
  assert.deepEqual(controls.map(control => control.disabled), [false, false, true]); assert.equal(risk.value, 'all');
  const next = handlers.click({ target: { closest: () => controls[0] } });
  assert.equal(requests[2].offset, 25); assert.equal(requests[2].filters.risk, 'all');
  requests[2].resolve(); await next;
});
