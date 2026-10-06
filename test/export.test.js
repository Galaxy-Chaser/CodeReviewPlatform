const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeArray } = require('../lib/json-export');

test('streamed JSON preserves Unicode and every row when filesystem writes are partial', async () => {
  const written = [];
  const handle = { write: async (buffer, offset, length) => { const bytesWritten = Math.min(length, 3); written.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten))); return { bytesWritten }; } };
  const rows = [{ text: '中文证据 🔍' }, { text: 'quote " newline\n' }];
  await writeArray(handle, (async function* () { for (const row of rows) yield row; })());
  assert.deepEqual(JSON.parse(Buffer.concat(written).toString('utf8')), rows);
});
test('empty exports remain valid JSON and failed writes do not silently lose evidence', async () => {
  const fragments = [];
  await writeArray({ write: async (buffer, offset, length) => { fragments.push(Buffer.from(buffer.subarray(offset, offset + length))); return { bytesWritten: length }; } }, []);
  assert.deepEqual(JSON.parse(Buffer.concat(fragments).toString('utf8')), []);
  await assert.rejects(writeArray({ write: async () => ({ bytesWritten: 0 }) }, []), /写入失败/);
});
