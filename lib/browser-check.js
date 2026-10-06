const { platformCheckView } = require('./platform-check');
const { scenarios } = require('../scripts/check-browser');

/** 固定八项流程必须全部执行，重复或缺失记录不能把局部成功伪装成页面回归通过。 */
function completeBrowserReport(report) {
  return report?.kind === 'browser' && report.status === 'PASSED' && Array.isArray(report.scenarios) && report.scenarios.length === scenarios.length &&
    scenarios.every(([id]) => report.scenarios.filter(s => s.id === id && s.status === 'PASSED').length === 1) && report.sourceCheck?.status === 'CURRENT';
}

/** root 为平台目录；重新核对当前源码，并将未完整执行的历史成功降为失败。 */
async function browserCheckView(root, report) {
  if (report?.status === 'PASSED' && !completeBrowserReport(report)) report = { ...report, status: 'FAILED', error: '页面流程记录缺失或未完整执行' };
  return platformCheckView(root, report);
}
module.exports = { completeBrowserReport, browserCheckView };
