const fs = require('node:fs/promises');
const path = require('node:path');
const { runPlatformCheck } = require('../lib/platform-check');

/** 固定检查本平台，输出独立报告；不接受外部命令或任意项目参数。 */
async function main() {
  const root = path.join(__dirname, '..'), report = await runPlatformCheck(root);
  const directory = path.join(root, 'outputs', 'platform-check'); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `report-${report.id}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(report.checks.map(c => `${c.passed ? '通过' : '失败'}：${c.name} — ${c.detail}`).join('\n'));
  console.log(`平台自动自检：${report.status}\n报告：${file}`);
  if (report.status !== 'PASSED') process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
