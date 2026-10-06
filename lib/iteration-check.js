const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { sourceSnapshot, compareSnapshot } = require('./source-snapshot');
const { runPlatformCheck, platformCheckView, testCounts } = require('./platform-check');
const { runBrowserRegression, scenarios } = require('../scripts/check-browser');
const { completeBrowserReport } = require('./browser-check');

/** report 为本轮组合报告；必须有两类完整证据，且执行前后都对应同一份源码。 */
function completeIterationReport(report) {
  const p = report?.platform, b = report?.browser, digest = report?.sourceSnapshot?.digest;
  return !!digest && report.kind === 'iteration' && report.status === 'PASSED' && report.stage === 'completed' &&
    report.sourceCheck?.status === 'CURRENT' && p?.status === 'PASSED' && p.sourceCheck?.status === 'CURRENT' &&
    ['JavaScript 语法', '全部自动测试', '执行期间代码版本'].every(name => p.checks?.some(c => c.name === name && c.passed === true)) &&
    testCounts(p.testOutput).passed && completeBrowserReport(b) &&
    p.sourceSnapshot?.digest === digest && b.sourceSnapshot?.digest === digest;
}

/** root 为安装目录；只显示精简结果，源文件清单和原始输出保留在可下载报告中。 */
async function iterationCheckView(root, report) {
  if (!report) return { status: 'NOT_CHECKED', report: null };
  const verified = report.status === 'PASSED' && !completeIterationReport(report) ? { ...report, status: 'FAILED', error: '本轮证据缺失、未完整执行或代码版本不一致' } : report;
  const view = await platformCheckView(root, verified);
  if (!report.sourceSnapshot && report.status === 'FAILED') view.status = 'FAILED';
  const { platform, browser, ...detail } = view.report;
  view.report = { ...detail,
    platform: platform ? { id: platform.id, status: platform.status, tests: platform.tests, checks: platform.checks, error: platform.error } : null,
    browser: browser ? { id: browser.id, status: browser.status, scenarios: browser.scenarios, images: browser.images, error: browser.error } : null };
  return view;
}

/** root 为平台目录；options 由固定服务或终端提供，不接受项目命令。
 * onStart 在初始失败报告落盘后登记最新引用；runner 参数仅供内部测试替身使用。
 */
async function runIterationCheck(root, options = {}) {
  const id = options.id || crypto.randomUUID();
  const output = options.output || path.join(root, 'outputs', 'iteration-check', `report-${id}.json`);
  const directory = path.dirname(output);
  const report = { id, kind: 'iteration', status: 'FAILED', stage: 'starting', startedAt: new Date().toISOString(), checks: [],
    limits: ['通过只覆盖平台语法、全部 Node 自动测试、固定页面流程和源码一致性。', '真实 Java/Maven/Sonar 构建、所有业务需求与完整视觉验收仍需另行验证。'] };
  const persist = async () => { await fs.writeFile(output + '.tmp', JSON.stringify(report, null, 2)); await fs.rename(output + '.tmp', output); };
  await fs.mkdir(directory, { recursive: true });
  await persist(); await options.onStart?.(report);
  try {
    report.sourceSnapshot = await sourceSnapshot(root);
    report.stage = 'platform'; await persist();
    report.platform = await (options.platformRunner || runPlatformCheck)(root);
    const platformFile = path.join(directory, `report-${report.platform.id}.json`);
    await fs.writeFile(platformFile + '.tmp', JSON.stringify(report.platform, null, 2)); await fs.rename(platformFile + '.tmp', platformFile);
    await persist();
    // 自检失败立即停止；不拿旧页面成功记录补齐本轮证据。
    if (report.platform.status !== 'PASSED') throw Error('平台自检未通过，页面回归未执行；请查看自检结果');
    report.stage = 'browser'; await persist();
    const browserId = crypto.randomUUID();
    const result = await (options.browserRunner || runBrowserRegression)({ id: browserId, output: path.join(directory, `report-${browserId}.json`) });
    report.browser = result.report;
    report.sourceCheck = compareSnapshot(report.sourceSnapshot, await sourceSnapshot(root));
    report.stage = 'completed'; report.status = 'PASSED';
    if (!completeIterationReport(report)) { report.status = 'FAILED'; report.error = '本轮自检、页面回归或源码一致性未全部通过；请查看分项结果'; }
  } catch (error) { report.status = 'FAILED'; report.error = error.message.slice(0, 3000); }
  report.checks = [
    { name: '平台自身检查', passed: report.platform?.status === 'PASSED', detail: report.platform ? `通过 ${report.platform.tests?.pass || 0} 项自动测试` : '未完成' },
    { name: '真实页面回归', passed: completeBrowserReport(report.browser), detail: report.browser ? `通过 ${report.browser.scenarios?.filter(s => s.status === 'PASSED').length || 0} / ${scenarios.length} 项页面流程` : '未执行，不能计为通过' },
    { name: '同一版代码', passed: report.sourceCheck?.status === 'CURRENT' && report.platform?.sourceSnapshot?.digest === report.sourceSnapshot?.digest && report.browser?.sourceSnapshot?.digest === report.sourceSnapshot?.digest, detail: report.sourceCheck?.reason || '证据不完整' }
  ];
  report.finishedAt = new Date().toISOString(); await persist();
  return { report, file: output };
}

module.exports = { completeIterationReport, iterationCheckView, runIterationCheck };
