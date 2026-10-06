const { restoreBackup } = require('../lib/backup');
// Restore offline into a new directory. Existing data is never overwritten.
if (process.argv.length !== 4) { console.error('Usage: node scripts/restore-backup.js BACKUP.jsonl.gz NEW_DATA_DIRECTORY'); process.exitCode = 1; }
else restoreBackup(process.argv[2], process.argv[3]).then(result => console.log(`Restored ${result.files} files to ${result.destination}. Start with scripts/start.ps1 -DataDirectory this path, then update project paths.`), error => { console.error(error.message); process.exitCode = 1; });
