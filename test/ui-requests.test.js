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
