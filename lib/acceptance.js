const checklist = [
  { id: 'requirements', name: '需求符合预期', description: '记录真实输入、预期结果和实际结果。' },
  { id: 'boundaries', name: '边界与异常已验证', description: '检查空值、无权限、重复提交、失败及恢复场景。' },
  { id: 'tests', name: '测试证据已检查', description: '填写测试命令与结果；不能只依赖 AI 声称测试通过。' },
  { id: 'security', name: '数据与权限已审查', description: '确认敏感信息、外部命令、数据库修改和权限控制。' },
  { id: 'scope', name: '改动范围与回退已确认', description: '确认没有无关改动，并说明回退或恢复步骤。' }
];

/** Validate human evidence per immutable report; checked boxes alone never count as acceptance. */
function validateAcceptance(input) {
  if (!input || typeof input !== 'object') throw new Error('验收内容不正确');
  const result = {};
  for (const item of checklist) {
    const entry = input[item.id];
    if (!entry || typeof entry.checked !== 'boolean' || typeof entry.evidence !== 'string' || entry.evidence.length > 2000) throw new Error('每项验收需要状态与不超过 2000 字的证据');
    if (entry.checked && entry.evidence.trim().length < 8) throw new Error(`${item.name}：请填写至少 8 字的验证证据`);
    result[item.id] = { checked: entry.checked, evidence: entry.evidence.trim() };
  }
  return result;
}

/** Combine automated blockers and human evidence without claiming build/test success from a local scan. */
function acceptanceStatus(report) {
  if (report.status !== 'completed' || report.gate?.status !== 'PASSED') return 'BLOCKED';
  if (report.acceptanceSourceCheck && report.acceptanceSourceCheck.status !== 'CURRENT') return 'BLOCKED';
  const pipeline = require('./acceptance-pipeline').pipelineGaps(report);
  if (pipeline.blockers.length) return 'BLOCKED';
  if (pipeline.missing.length) return 'PENDING';
  return checklist.every(item => report.acceptance?.[item.id]?.checked && report.acceptance[item.id].evidence.length >= 8) ? 'REVIEWED' : 'PENDING';
}
/** Explain missing evidence and automatic limits for this report; manual statements never prove test execution. */
function reviewReadiness(report) {
  const blockers = [];
  if (report.status !== 'completed') blockers.push('检查未完成，不能验收');
  if (report.acceptanceSourceCheck && report.acceptanceSourceCheck.status !== 'CURRENT') blockers.push(report.acceptanceSourceCheck.reason);
  if (report.gate?.status !== 'PASSED') blockers.push(report.gate?.status === 'FAILED' ? '自动检查未通过，请处理报告中的风险并重新检查' : '自动检查结果不完整或未知，请补充检查');
  for (const check of report.gate?.checks || []) if (check.passed !== true) blockers.push(`${check.name}：${check.value == null ? '缺少可核实数据' : check.value}；要求 ${check.target}`);
  const missing = checklist.filter(item => !report.acceptance?.[item.id]?.checked || (report.acceptance[item.id].evidence || '').trim().length < 8).map(item => item.name);
  const limits = [];
  if (report.mode !== 'full' || report.scope === 'github') limits.push('本报告没有执行编译、单元测试或覆盖率测量；需补充实际运行记录');
  if (report.scope === 'changed' || report.scope === 'github') limits.push('本报告仅检查改动范围，不能证明整个项目通过');
  if (!report.codingBrief) limits.push('本次检查未绑定 AI 任务约定；当前项目约定不会补写到旧报告');
  else {
    const status = require('./coding-brief').briefStatus(report.codingBrief);
    if (!status.ready) limits.push('绑定的任务约定仍是草稿，缺少：' + status.missing.join('、'));
  }
  limits.push('报告只对应当次检查；后续代码改动需要重新检查。人工证据为用户声明，未由平台自动执行验证。');
  const pipeline = require('./acceptance-pipeline').pipelineGaps(report);
  blockers.push(...pipeline.blockers); missing.push(...pipeline.missing);
  return { status: acceptanceStatus(report), blockers, missing, limits };
}
module.exports = { checklist, validateAcceptance, acceptanceStatus, reviewReadiness };
