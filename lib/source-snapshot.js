const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const excluded = new Set(['.git', '.idea', '.codegraph', 'target', 'node_modules', 'data', 'build', 'outputs', 'dist', 'coverage']);
const extensions = /\.(java|sql|xml|properties|ya?ml|json|gradle|kts|kt|sh|ps1|cmd|bat|[cm]?js|jsx|ts|tsx|html?|css|scss|vue|svelte)$/i;
const scope = 'Java / Kotlin / SQL、JavaScript / TypeScript、HTML / CSS、Vue / Svelte、XML、properties、YAML、JSON、Gradle 和构建脚本；排除构建输出、报告、依赖及版本控制目录，不跟随符号链接';
const version = 2;

/** Hash bounded source/configuration files in deterministic relative-path order; never retain source text. */
async function sourceSnapshot(root, options = {}) {
  root = await fs.realpath(root); const files = []; let entries = 0, totalBytes = 0;
  const signal = options.signal, deadline = Date.now() + (options.timeoutMs ?? 120000);
  function check() { if (signal?.aborted) throw Error('检查已停止，结果未完成'); if (Date.now() > deadline) throw Error('代码版本核对超时，请缩小项目目录'); }
  async function visit(directory) {
    check();
    const iterator = await fs.opendir(directory);
    for await (const entry of iterator) {
      check(); if (++entries > 200000) throw Error('项目目录项超过 200,000，请缩小项目目录');
      if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && extensions.test(entry.name)) { files.push(file); if (files.length > 50000) throw Error('代码版本核对超过 50,000 个文件'); }
    }
  }
  await visit(root); files.sort(); const manifest = [], aggregate = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(65536);
  for (const file of files) {
    check(); const real = await fs.realpath(file), relative = path.relative(root, real);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || real !== file) throw Error('代码版本核对发现链接或目录外文件');
    const handle = await fs.open(file, 'r');
    try {
      const before = await handle.stat(); if (!before.isFile() || before.size > 5 * 1024 * 1024) throw Error('代码版本核对单文件超过 5 MB 或类型不正确');
      const hash = crypto.createHash('sha256'); let size = 0;
      for (;;) {
        check(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
        size += bytesRead; totalBytes += bytesRead;
        if (size > 5 * 1024 * 1024 || totalBytes > 512 * 1024 * 1024) throw Error('代码版本核对超过单文件 5 MB 或总计 512 MB 上限');
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat(), current = await fs.lstat(file);
      if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw Error('核对期间文件变化，请重新检查');
      const row = { file: path.relative(root, file).split(path.sep).join('/'), sha256: hash.digest('hex'), bytes: size };
      aggregate.update(JSON.stringify(row) + '\n'); manifest.push(row);
    } finally { await handle.close(); }
  }
  return { version, algorithm: 'sha256', digest: aggregate.digest('hex'), files: manifest, bytes: totalBytes, capturedAt: new Date().toISOString(), scope };
}

/** Compare bounded manifests; return counts and at most 25 changed paths, not source contents. */
function compareSnapshot(saved, current, savedHead, currentHead) {
  const checkedAt = new Date().toISOString();
  if (!saved || saved.version !== version || current?.version !== version) return { status: 'UNKNOWN', checkedAt, reason: '旧报告未使用当前代码核对范围，请重新扫描后验收' };
  const before = new Map(saved.files.map(row => [row.file, row.sha256])), after = new Map(current.files.map(row => [row.file, row.sha256]));
  const counts = { added: 0, removed: 0, modified: 0 }, changes = [];
  function add(file, kind) { counts[kind]++; if (changes.length < 25) changes.push({ file, kind }); }
  for (const [file, hash] of before) if (!after.has(file)) add(file, 'removed'); else if (hash !== after.get(file)) add(file, 'modified');
  for (const file of after.keys()) if (!before.has(file)) add(file, 'added');
  const headChanged = savedHead !== currentHead;
  return { status: saved.digest === current.digest && !headChanged ? 'CURRENT' : 'STALE', checkedAt, digest: current.digest, counts, changes, headChanged, scope,
    reason: saved.digest === current.digest && !headChanged ? '当前纳入核对的文件内容与本报告一致；这不是测试通过证明' : '扫描后源码、配置或 Git 基准发生变化，请重新检查后验收' };
}
module.exports = { sourceSnapshot, compareSnapshot, scope };
