const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** Exercise the actual measurement transport with a controlled clock, without starting a service. */
function fixture(times, status = 200) {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/measure-collaboration.js'), 'utf8');
  const calls = [], timeouts = [];
  const context = vm.createContext({ assert, Buffer, base: 'http://127.0.0.1:4310', serviceDeadline: 100000,
    Date: { now: () => times.length > 1 ? times.shift() : times[0] }, performance: { now: () => 1 },
    AbortSignal: { timeout: ms => { timeouts.push(ms); return { ms }; } },
    fetch: async (url, options) => { calls.push({ url, options }); return { status, text: async () => '{"ok":true}' }; }
  });
  vm.runInContext(source.slice(source.indexOf('    const call = async'), source.indexOf('    for (let n = 0; n < 20; n++)')) + '\nthis.call = call;', context);
  return { call: context.call, calls, timeouts };
}

test('measurement requests use remaining time and revoked credentials still require the expected rejection', async () => {
  const normal = fixture([80000]); await normal.call('/api/health'); assert.deepEqual(normal.timeouts, [15000]);
  const denied = fixture([95250], 401); await denied.call('/api/agent/sync', 'fixture-token', undefined, 401);
  assert.deepEqual(denied.timeouts, [4750]); assert.equal(denied.calls[0].options.headers.Authorization, 'Bearer fixture-token');
  const unexpected = fixture([95250], 401); await assert.rejects(unexpected.call('/api/health'));
});

test('measurement deadline rejects before transport and handles a clock crossing during timeout construction', async () => {
  for (const now of [100000, 100001]) {
    const expired = fixture([now]);
    await assert.rejects(expired.call('/api/agent/sync', 'fixture-token', undefined, 401), /exceeded 60 seconds/);
    assert.deepEqual(expired.calls, []); assert.deepEqual(expired.timeouts, []);
  }
  const crossing = fixture([99999, 100001]); await crossing.call('/api/health'); assert.deepEqual(crossing.timeouts, [1]);
});
