const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { syncIndex, syncView } = require('../lib/work-sync');
const { WorkspaceStore, saveRecord, changeTask } = require('../lib/workspace');

/** Count real hashing work while exercising the actual module; keep cache internals private. */
function countedSync() {
  let hashes = 0;
  const actualCrypto = require('node:crypto');
  const context = vm.createContext({ module: { exports: {} }, require: name => {
    assert.equal(name, 'node:crypto');
    return { createHash: (...args) => { hashes++; return actualCrypto.createHash(...args); } };
  } });
  vm.runInContext(require('node:fs').readFileSync(path.join(__dirname, '../lib/work-sync.js'), 'utf8'), context);
  return { ...context.module.exports, hashes: () => hashes };
}

test('unchanged scoped markers reuse work until each visible lease deadline and recompute on backward time', () => {
  const f = countedSync(), doc = { revision: 1, requirements: [], knowledge: [], tasks: [
    { id: 'first', projectId: 'p', version: 1, status: 'in_progress', claim: { actor: { type: 'agent' }, expiresAt: new Date(20).toISOString() } },
    { id: 'second', projectId: 'p', version: 1, status: 'in_progress', claim: { actor: { type: 'agent' }, expiresAt: new Date(30).toISOString() } },
    { id: 'other', projectId: 'q', version: 1, status: 'in_progress', claim: { actor: { type: 'agent' }, expiresAt: new Date(12).toISOString() } },
    { id: 'human', projectId: 'p', version: 1, status: 'in_progress', claim: { actor: { type: 'human' }, expiresAt: new Date(11).toISOString() } }
  ] };
  const index = f.syncIndex(doc), plain = JSON.parse(JSON.stringify(index));
  const poll = now => {
    const token = f.syncView(index, 'tasks', ['p'], false, now).token;
    assert.equal(token, syncView(plain, 'tasks', ['p'], false, now).token);
    return token;
  };
  const before = poll(10); assert.equal(f.hashes(), 1);
  assert.equal(poll(11), before); assert.equal(poll(12), before); assert.equal(f.hashes(), 1);
  const firstExpired = poll(20); assert.notEqual(firstExpired, before); assert.equal(f.hashes(), 2);
  assert.equal(poll(29), firstExpired); assert.equal(f.hashes(), 2);
  assert.notEqual(poll(30), firstExpired); assert.equal(f.hashes(), 3);
  poll(31); assert.equal(f.hashes(), 3);
  assert.equal(poll(19), before); assert.equal(f.hashes(), 4);
  assert.equal(poll(20), firstExpired); assert.equal(f.hashes(), 5);
});

test('committed snapshots isolate cached scopes, publication and linked versions without retaining bodies', () => {
  const f = countedSync(), doc = { revision: 1,
    requirements: [{ id: 'req', projectId: 'p', version: 1 }],
    tasks: [{ id: 'task', projectId: 'p', version: 1, requirementId: 'req', status: 'ready', description: 'PRIVATE BODY' }],
    knowledge: [{ id: 'global', projectId: '', version: 1, status: 'published' }, { id: 'draft', projectId: 'p', version: 1, status: 'draft', history: ['PRIVATE HISTORY'] }] };
  const index = f.syncIndex(doc), before = f.syncView(index, 'tasks', ['p'], false, 1).token;
  assert.equal(f.syncView(index, 'tasks', ['p', 'p'], false, 2).token, before); assert.equal(f.hashes(), 1);
  assert.notEqual(f.syncView(index, 'tasks', [], false, 2).token, before);
  const published = f.syncView(index, 'knowledge', ['p', ''], true, 2).token;
  assert.equal(f.syncView(index, 'knowledge', ['', 'p'], true, 3).token, published); assert.equal(f.hashes(), 3);
  assert.notEqual(f.syncView(index, 'knowledge', ['p', ''], false, 3).token, published);
  assert.ok(!JSON.stringify(index).includes('PRIVATE'));
  assert.throws(() => { 'use strict'; index.tasks[0].version = 99; }, TypeError);
  assert.throws(() => { index.tasks.push({}); }, TypeError);
  doc.requirements[0].version++; doc.knowledge[1].status = 'published';
  const committed = f.syncIndex(doc);
  assert.notEqual(f.syncView(committed, 'tasks', ['p'], false, 4).token, before);
  assert.notEqual(f.syncView(committed, 'knowledge', ['', 'p'], true, 4).token, published);
  assert.equal(f.syncView(index, 'tasks', ['p'], false, 4).token, before);
  const requirement = f.syncView(committed, 'requirements', ['p'], false, 4).token;
  doc.tasks[0].version++;
  assert.notEqual(f.syncView(f.syncIndex(doc), 'requirements', ['p'], false, 5).token, requirement);
  const mutable = JSON.parse(JSON.stringify(index));
  const original = f.syncView(mutable, 'tasks', ['p'], false, 6).token;
  mutable.tasks[0].version++;
  assert.notEqual(f.syncView(mutable, 'tasks', ['p'], false, 7).token, original);
});

test('scope reuse is capped at 64 entries and oversized scopes are always computed without retention', () => {
  const f = countedSync(), index = f.syncIndex({ revision: 1, requirements: [], tasks: [], knowledge: [] });
  for (let n = 0; n < 64; n++) f.syncView(index, 'tasks', ['p' + n], false, 1);
  assert.equal(f.hashes(), 64);
  f.syncView(index, 'tasks', ['p0'], false, 2); assert.equal(f.hashes(), 64);
  f.syncView(index, 'tasks', ['p64'], false, 2); assert.equal(f.hashes(), 65);
  f.syncView(index, 'tasks', ['p0'], false, 3); assert.equal(f.hashes(), 66);
  const oversized = Array.from({ length: 32 }, (_, n) => 'p' + n);
  f.syncView(index, 'tasks', oversized, false, 4); f.syncView(index, 'tasks', oversized, false, 5); assert.equal(f.hashes(), 68);
  const overlong = ['p'.repeat(37)];
  f.syncView(index, 'tasks', overlong, false, 4); f.syncView(index, 'tasks', overlong, false, 5); assert.equal(f.hashes(), 70);
});

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
