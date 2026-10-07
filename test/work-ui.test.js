const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Actual browser sync functions with delayed transport; saved drafts represent DOM outside the records region. */
function fixture() {
  const source = fs.readFileSync(path.join(__dirname, '../public/work.js'), 'utf8');
  const pending = [], listeners = {}, timers = [], records = { innerHTML: 'Saved list' }, status = { textContent: '' };
  const context = vm.createContext({ AbortController, URLSearchParams,
    setTimeout: callback => { const timer = { callback, active: true }; timers.push(timer); return timer; }, clearTimeout: timer => { timer.active = false; },
    clearInterval: () => {}, setInterval: () => 1, page: 'work',
    document: { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } },
    $: key => key === '#work-records' ? records : key === '#work-sync-status' ? status : null,
    render: () => {}, api: (url, data, signal) => new Promise((resolve, reject) => pending.push({ url, signal, resolve, reject })) });
  vm.runInContext(source.slice(0, source.indexOf('/** 将操作快照')), context);
  vm.runInContext("workKind = 'tasks'; workData = { signature: 'first', token: 'old', rows: [{ title: 'Saved task' }] }; workRecords = (kind, list) => list.rows.map(r => r.title).join(',');", context);
  return { context, pending, records, status, listeners, timers, run: code => vm.runInContext(code, context) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('unchanged tokens retain DOM and changed tokens fetch one bounded page while drafts stay untouched', async () => {
  const f = fixture(), first = f.run('pollWorkSync()');
  await f.run('pollWorkSync()'); assert.equal(f.pending.length, 1);
  f.pending[0].resolve({ token: 'old' }); await first;
  assert.equal(f.records.innerHTML, 'Saved list');
  f.run("workFormRow = { title: 'Unsaved evidence', version: 3 }; workSearch = 'saved search';");
  const update = f.run('pollWorkSync()'); f.pending[1].resolve({ token: 'new' }); await tick();
  assert.match(f.pending[2].url, /\/api\/work\/list\?/);
  f.pending[2].resolve({ token: 'new', rows: [{ title: 'Agent submitted' }], offset: 0 }); await update;
  assert.equal(f.records.innerHTML, 'Agent submitted');
  assert.equal(f.run('workFormRow.title'), 'Unsaved evidence'); assert.equal(f.run('workFormRow.version'), 3);
  assert.equal(f.run('workSearch'), 'saved search');
});

test('failed sync and failed page refresh preserve the last successful list and can retry', async () => {
  const f = fixture(), failed = f.run('pollWorkSync()'); f.pending[0].reject(Error('Offline')); await failed;
  assert.equal(f.records.innerHTML, 'Saved list'); assert.match(f.status.textContent, /自动重试/);
  const pageFail = f.run('pollWorkSync()'); f.pending[1].resolve({ token: 'new' }); await tick();
  f.pending[2].reject(Error('Page interrupted')); await pageFail;
  assert.equal(f.run('workData.token'), 'old'); assert.equal(f.run('workController'), null);
  const retry = f.run('pollWorkSync()'); f.pending[3].resolve({ token: 'old' }); await retry;
  assert.match(f.status.textContent, /同步正常/); assert.equal(f.run('workSyncController'), null);
});

test('hidden pages pause sync and late navigation/filter responses cannot reload stale records', async () => {
  const f = fixture(); f.context.document.hidden = true; await f.run('pollWorkSync()'); assert.equal(f.pending.length, 0);
  f.context.document.hidden = false; const filtered = f.run('pollWorkSync()');
  f.run("workData = { signature: 'new filter', token: 'other', rows: [] };");
  f.pending[0].resolve({ token: 'new' }); await filtered; assert.equal(f.pending.length, 1);
  const nav = f.run('pollWorkSync()'); f.run("stopWorkSync(); workData = null; page = 'settings';");
  assert.equal(f.pending[1].signal.aborted, true); f.pending[1].resolve({ token: 'new' }); await nav;
  assert.equal(f.pending.length, 2); assert.equal(f.run('workSyncTimer'), null);
  f.run("page = 'work'; workData = { signature: 'again', token: 'old', rows: [] };");
  const hide = f.run('pollWorkSync()'); f.context.document.hidden = true; f.listeners.visibilitychange();
  assert.equal(f.pending[2].signal.aborted, true); f.pending[2].resolve({ token: 'new' }); await hide;
  assert.equal(f.pending.length, 3);
});

test('superseded list loads cannot overwrite newer filter results even when aborted transport resolves', async () => {
  const f = fixture(), first = f.run("loadWork('first', 'tasks')");
  f.run("workData = { signature: 'second', loading: true }; workSearch = 'second';");
  const second = f.run("loadWork('second', 'tasks')"); assert.equal(f.pending[0].signal.aborted, true);
  f.pending[1].resolve({ token: 'second', rows: [{ title: 'Second result' }], offset: 0 }); await second;
  f.pending[0].resolve({ token: 'first', rows: [{ title: 'Obsolete result' }], offset: 0 }); await first;
  assert.equal(f.records.innerHTML, 'Second result'); assert.equal(f.run('workData.token'), 'second');
});

test('a stalled changed-token list times out, releases both reads and retries with the saved token', async () => {
  const f = fixture(), stalled = f.run('pollWorkSync()'); f.pending[0].resolve({ token: 'new' }); await tick();
  assert.equal(f.timers[0].active, false, 'Token timeout must stop after the token read');
  f.timers[1].callback(); assert.equal(f.pending[1].signal.aborted, true);
  f.pending[1].reject(Object.assign(Error('Timed out'), { name: 'AbortError' })); await stalled;
  assert.equal(f.run('workController'), null); assert.equal(f.run('workSyncController'), null);
  assert.equal(f.run('workData.token'), 'old'); assert.match(f.status.textContent, /自动重试/);
  const retry = f.run('pollWorkSync()'); f.pending[2].resolve({ token: 'new' }); await tick();
  f.pending[3].resolve({ token: 'new', rows: [{ title: 'Recovered task' }], offset: 0 }); await retry;
  assert.equal(f.records.innerHTML, 'Recovered task');
});

test('hiding during a changed-token page read aborts it and does not publish its late response', async () => {
  const f = fixture(), read = f.run('pollWorkSync()'); f.pending[0].resolve({ token: 'new' }); await tick();
  f.context.document.hidden = true; f.listeners.visibilitychange(); assert.equal(f.pending[1].signal.aborted, true);
  f.pending[1].resolve({ token: 'new', rows: [{ title: 'Hidden response' }], offset: 0 }); await read;
  assert.equal(f.run('workData.token'), 'old'); assert.equal(f.records.innerHTML, 'Saved list');
  f.context.document.hidden = false; f.listeners.visibilitychange(); await tick(); assert.equal(f.pending.length, 3);
  f.pending[2].resolve({ token: 'old' }); await tick();
  assert.equal(f.run('workSyncController'), null);
});

test('scan polling refreshes state without replacing collaboration page drafts', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), refreshed = []; let poll;
  const context = vm.createContext({ state: { active: true }, polling: null, pollingBusy: false, page: 'work',
    document: { hidden: false }, $: () => ({ open: false }), viewedScanId: null, viewedPipelineId: null,
    refresh: async render => refreshed.push(render), setInterval: callback => { poll = callback; return 1; }, clearInterval: () => {} });
  vm.runInContext(source.slice(source.indexOf('function ensurePolling()'), source.indexOf('function heading(')), context);
  vm.runInContext('ensurePolling()', context); await poll(); context.page = 'knowledge'; await poll();
  assert.deepEqual(refreshed, [false, false]);
});
