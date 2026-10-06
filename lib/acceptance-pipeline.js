const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const categories = { functional: '正常功能', boundary: '输入边界', failure: '异常与依赖故障', security: '权限与安全', data: '数据与并发', performance: '性能与资源', compatibility: '兼容与回归', recovery: '恢复与可观测性' };
const definitions = [
  ['normal', 'functional', '正常主流程', true, '有效用户、合法输入及正常依赖', '按任务约定执行完整操作，检查返回值与持久化结果', '返回和最终状态符合需求，没有多余副作用'],
  ['branches', 'functional', '业务分支与状态转换', true, '不同业务类型及允许、禁止的状态转换', '逐一执行关键分支，尝试非法状态转换', '合法分支正确，非法转换被拒绝且原状态保持一致'],
  ['contract', 'functional', '接口与错误约定', true, '成功、业务失败、系统失败三类请求', '核对返回字段、错误码和错误信息', '响应符合接口约定，失败不会伪装为成功'],
  ['null', 'boundary', '空值与缺失字段', true, '空值、空集合、空字符串、缺失必填项', '逐个省略字段或传入空值，观察校验与状态', '明确区分可选和必填项，拒绝无效输入且不产生脏数据'],
  ['bounds', 'boundary', '最小值、最大值与临界点', true, '最小值、最大值、阈值内外各一个输入', '针对长度、金额、数量、页码逐项检查临界点', '临界条件无偏差、溢出或越界，失败行为明确'],
  ['encoding', 'boundary', '中文、Unicode 与特殊字符', false, '中文、表情、组合字符、换行和转义字符', '执行输入、保存、检索与输出的往返检查', '字符不乱码、不截断，显示与存储保持约定一致'],
  ['precision', 'boundary', '精度、时区与日期边界', false, '小数舍入、零点跨日、闰日和不同时区', '按业务规则核对计算、序列化与日期比较', '精度、舍入和时间含义一致，不丢金额或跨日状态'],
  ['volume', 'boundary', '超长输入与大集合', false, '达到上限及超过上限的字符串、文件或集合', '检查拒绝策略、分批处理和资源释放', '有明确限制，不无限占用内存或输出部分成功'],
  ['invalid', 'failure', '非法输入与格式错误', true, '错误类型、无效编号、损坏格式、非法枚举', '尝试解析与业务调用并检查错误响应', '错误被明确拒绝，无未捕获异常或数据污染'],
  ['timeout', 'failure', '超时与依赖不可用', false, '数据库或外部服务超时、断连、不可用', '在隔离测试环境模拟依赖故障并检查重试', '超时有界，重试受限，错误可追踪且不重复写入'],
  ['partial', 'failure', '部分失败与错误传播', true, '多步骤流程中间一步失败', '模拟步骤失败并核对先前操作的最终状态', '失败不会被吞掉，回滚或补偿符合约定'],
  ['retry', 'failure', '重复重试与取消', false, '连续失败后恢复、取消或主动停止的请求', '核对重试次数、取消传播和资源关闭', '没有无限重试、僵尸任务或取消后的继续写入'],
  ['auth', 'security', '未登录与凭据失效', false, '无凭据、失效凭据、过期会话', '调用受保护操作并核对响应与数据', '受保护操作被拒绝，不能泄露私有信息'],
  ['roles', 'security', '越权与租户隔离', false, '普通角色、其他用户或其他租户的资源编号', '尝试读取、修改及批量操作非授权资源', '服务端按实际身份授权，不允许越权或跨租户访问'],
  ['injection', 'security', '注入、路径和命令参数', false, '包含引号、路径上跳、命令分隔符的测试输入', '只在隔离环境验证输入约束与固定参数处理', '输入不会改变查询、文件访问或程序执行的权限范围'],
  ['secrets', 'security', '敏感信息与日志脱敏', true, '包含测试用凭据、个人信息的成功和失败输入', '核对响应、日志、导出与异常消息', '凭据和敏感信息不进入可公开的输出'],
  ['duplicate', 'data', '重复提交与幂等', false, '同一业务请求连续提交及超时后重试', '检查重复响应、记录数量和外部副作用', '按业务约定只产生允许数量的记录与副作用'],
  ['concurrency', 'data', '并发竞争与丢失更新', false, '多个请求同时修改同一资源', '在隔离环境并发执行，核对最终状态和冲突响应', '无丢失更新、重复扣减、超卖或无界等待'],
  ['transaction', 'data', '事务回滚与数据一致性', false, '写入流程中途失败及约束冲突', '核对相关记录、余额、索引和补偿动作', '提交具有一致性，失败后没有半完成数据'],
  ['persistence', 'data', '保存、重启与重新读取', false, '已完成写入的记录和运行中任务', '重启隔离实例后重新读取并检查中断记录', '完成数据保留，中断任务不被误认为成功'],
  ['migration', 'data', '迁移与历史数据', false, '旧版本数据、空数据库及重复迁移执行', '在副本上升级并核对兼容与恢复方法', '历史数据可用，迁移不重复破坏已有数据'],
  ['latency', 'performance', '响应时间与吞吐', false, '明确数量、并发数和持续时间的代表性负载', '记录环境、负载、响应分位数和错误率', '满足项目填写的性能目标，结果可以复现'],
  ['resources', 'performance', '内存、连接与资源泄漏', false, '长时间重复请求、大对象及失败路径', '比较稳定运行前后的内存、线程与连接数量', '资源不会持续无界增长，失败路径正确释放资源'],
  ['java8', 'compatibility', '运行版本与构建兼容', true, '项目约定的 JDK、构建工具与运行配置', '使用目标版本构建并启动或运行相关测试', '符合目标环境，不依赖未声明的高版本 API'],
  ['regression', 'compatibility', '原有功能回归', true, '本次改动涉及的旧功能及相邻调用方', '执行已有回归用例和关键历史缺陷用例', '原有行为符合约定，没有新增失败'],
  ['integration', 'compatibility', '模块与外部接口联调', false, '真实测试依赖或明确行为的替身', '验证序列化、字段映射和失败传播', '调用约定一致，替身验证的范围明确'],
  ['configuration', 'compatibility', '配置差异与缺少配置', false, '正常配置、缺失配置和无效配置', '验证启动、默认值、配置校验与诊断', '错误配置明确报错，不使用危险默认值'],
  ['rollback', 'recovery', '回退与恢复演练', false, '预先准备的隔离副本、备份及回退步骤', '在副本演练恢复并验证恢复后的关键行为', '步骤可执行，数据和服务恢复满足约定'],
  ['observability', 'recovery', '故障诊断与日志追踪', true, '一次可复现的业务失败和系统失败', '通过日志或追踪编号定位原因并核对脱敏', '可以定位故障，没有吞错或泄露敏感内容'],
  ['scope', 'recovery', '改动范围与交付核对', true, '任务允许范围、实际差异及交付文件', '核对无关改动、生成文件、依赖变更和恢复说明', '改动符合约定，剩余限制明确，恢复方案可找到']
];

