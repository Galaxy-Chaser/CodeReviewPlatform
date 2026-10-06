const { reviewReadiness } = require('./acceptance');

/** Evaluate a report against a fresh source check and latest-attempt ID; never overwrite historical evidence. */
function readiness(report, sourceCheck, latestId) {
  if (!report) return { status: 'NOT_CHECKED', checkedAt: new Date().toISOString(), blockers: ['尚未检查'], missing: [], limits: [], next: '开始检查项目', checks: [] };
  const evaluated = { ...report, acceptanceSourceCheck: report.scope === 'github' ? report.acceptanceSourceCheck : sourceCheck || { status: 'UNKNOWN', reason: '尚未核对当前代码，请重新核对' } };
  const result = reviewReadiness(evaluated);
  if (report.id !== latestId) result.blockers.unshift('这不是最新检查，请查看最新一次尝试');
  if (report.scope === 'github') result.limits.unshift('PR 当前远程版本未核对；此状态只对应报告中的固定提交');
  const status = result.blockers.length ? 'BLOCKED' : result.missing.length ? 'PENDING' : 'READY';
  const tests = report.buildTests;
  const pipeline = require('./acceptance-pipeline').pipelineGaps(report);
  return { ...result, status, reportId: report.id, sourceCheck, checkedAt: new Date().toISOString(), scope: report.scope || 'project',
    checks: [
      { name: '最新检查', value: report.id === latestId ? '是' : '否' },
      { name: '检查完成', value: report.status === 'completed' ? '已完成' : report.status === 'running' ? '正在执行' : '失败 / 未完成' },
      { name: '自动门禁', value: report.gate?.status || 'UNKNOWN' },
      { name: '代码版本', value: report.scope === 'github' ? '固定 PR 提交；未核对远程最新版本' : sourceCheck?.status || 'UNKNOWN' },
      { name: '自动测试', value: tests?.available ? `执行 ${tests.executed}，跳过 ${tests.skipped}，失败 ${tests.failures}，错误 ${tests.errors}` : tests?.reason || '本次没有可核实的自动测试记录' },
      { name: '人工证据', value: require('./acceptance').checklist.filter(c => !report.acceptance?.[c.id]?.checked || (report.acceptance[c.id].evidence || '').trim().length < 8).length ? '五类交付证据尚未填写完整' : '已填写（用户声明）' },
      ...(pipeline.counts ? [{ name: '多场景验收', value: `通过 ${pipeline.counts.passed} / ${pipeline.counts.total}；未验证 ${pipeline.counts.pending}；失败 ${pipeline.counts.failed}；需重核 ${pipeline.counts.invalid}；不适用 ${pipeline.counts.notApplicable}` }] : [])
    ], next: report.id !== latestId ? '打开最新检查并处理其结果' : report.status === 'running' ? '等待检查完成' : report.status !== 'completed' ? '处理失败原因后重新检查' : sourceCheck?.status !== 'CURRENT' && report.scope !== 'github' ? '核对提示中的变化或读取错误，然后重新检查' : result.blockers.length ? '处理自动检查阻断并重新检查' : result.missing.length ? '补充真实验证记录并保存人工验收' : '当前记录已满足本次检查范围的验收条件；后续改动需重新检查' };
}
module.exports = { readiness };
