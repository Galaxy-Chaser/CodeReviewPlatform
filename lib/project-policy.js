const defaults = { requireBrief: false, requireFull: false, minTests: 0, blockMedium: false, gate: null };

/** Validate project-specific requirements. input contains booleans, a minimum executed-test count and optional metric thresholds. */
function validatePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('项目质量约定格式不正确');
  for (const key of ['requireBrief', 'requireFull', 'blockMedium']) if (typeof input[key] !== 'boolean') throw new Error('质量约定选项不正确');
  if (!Number.isSafeInteger(input.minTests) || input.minTests < 0 || input.minTests > 1000000) throw new Error('最低测试数量需为 0 到 1,000,000 的整数');
  if (input.gate !== null && (!input.gate || !['coverage', 'duplication'].every(key => Number.isFinite(input.gate[key]) && input.gate[key] >= 0 && input.gate[key] <= 100))) throw new Error('项目门禁阈值需为 0 到 100');
  return { requireBrief: input.requireBrief, requireFull: input.requireFull, minTests: input.minTests, blockMedium: input.blockMedium,
    gate: input.gate === null ? null : { coverage: input.gate.coverage, duplication: input.gate.duplication } };
}

/** Merge automated checks with the report's frozen policy. Missing measurements are UNKNOWN; human evidence cannot change them. */
function applyPolicy(report, automatedGate) {
  const policy = { ...defaults, ...report.policy }, checks = [...(automatedGate?.checks || [])];
  const add = (name, value, target, passed) => checks.push({ name, value, target, passed });
  // 空扫描不能证明项目通过；完整分析仍可能由 Sonar 提供其他语言的真实结果。
  if (report.mode !== 'full' && report.scope !== 'github' && report.metrics?.files === 0) add('本地规则支持的源文件', 0, '至少一个 Java / SQL 文件；其他语言需相应检查', null);
  const high = (report.issues || []).filter(i => ['HIGH', 'CRITICAL', 'BLOCKER'].includes(i.severity)).length;
  add('已检查范围的高风险问题', high, '= 0', high === 0);
  if (policy.blockMedium) {
    const medium = (report.issues || []).filter(i => ['MEDIUM', 'MAJOR'].includes(i.severity)).length;
    add('项目约定：中风险问题', medium, '= 0', medium === 0);
  }
  if (policy.requireBrief) {
    const complete = require('./coding-brief').briefStatus(report.codingBrief).ready;
    add('项目约定：完整 AI 任务约定', complete ? '已填写' : '缺少或仍为草稿', '扫描时已填写', complete);
  }
  if (policy.requireFull) add('项目约定：完整构建与分析', report.mode === 'full' ? '完整体检' : '本地规则', '完整体检', report.mode === 'full' ? true : null);
  if (policy.minTests > 0) {
    const tests = report.buildTests;
    add('项目约定：实际执行的测试', tests?.available ? tests.executed : null, `≥ ${policy.minTests}`, tests?.available ? tests.executed >= policy.minTests : null);
  }
  if (report.buildTests?.available) add('构建测试报告中的失败与错误', report.buildTests.failures + report.buildTests.errors, '= 0', !report.buildTests.failures && !report.buildTests.errors);
  const status = automatedGate?.status === 'FAILED' || checks.some(c => c.passed === false) ? 'FAILED' : automatedGate?.status !== 'PASSED' || checks.some(c => c.passed === null) ? 'UNKNOWN' : 'PASSED';
  return { status, checks };
}

/** Compare only effective requirements, excluding save timestamps/version IDs that do not change their meaning. */
function policyKey(report) {
  const p = { ...defaults, ...report.policy };
  return JSON.stringify([p.requireBrief, p.requireFull, p.minTests, p.blockMedium, report.settings?.gate]);
}
module.exports = { defaults, validatePolicy, applyPolicy, policyKey };