/** 返回可编辑的场景模板；模板不是已经执行过的测试，confirmed 必须由用户在保存时确认。 */
function template() {
  return { name: '代码实现质量验收', confirmed: false, requireFull: true, requireBrief: true, minTests: 1, noSkipped: false,
    cases: definitions.map(([id, category, title, required, input, steps, expected]) => ({ id, category, title, required, input, steps, expected })) };
}

/** input 为完整方案草稿；限制字段、数量、唯一编号和总大小，返回仅含已知字段的副本。 */
function validatePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('验收方案格式不正确');
  const text = (value, name, max) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error(`${name}需要文字，最多 ${max} 字`); return value.trim(); };
  const result = { name: text(input.name, '方案名称', 80) };
  for (const key of ['confirmed', 'requireFull', 'requireBrief', 'noSkipped']) {
    if (typeof input[key] !== 'boolean') throw Error('验收方案选项不正确'); result[key] = input[key];
  }
  if (!Number.isSafeInteger(input.minTests) || input.minTests < 0 || input.minTests > 1000000) throw Error('最低执行测试数需为 0 到 1,000,000 的整数');
  if (!input.requireFull && (input.minTests > 0 || input.noSkipped)) throw Error('要求自动测试数量或禁止跳过测试时，必须启用完整构建');
  result.minTests = input.minTests;
  if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 60) throw Error('方案需要 1 到 60 个场景');
  const ids = new Set();
  result.cases = input.cases.map(c => {
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || Object.hasOwn(Object.prototype, c.id) || ids.has(c.id)) throw Error('场景编号无效或重复'); ids.add(c.id);
    if (!Object.hasOwn(categories, c.category) || typeof c.required !== 'boolean') throw Error('场景类别或必测选项不正确');
    if (c.testRef !== undefined && (typeof c.testRef !== 'string' || (c.testRef && !/^[A-Za-z_$][\w.$]{0,199}#[^\r\n<>&]{1,200}$/.test(c.testRef)))) throw Error('自动测试标识需为完整类名#测试名，最多 400 字');
    if (c.testRef && !result.requireFull) throw Error('绑定自动测试的场景需要启用完整构建');
    return { id: c.id, category: c.category, required: c.required, title: text(c.title, '场景名称', 100), ...(c.testRef ? { testRef: c.testRef } : {}),
      input: text(c.input, '测试输入与前置条件', 1000), steps: text(c.steps, '验证步骤', 1000), expected: text(c.expected, '预期结果', 1000) };
  });
  if (!result.cases.some(c => c.required)) throw Error('至少需要一个必测场景');
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 48000) throw Error('验收方案超过 48 KB，请缩减场景文字');
  return result;
}

