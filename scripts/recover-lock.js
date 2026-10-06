const { recoverDataLock } = require('../lib/data-lock');
// Explicit offline recovery only; a live owner is never interrupted.
if (!process.argv[2]) { console.error('Usage: node scripts/recover-lock.js DATA_DIRECTORY'); process.exitCode = 1; }
else recoverDataLock(process.argv[2]).then(() => console.log('Abandoned data lock released.'), error => { console.error(error.message); process.exitCode = 1; });
