/** Write a UTF-8 fragment completely, even when the filesystem accepts only part of a buffer. */
async function writeText(handle, text) {
  const buffer = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < buffer.length;) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!bytesWritten) throw new Error('导出文件写入失败');
    offset += bytesWritten;
  }
}

/** Export an async row iterator as valid JSON without collecting all matches in memory. */
async function writeArray(handle, rows) {
  let first = true;
  await writeText(handle, '[\n');
  for await (const row of rows) { await writeText(handle, (first ? '' : ',\n') + JSON.stringify(row)); first = false; }
  await writeText(handle, '\n]\n');
}
module.exports = { writeText, writeArray };