/** 方案正文按需读取；root 为数据目录，保存以版本 UUID 为文件名，不覆盖历史方案。 */
class PipelineStore {
  constructor(root) { this.directory = path.join(root, 'pipelines'); }
  file(id) { if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw Error('验收方案编号不正确'); return path.join(this.directory, id + '.json'); }
  async get(id) { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
  async put(input) {
    const plan = { ...validatePlan(input), id: crypto.randomUUID(), updatedAt: new Date().toISOString(), version: 1 };
    await fs.mkdir(this.directory, { recursive: true }); const file = this.file(plan.id);
    await fs.writeFile(file + '.tmp', JSON.stringify(plan)); await fs.rename(file + '.tmp', file); return plan;
  }
}

/** 仅由真实报告和逐场景证据计算缺口；人工证据不能替代自动构建、测试或解除自动门禁。 */
function pipelineGaps(report) {
  const p = report.acceptancePipeline;
  if (!p) return { blockers: [], missing: [], counts: null };
  const plan = p.plan, blockers = [], missing = [], counts = { passed: 0, failed: 0, pending: 0, notApplicable: 0, invalid: 0, total: plan.cases.length };
  if (!plan.confirmed) blockers.push('验收方案仍是模板草稿，需要按实际业务调整并确认后重新检查');
  if (plan.requireBrief && !require('./coding-brief').briefStatus(report.codingBrief).ready) blockers.push('流水线要求完整任务约定；请填写后重新检查');
  if (plan.requireFull && (report.mode !== 'full' || report.scope !== 'project')) blockers.push('流水线要求整个项目的完整构建与分析，当前检查范围不足');
  if (plan.requireFull) {
    if (report.build?.status !== 'completed') blockers.push('流水线尚未成功完成本次构建');
    const tests = report.buildTests;
    if (!tests?.available) blockers.push('流水线缺少本次构建的可核实测试报告');
    else {
      if (tests.executed < plan.minTests) blockers.push(`流水线实际执行测试 ${tests.executed} 个，要求至少 ${plan.minTests} 个`);
      if (tests.failures || tests.errors) blockers.push('流水线存在失败或错误的自动测试');
      if (plan.noSkipped && tests.skipped) blockers.push(`流水线禁止跳过测试，本次跳过 ${tests.skipped} 个`);
    }
  }
  for (const c of plan.cases) {
    const r = p.results?.[c.id];
    if (c.testRef && r?.origin !== 'automatic') { counts.pending++; missing.push(`场景需要真实自动测试结果：${c.title}`); continue; }
    if (!r || r.status === 'pending') { counts.pending++; missing.push(`场景未验证：${c.title}`); continue; }
    if (r.status === 'failed') { counts.failed++; blockers.push(`场景未通过：${c.title}`); continue; }
    if (!['passed', 'notApplicable'].includes(r.status) || typeof r.actual !== 'string' || r.actual.trim().length < 8 || typeof r.evidence !== 'string' || r.evidence.trim().length < 8 || (c.required && r.status === 'notApplicable') || r.sourceStatus !== 'CURRENT' || !report.sourceSnapshot || r.sourceDigest !== report.sourceSnapshot.digest) {
      counts.invalid++; missing.push(`场景证据需要重新核实：${c.title}`); continue;
    }
    if (r.status === 'notApplicable') counts.notApplicable++; else counts.passed++;
  }
  return { blockers, missing, counts };
}

/** report 为扫描快照，input 为单个场景结果，sourceCheck 为服务端核对；记录人工声明和原结果历史。 */
function setCaseResult(report, caseId, input, sourceCheck) {
  if (report.status !== 'completed' || !report.acceptancePipeline) throw Error('请先完成绑定验收方案的检查');
  const c = report.acceptancePipeline.plan.cases.find(c => c.id === caseId);
  if (!c) throw Error('场景不存在');
  if (c.testRef) throw Error('该场景绑定自动测试，人工记录不能替代；请修改测试并重新执行');
  if (!input || !['pending', 'passed', 'failed', 'notApplicable'].includes(input.status)) throw Error('场景结果不正确');
  for (const key of ['actual', 'evidence']) if (typeof input[key] !== 'string' || input[key].length > 1000 || (input.status !== 'pending' && input[key].trim().length < 8)) throw Error('实际结果和验证证据各最多 1000 字；已验证或不适用时各至少 8 字');
  if (c.required && input.status === 'notApplicable') throw Error('必测场景不能标记不适用，请调整项目方案后重新运行');
  const results = report.acceptancePipeline.results || {}, previous = results[caseId];
  const history = [...(previous?.history || [])];
  if (previous) { const old = { ...previous }; delete old.history; history.push(old); }
  if (history.length >= 20) throw Error('单个场景达到 20 次记录上限；请重新检查，旧证据保留');
  const result = { status: input.status, actual: input.actual.trim(), evidence: input.evidence.trim(), origin: 'human',
    recordedAt: new Date().toISOString(), sourceStatus: sourceCheck?.status || 'UNKNOWN', sourceDigest: sourceCheck?.digest || null, sourceCheckedAt: sourceCheck?.checkedAt || null, history };
  report.acceptancePipeline.results = { ...results, [caseId]: result };
  return result;
}

/** 将绑定场景与本次构建的精确测试标识关联；跳过、缺失或范围不足保持未验证。 */
function applyAutomaticCases(report, sourceCheck) {
  if (!report.acceptancePipeline) return;
  for (const c of report.acceptancePipeline.plan.cases.filter(c => c.testRef)) {
    const evidence = report.buildTests?.caseEvidence;
    const matches = evidence?.available ? evidence.results.filter(r => r.testRef === c.testRef) : [];
    const verified = report.mode === 'full' && report.scope === 'project' && report.buildTests?.available;
    const failed = matches.some(m => m.status === 'failed');
    const passed = verified && matches.length > 0 && matches.every(m => m.status === 'passed') && report.build?.status === 'completed';
    const status = verified && failed ? 'failed' : passed ? 'passed' : 'pending';
    report.acceptancePipeline.results[c.id] = { status, origin: 'automatic', testRef: c.testRef,
      actual: status === 'passed' ? `绑定测试 ${c.testRef} 实际通过（${matches.length} 条记录）` : status === 'failed' ? `绑定测试 ${c.testRef} 实际失败` : '绑定测试未执行、被跳过或证据无法核实',
      evidence: matches.length ? [...new Set(matches.map(m => m.report))].join('；').slice(0, 1000) : evidence?.reason || '没有找到本次构建中精确匹配的测试报告',
      recordedAt: new Date().toISOString(), sourceStatus: sourceCheck?.status || 'UNKNOWN', sourceDigest: sourceCheck?.digest || null, sourceCheckedAt: sourceCheck?.checkedAt || null, history: [] };
  }
}

/** 按当前扫描阶段和证据生成八阶段流水线；freshness 与 latestId 可用于实时核对，历史报告不会被改写。 */
function evaluatePipeline(report, freshness, latestId = report.id, latestPlanId) {
  const p = report.acceptancePipeline;
  if (!p) throw Error('本报告没有绑定验收流水线');
  const gaps = pipelineGaps(report), stages = [];
  const add = (id, name, status, detail) => stages.push({ id, name, status, detail });
  const plan = p.plan, full = report.mode === 'full' && report.scope === 'project';
  const running = report.status === 'running';
  const briefReady = require('./coding-brief').briefStatus(report.codingBrief).ready;
  add('requirements', '01 · 需求与验收方案', plan.confirmed && (!plan.requireBrief || briefReady) ? 'PASSED' : 'BLOCKED', `方案 ${plan.name} · ${plan.cases.length} 个场景；${briefReady ? '绑定任务约定已填写' : '未绑定完整任务约定'}`);
  add('environment', '02 · 环境与准备', report.preflight?.ready ? 'PASSED' : report.status === 'running' ? 'RUNNING' : 'BLOCKED', report.preflight?.checks?.filter(c => !c.passed).map(c => `${c.name}：${c.detail}`).join('；') || (report.preflight?.ready ? '本次检查的前置条件已验证' : '尚未确认准备情况'));
  const high = (report.issues || []).filter(i => i.type === 'LOCAL' && ['HIGH', 'CRITICAL', 'BLOCKER'].includes(i.severity)).length;
  add('static', '03 · 本地风险检查', high ? 'FAILED' : report.localCompleted ? 'PASSED' : report.stage === 'local' && running ? 'RUNNING' : running ? 'WAITING' : 'BLOCKED', report.localCompleted ? `发现 ${high} 条本地高风险；这是启发式检查` : '本地规则尚未完成');
  add('build', '04 · 构建与自动测试', !plan.requireFull && !full ? 'NOT_REQUIRED' : report.build?.status === 'failed' || (report.buildTests?.available && (report.buildTests.failures || report.buildTests.errors)) ? 'FAILED' : report.build?.status === 'completed' && report.buildTests?.available && report.buildTests.executed >= plan.minTests && (!plan.noSkipped || !report.buildTests.skipped) ? 'PASSED' : report.stage === 'build' && running ? 'RUNNING' : running ? 'WAITING' : 'BLOCKED', report.buildTests?.available ? `执行 ${report.buildTests.executed}，跳过 ${report.buildTests.skipped}，失败 ${report.buildTests.failures}，错误 ${report.buildTests.errors}` : report.buildTests?.reason || (full ? '尚无本次构建的测试数量证据' : '当前仅做本地检查，没有运行构建与自动测试'));
  add('quality', '05 · 综合质量门禁', report.status === 'completed' && report.gate?.status === 'PASSED' ? 'PASSED' : report.gate?.status === 'FAILED' ? 'FAILED' : running ? (['sonar', 'processing', 'import'].includes(report.stage) ? 'RUNNING' : 'WAITING') : 'BLOCKED', (report.gate?.checks || []).filter(c => c.passed !== true).map(c => `${c.name}：${c.value ?? '缺少数据'}；要求 ${c.target}`).join('；') || (report.status === 'completed' ? '按当次规则、要求和测量结果判断' : '检查未完成，不能宣布通过'));
  add('scenarios', '06 · 多场景行为验收', gaps.counts.failed ? 'FAILED' : gaps.counts.pending || gaps.counts.invalid ? 'PENDING' : 'PASSED', `通过 ${gaps.counts.passed}，失败 ${gaps.counts.failed}，未验证 ${gaps.counts.pending}，需重核 ${gaps.counts.invalid}，有理由不适用 ${gaps.counts.notApplicable}；绑定测试自动采集，其他场景为人工验证声明`);
  const { checklist } = require('./acceptance');
  const humanMissing = checklist.filter(c => !report.acceptance?.[c.id]?.checked || (report.acceptance[c.id].evidence || '').trim().length < 8).map(c => c.name);
  add('human', '07 · 交付与人工证据', humanMissing.length ? 'PENDING' : 'PASSED', humanMissing.length ? '缺少：' + humanMissing.join('、') : '五类证据已填写，仍属于人工声明');
  const current = freshness || report.acceptanceSourceCheck;
  const latest = report.id === latestId, samePlan = !latestPlanId || plan.id === latestPlanId;
  add('version', '08 · 代码版本与最终核对', running ? 'WAITING' : current?.status === 'CURRENT' && latest && samePlan ? 'PASSED' : 'BLOCKED', !latest ? '此报告不是项目最新一次检查' : !samePlan ? '项目验收方案已更新，请按新方案重新检查' : current?.reason || '尚未核对当前代码');
  const blockers = [...gaps.blockers, ...stages.filter(s => ['FAILED', 'BLOCKED'].includes(s.status)).map(s => s.name + '：' + s.detail)];
  if (report.status === 'failed') blockers.unshift('检查失败 / 未完成：' + (report.error || '请查看日志'));
  const missing = [...gaps.missing, ...humanMissing.map(n => '人工证据：' + n)];
  const status = report.status === 'running' ? 'RUNNING' : blockers.length ? 'BLOCKED' : missing.length ? 'PENDING' : 'READY';
  return { reportId: report.id, planId: plan.id, checkedAt: new Date().toISOString(), status, stages, blockers: [...new Set(blockers)], missing,
    counts: gaps.counts, next: report.status === 'running' ? '等待自动检查完成' : blockers[0] || missing[0] || '本次范围的验收条件已满足；代码变化后需要重新检查',
    limits: ['绑定场景使用本次构建的精确测试标识；未绑定场景由人工实际验证，文字步骤不会自动执行。', '测试名关联不证明测试断言覆盖了全部业务要求，需审查测试本身。', '检查范围与代码指纹覆盖范围见报告；环境、数据库和外部依赖变化不在源码指纹范围内。'] };
}

/** 导出带固定方案版本的完整步骤；用户文字以引用呈现，不视为执行命令。 */
function planMarkdown(project, plan, report, summary) {
  const quote = value => String(value || '尚未填写').split(/\r?\n/).map(s => '> ' + s).join('\n');
  const lines = [`# ${project.name} · ${plan.name}`, `方案版本：${plan.id || '模板草稿'}；保存时间：${plan.updatedAt || '未保存'}`, `自动要求：${plan.requireFull ? '完整构建 / 测试 / 质量分析' : '本地规则'}；最低执行测试 ${plan.minTests}；${plan.noSkipped ? '禁止跳过测试' : '跳过测试单独记录'}`, '流程：需求与方案 → 环境 → 本地风险 → 构建测试 → 综合门禁 → 多场景验证 → 交付证据 → 版本核对', '在隔离测试环境执行故障、并发、迁移及回退场景。填写实际结果和可复现证据；未执行不得填通过。模板需按业务修改，文字步骤不会由平台自动执行。'];
  if (summary) lines.push(`本次报告：${report.id}；开始：${report.startedAt}；状态：${summary.status}`, ...summary.stages.map(s => `- ${s.name}：${s.status}；${s.detail}`), '下一步：' + summary.next);
  for (const c of plan.cases) {
    const result = report?.acceptancePipeline?.results?.[c.id];
    lines.push(`## ${categories[c.category]} · ${c.title} [${c.id}]`, c.required ? '必测；不能标记不适用' : '可标记不适用，但必须说明理由', '输入与前置条件：\n' + quote(c.input), '验证步骤：\n' + quote(c.steps), '预期结果：\n' + quote(c.expected));
    if (c.testRef) lines.push('自动测试绑定：' + quote(c.testRef));
    if (result) {
      lines.push(`记录结果：${result.status}；来源：${result.origin === 'automatic' ? '本次构建自动测试' : '人工声明'}；时间：${result.recordedAt}；代码核对：${result.sourceStatus}`, '实际结果：\n' + quote(result.actual), '验证证据：\n' + quote(result.evidence));
      // 复验不会覆盖先前失败的证据，导出也保留有限的修订历史。
      for (const previous of result.history || []) lines.push(`历史记录：${previous.status}；时间：${previous.recordedAt}；代码核对：${previous.sourceStatus}`, '历史实际结果：\n' + quote(previous.actual), '历史验证证据：\n' + quote(previous.evidence));
    }
  }
  if (summary) lines.push('## 未满足的条件', ...summary.blockers.map(quote), ...summary.missing.map(quote), ...summary.limits.map(quote));
  return lines.join('\n\n') + '\n';
}

module.exports = { categories, template, validatePlan, PipelineStore, pipelineGaps, setCaseResult, applyAutomaticCases, evaluatePipeline, planMarkdown };
