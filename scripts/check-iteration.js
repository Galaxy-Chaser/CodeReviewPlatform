const path = require('node:path');
const { runIterationCheck } = require('../lib/iteration-check');

/** 一次执行固定的本轮验收；非通过结果向终端与持续集成返回失败。 */
runIterationCheck(path.join(__dirname, '..')).then(({ report, file }) => {
  for (const check of report.checks) console.log(`${check.passed ? '通过' : '失败'}：${check.name} — ${check.detail}`);
  console.log(`本轮自动验收：${report.status}\n报告：${file}`);
  if (report.error) console.error(report.error);
  if (report.status !== 'PASSED') process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
