const { parentPort, workerData } = require('node:worker_threads');
const { scanLocal } = require('./rules');

// This worker only applies platform rules to text. It never executes project code or receives credentials.
scanLocal(workerData.root, workerData.enabled, progress => parentPort.postMessage({ progress })).then(
  result => parentPort.postMessage({ result }),
  error => parentPort.postMessage({ error: error.message })
);
