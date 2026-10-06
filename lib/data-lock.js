const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/** Reserve a data directory before reading or writing it. directory may be relative; only one owner is allowed. */
async function acquireDataLock(directory) {
  await fs.mkdir(directory, { recursive: true });
  const root = await fs.realpath(directory), lock = path.join(root, '.owner-lock');
  try { await fs.mkdir(lock); }
  catch (error) { if (error.code !== 'EEXIST') throw error; throw new Error('数据目录已被占用或有未清理的锁；请关闭另一平台。异常退出后可运行 scripts/recover-lock.js 检查并解除旧锁。'); }
  const owner = { pid: process.pid, nonce: crypto.randomUUID(), createdAt: new Date().toISOString() };
  try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify(owner)); }
  catch (error) { await fs.unlink(path.join(lock, 'owner.json')).catch(() => {}); await fs.rmdir(lock).catch(() => {}); throw error; }
  return {
    root,
    /** Release only the same owner's lock; never delete a newer process's reservation. */
    async release() {
      const saved = await fs.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (saved?.nonce !== owner.nonce) return;
      let reservation;
      for (let attempt = 0; !reservation; attempt++) {
        try { reservation = await fs.open(path.join(lock, 'recovering'), 'wx'); }
        catch (error) { if (error.code === 'ENOENT') return; if (error.code !== 'EEXIST' || attempt >= 100) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      const latest = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
      await reservation.close();
      if (latest.nonce !== owner.nonce) { await fs.unlink(path.join(lock, 'recovering')); return; }
      const released = path.join(root, '.released-lock-' + owner.nonce);
      await fs.rename(lock, released);
      await fs.unlink(path.join(released, 'owner.json')); await fs.unlink(path.join(released, 'recovering')); await fs.rmdir(released);
    }
  };
}

/** Recover an abandoned lock under an exclusive recovery reservation; live or unreadable owners always block recovery. */
async function recoverDataLock(directory) {
  const root = await fs.realpath(directory), lock = path.join(root, '.owner-lock');
  const reservation = await fs.open(path.join(lock, 'recovering'), 'wx').catch(() => { throw new Error('锁不存在或正在恢复，请检查数据目录。'); });
  let quarantined;
  try {
    const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('锁信息不完整，请先备份并人工检查。');
    try { process.kill(owner.pid, 0); throw new Error('所属进程仍在运行，不能解除锁。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await reservation.close();
    quarantined = path.join(root, '.abandoned-lock-' + crypto.randomUUID());
    await fs.rename(lock, quarantined);
    await fs.unlink(path.join(quarantined, 'owner.json')); await fs.unlink(path.join(quarantined, 'recovering')); await fs.rmdir(quarantined);
  } finally {
    await reservation.close().catch(() => {});
    if (!quarantined) await fs.unlink(path.join(lock, 'recovering')).catch(() => {});
  }
}
module.exports = { acquireDataLock, recoverDataLock };
