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
    gateEvidence: () => '', sourceVersionPanel: () => '', stat: () => '', metric: () => '', num: () => '', button: () => '', issueCount: value => value.issueCount,
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
