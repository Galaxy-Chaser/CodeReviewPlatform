const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { syncIndex, syncView } = require('../lib/work-sync');
const { WorkspaceStore, saveRecord, changeTask } = require('../lib/workspace');

/** Known metadata cases use fixed time so the expiry boundary does not depend on wall-clock scheduling. */
test('scoped tokens include lease expiry and linked task progress without exposing other projects or drafts', () => {
  const doc = { revision: 1, requirements: [{ id: 'req', projectId: 'p', version: 1 }], tasks: [
    { id: 'task', projectId: 'p', version: 2, requirementId: 'req', status: 'in_progress', claim: { actor: { type: 'agent' }, expiresAt: '2026-10-07T01:00:00Z' } },
    { id: 'other', projectId: 'q', version: 1, status: 'ready' }
  ], knowledge: [{ id: 'draft', projectId: 'p', version: 1, status: 'draft' }, { id: 'global', projectId: '', version: 1, status: 'published' }] };
  const before = Date.parse('2026-10-07T00:59:59Z'), deadline = before + 1000;
  const token = (kind, now = before, published = false) => syncView(syncIndex(doc), kind, kind === 'knowledge' ? ['p', ''] : ['p'], published, now).token;
  const tasks = token('tasks'), requirements = token('requirements'), knowledge = token('knowledge', before, true);
  assert.notEqual(token('tasks', deadline), tasks); assert.equal(token('tasks', deadline + 1000), token('tasks', deadline));
  doc.tasks[1].version++; doc.knowledge[0].version++;
  assert.equal(token('tasks'), tasks); assert.equal(token('knowledge', before, true), knowledge);
  doc.tasks[0].version++; assert.notEqual(token('requirements'), requirements);
  const currentTasks = token('tasks'); doc.requirements[0].version++;
  assert.notEqual(token('tasks'), currentTasks);
  doc.knowledge[0].status = 'published'; assert.notEqual(token('knowledge', before, true), knowledge);
  doc.tasks[0].claim.actor.type = 'human'; assert.equal(token('tasks', deadline), token('tasks', before));
  assert.deepEqual(Object.keys(syncView(syncIndex(doc), 'tasks', ['p'])), ['token']);
  assert.equal(JSON.stringify(syncIndex({ ...doc, tasks: [{ ...doc.tasks[0], description: 'private body', history: ['private history'] }] })).includes('private'), false);
});

test('sync reuses bounded committed metadata, retries failed initialization, and never publishes rejected mutations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(root), originalRead = store.read.bind(store); let reads = 0;
  store.read = async () => { reads++; return originalRead(); };
  const first = await store.sync();
  await Promise.all(Array.from({ length: 30 }, () => store.sync())); assert.equal(reads, 1);
  await assert.rejects(store.mutate(() => { throw Error('Rejected write'); }), /Rejected/);
  assert.equal(await store.sync(), first);
  await store.mutate(() => {}); assert.equal((await store.sync()).revision, 1);
  const restarted = new WorkspaceStore(root); assert.deepEqual(await restarted.sync(), await store.sync());
  const retry = new WorkspaceStore(root); retry.read = async () => { throw Error('Unavailable'); };
  await assert.rejects(retry.sync(), /Unavailable/); retry.read = originalRead;
  assert.equal((await retry.sync()).revision, 1);
});

test('a delayed initial metadata read cannot replace a newer committed index', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-sync-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(root), read = store.read.bind(store), old = await read(); let finish;
  store.read = () => new Promise(resolve => { finish = () => resolve(old); });
  const initial = store.sync(); store.read = read;
  await store.mutate(() => {}); finish();
  assert.equal((await initial).revision, 1); assert.equal((await store.sync()).revision, 1);
});

test('list rows and tokens share one clock snapshot when a lease expires during response construction', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'health-sync-clock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(root), projectId = crypto.randomUUID(), human = { type: 'human', name: 'Human', id: '' };
  await store.mutate(doc => {
    const row = saveRecord(doc, 'tasks', { projectId, title: 'Clock boundary', description: 'A real stored task', criteria: 'Observe exact lease expiry', requireReport: false }, human, () => {});
    changeTask(doc, { id: row.id, expectedVersion: row.version, action: 'claim' }, { type: 'agent', name: 'Agent', id: crypto.randomUUID() }, () => {}, 0);
  });
  let calls = 0;
  const context = vm.createContext({ module: { exports: {} }, Date: { now: () => 1799999 + calls++ },
    require: name => name.startsWith('./') ? require('../lib/' + name.slice(2)) : require(name) });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../lib/work-api.js'), 'utf8'), context);
  const api = context.module.exports.createWorkApi(root, { projects: () => [{ id: projectId }] });
  const req = { method: 'GET', headers: {} };
  const list = await api(req, new URL('http://127.0.0.1/api/work/list?kind=tasks'));
  assert.equal(list.rows[0].leaseExpired, false);
  assert.equal(list.token, syncView(syncIndex(await store.read()), 'tasks', null, false, 1799999).token);
  assert.equal(calls, 1);
  const expired = await api(req, new URL('http://127.0.0.1/api/work/sync?kind=tasks'));
  assert.notEqual(expired.token, list.token);
});
