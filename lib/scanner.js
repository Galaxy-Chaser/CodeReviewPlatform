const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { catalog } = require('./rules');

/** Check text away from the HTTP thread. options accepts signal, onProgress and timeoutMs; workers are always released. */
function scanInWorker(root, enabled = catalog.map(rule => rule.id), options = {}) {
  if (options.signal?.aborted) return Promise.reject(new Error('检查已停止，结果未完成'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'scan-worker.js'), { workerData: { root, enabled }, env: {}, execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      // Resolve only after termination so the next scan cannot overlap this worker's resources.
      worker.terminate().then(() => error ? reject(error) : resolve(result), reject);
    };
    const abort = () => finish(new Error('检查已停止，结果未完成；请重新检查后验收'));
    const timeoutMs = options.timeoutMs ?? 600000;
    const timeoutText = timeoutMs >= 60000 ? `${timeoutMs / 60000} 分钟` : `${timeoutMs} 毫秒`;
    const timer = setTimeout(() => finish(new Error(`本地规则检查超过 ${timeoutText}，结果未完成；请分模块检查`)), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (settled) return;
      if (message.progress) {
        try { options.onProgress?.(message.progress); } catch (error) { finish(error); }
      } else if (message.error) finish(new Error(message.error));
      else if (message.result) finish(null, message.result);
    });
    worker.on('error', error => finish(new Error(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? '源码处理达到内存上限，检查未完成；请缩小项目目录' : error.message)));
    worker.on('exit', code => { if (!settled) finish(new Error(`规则检查意外中断 (${code})，结果未完成`)); });
    // Close the race between initial abort inspection and event registration.
    if (options.signal?.aborted) abort();
  });
}

module.exports = { scanInWorker };
