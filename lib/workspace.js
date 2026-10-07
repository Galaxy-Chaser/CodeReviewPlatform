const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { syncIndex } = require('./work-sync');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const kinds = ['requirements', 'tasks', 'knowledge'];
const taskStatuses = ['ready', 'in_progress', 'review', 'done', 'blocked'];
const maxBytes = 8 * 1024 * 1024;

/** 统一返回可展示的校验错误，status 可区分版本冲突、越权与不存在。 */
function reject(message, status = 400) { throw Object.assign(Error(message), { status }); }
/** 校验人和 agent 提供的文字，禁止超限、控制字符和非字符串值。 */
function text(value, name, max = 3000, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) reject(`${name}需填写 ${min}–${max} 字`);
  return value.trim();
}
function id(value, name = '编号') { if (!uuid.test(value || '')) reject(`${name}不正确`); return value; }
/** 只接受项目内的相对文件名作为声明；不读取或执行这些路径。 */
function files(value = []) {
  if (!Array.isArray(value) || value.length > 50) reject('改动文件最多 50 项');
  return [...new Set(value.map(v => { const s = text(v, '改动文件', 250); if (/^(?:\/|\\|[A-Za-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(s)) reject('改动文件必须是项目内相对路径'); return s; }))];
}
/** 需求、任务、知识分别保留自己的输入，不把客户端任意字段写入数据。 */
function fields(kind, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject('记录格式不正确');
  const base = { projectId: input.projectId ? id(input.projectId, '项目编号') : '', title: text(input.title, '名称', 120) };
  if (kind !== 'knowledge' && !base.projectId) reject('请选择项目');
  if (kind === 'requirements') return { ...base, description: text(input.description, '需求说明'), criteria: text(input.criteria, '验收条件'), allowedPaths: text(input.allowedPaths, '允许改动范围', 1000) };
  if (kind === 'tasks') {
    if (typeof input.requireReport !== 'boolean') reject('请明确是否要求扫描验收');
    return { ...base, requirementId: input.requirementId ? id(input.requirementId, '需求编号') : '', description: text(input.description, '任务说明'), criteria: text(input.criteria, '任务验收条件'), requireReport: input.requireReport };
  }
  if (kind === 'knowledge') {
    if (!Array.isArray(input.tags) || input.tags.length > 8) reject('知识标签最多 8 个');
    return { ...base, symptom: text(input.symptom, '问题表现'), cause: text(input.cause, '原因'), solution: text(input.solution, '处理方法'), verification: text(input.verification, '验证方法'), tags: [...new Set(input.tags.map(t => text(t, '标签', 40)))], source: input.source || null };
  }
  reject('记录类别不正确');
}
function find(doc, kind, value) { id(value); return doc[kind].find(r => r.id === value) || reject('记录不存在', 404); }
function version(row, expected) { if (expected !== row.version) reject('记录已变化，请重新读取后再操作', 409); }
/** 保存有界历史；达到上限明确拒绝，不默默丢弃旧证据。 */
function event(row, actor, action, detail) {
  if (row.history.length >= 100) reject('此记录已有 100 条历史，请新建后续记录');
  row.version++; row.updatedAt = new Date().toISOString();
  row.history.push({ at: row.updatedAt, actor: { type: actor.type, id: actor.id || '', name: actor.name }, action, detail });
}
function requirement(doc, task) { return task.requirementId ? find(doc, 'requirements', task.requirementId) : null; }
function currentRequirement(doc, task) { const r = requirement(doc, task); if (r && r.version !== task.requirementVersion) reject('关联需求已变化，请释放任务并更新验收条件后重做', 409); }
function activeLease(task, now = Date.now()) { return task.claim && (task.claim.actor.type === 'human' || Date.parse(task.claim.expiresAt) > now); }

/** 保留提交时绑定的需求，独立判断旧证据；旧备份缺少版本时明确标为未知，不猜测。 */
function submissionRequirement(task, linked) {
  const s = task.submission;
  if (!s) return { status: 'NONE' };
  if (!Object.hasOwn(s, 'requirementId') || !Object.hasOwn(s, 'requirementVersion')) return { status: 'UNKNOWN' };
  return { status: s.requirementId === task.requirementId && s.requirementVersion === (linked?.version || null) ? 'CURRENT' : 'CHANGED',
    id: s.requirementId, version: s.requirementVersion };
}

/** doc/task 为同一次读取的工作区与任务，actor 为当前参与者，now 固定租约判断时刻。
 * archived 禁止写入；返回可能的状态操作与下一步，不代替保存时的版本、扫描和权限核对。
 */
function taskCoordination(doc, task, actor, archived = false, now = Date.now()) {
  const linked = requirement(doc, task), changed = !!linked && linked.version !== task.requirementVersion;
  const active = !!activeLease(task, now), claim = task.claim;
  const human = actor.type === 'human', mine = !!claim && claim.actor.type === actor.type && claim.actor.id === actor.id;
  const actions = [], blockers = [], historyRemaining = Math.max(0, 100 - task.history.length);
  if (archived) blockers.push({ code: 'PROJECT_ARCHIVED', message: '项目已归档，请先恢复再处理任务。' });
  if (changed) blockers.push({ code: 'REQUIREMENT_CHANGED', message: '关联需求已变化，旧任务条件与提交不能用于当前需求；请更新任务后重新处理。' });
  if (!historyRemaining) blockers.push({ code: 'HISTORY_LIMIT', message: '任务历史已满，请由人工建立后续任务并引用原记录。' });
  if (!archived && historyRemaining) {
    if (['ready', 'in_progress'].includes(task.status) && !active && !changed) actions.push('claim');
    if (task.status === 'in_progress') {
      if (human || mine) actions.push('release');
      if (!changed && active && mine) actions.push(...(human ? ['submit'] : ['heartbeat', 'submit']));
    }
    if (human) {
      if (task.status === 'ready') actions.push('block', 'edit');
      if (task.status === 'blocked') actions.push('unblock', 'edit');
      if (task.status === 'review') actions.push(...(changed ? ['reject'] : ['approve', 'reject']));
      if (task.status === 'done') actions.push('reopen');
    }
  }
  let nextStep;
  if (archived || !historyRemaining) nextStep = blockers.find(blocker => blocker.code === (archived ? 'PROJECT_ARCHIVED' : 'HISTORY_LIMIT')).message;
  else if (changed) nextStep = task.status === 'in_progress' ? '先释放任务，再由人工编辑任务、核对新需求范围与验收条件，然后重新领取。' : task.status === 'review' ? '由人工退回任务，更新任务条件后重新处理并提交真实证据。' : task.status === 'done' ? '由人工重新打开任务，更新任务条件并按新需求重新验证。' : task.status === 'blocked' ? '由人工更新任务条件并处理阻塞原因，解除阻塞后再重新领取。' : '由人工编辑任务，核对并保存当前需求的范围与验收条件，再重新领取。';
  else if (task.status === 'blocked') nextStep = '等待人工处理阻塞原因并解除阻塞，再领取任务。';
  else if (task.status === 'review') nextStep = human ? '核对实际成果与测试；要求扫描的任务还会重新核对最新报告和当前源码。' : '已进入人工审核，请等待审核或退回，不要继续沿用旧领取提交。';
  else if (task.status === 'done') nextStep = '任务已人工确认；后续需求变化仍需重新处理，不能作为整个项目质量通过的证明。';
  else if (!active) nextStep = claim ? '领取已过期，重新读取上下文并领取后再继续处理。' : '核对需求范围与验收条件后领取任务，实际处理并记录验证。';
  else if (mine) nextStep = human ? '按当前范围处理任务，实际测试后提交证据供审核。' : '按当前范围处理；在领取到期前续期，实际测试后提交证据供人工审核。';
  else nextStep = human ? '任务由其他参与者处理；需要交接时先释放任务，禁止代替 agent 提交。' : '任务由其他参与者有效领取；等待释放或到期，或选择其他任务。';
  return { assessedAt: new Date(now).toISOString(), requirement: { status: linked ? changed ? 'CHANGED' : 'CURRENT' : 'NONE', boundVersion: task.requirementVersion, currentVersion: linked?.version || null }, submissionRequirement: submissionRequirement(task, linked),
    ownership: { status: claim ? active ? 'ACTIVE' : 'EXPIRED' : 'NONE', owner: claim ? { type: claim.actor.type, id: claim.actor.id, name: claim.actor.name } : null, expiresAt: claim?.expiresAt || null, mine },
    actions, blockers, historyRemaining, nextStep, limits: '仅判断此刻任务状态；保存仍需再次核对版本、授权、需求及实际报告，不证明代码质量通过。' };
}

/** 恢复前验证项目关系与数据上限；agent 访问凭据不在此文档中。 */
function validateDocument(doc, projectIds, reportProjects) {
  if (!doc || doc.format !== 'CodeHealthWorkspace' || doc.version !== 1 || !Number.isSafeInteger(doc.revision) || doc.revision < 0) reject('需求工作区格式不正确');
  const seen = new Set();
  for (const kind of kinds) {
    if (!Array.isArray(doc[kind]) || doc[kind].length > 1000) reject('需求工作区记录超限');
    for (const row of doc[kind]) {
      id(row.id); if (seen.has(row.id)) reject('需求工作区编号重复'); seen.add(row.id);
      fields(kind, row);
      if (!Number.isSafeInteger(row.version) || row.version < 1 || !Array.isArray(row.history) || row.history.length > 100) reject('记录版本或历史不正确');
      if (projectIds && row.projectId && !projectIds.has(row.projectId)) reject('需求工作区项目引用不存在');
      if (kind === 'tasks' && !taskStatuses.includes(row.status)) reject('任务状态不正确');
      if (kind === 'knowledge' && !['draft', 'published'].includes(row.status)) reject('知识状态不正确');
      for (const h of row.history) {
        if (!h || !['human', 'agent'].includes(h.actor?.type) || typeof h.actor.name !== 'string' || h.actor.name.length > 80 || !Number.isFinite(Date.parse(h.at))) reject('协作历史格式不正确');
      }
      // 修复任务的来源扫描和提交扫描都必须保留同项目引用，恢复不能漏检其中一个。
      for (const linked of [row.source?.reportId, row.submission?.reportId].filter(Boolean)) {
        id(linked); if (reportProjects && reportProjects.get(linked) !== row.projectId) reject('协作扫描引用不存在或属于其他项目');
      }
    }
  }
  for (const task of doc.tasks) {
    const r = requirement(doc, task); if (r && r.projectId !== task.projectId) reject('任务与需求项目不一致');
    if (r && (!Number.isSafeInteger(task.requirementVersion) || task.requirementVersion < 1)) reject('任务需求版本不正确');
    if (task.submission) {
      const s = task.submission;
      text(s.summary, '处理摘要', 3000, 8); text(s.tests, '实际测试与结果', 3000, 8); files(s.changedFiles);
      // 兼容旧备份；新证据的需求编号与版本必须成对保存，且引用同项目真实需求。
      if (Object.hasOwn(s, 'requirementId') || Object.hasOwn(s, 'requirementVersion')) {
        if (s.requirementId === '') { if (s.requirementVersion !== null) reject('提交需求版本不正确'); }
        else {
          const original = find(doc, 'requirements', s.requirementId);
          if (original.projectId !== task.projectId) reject('提交与需求项目不一致');
          if (!Number.isSafeInteger(s.requirementVersion) || s.requirementVersion < 1 || s.requirementVersion > original.version) reject('提交需求版本不正确');
        }
      }
    }
    if (task.status === 'in_progress' && (!task.claim || !['human', 'agent'].includes(task.claim.actor?.type) || (task.claim.actor.type === 'agent' && !Number.isFinite(Date.parse(task.claim.expiresAt))))) reject('任务领取记录不正确');
    if (['review', 'done'].includes(task.status) && !task.submission) reject('任务提交证据缺失');
    if (['review', 'done'].includes(task.status) && task.requireReport && !task.submission?.reportId) reject('任务扫描证据缺失');
  }
  for (const row of doc.knowledge) if (row.source?.taskId && find(doc, 'tasks', row.source.taskId).projectId !== row.projectId) reject('知识来源任务属于其他项目');
  if (Buffer.byteLength(JSON.stringify(doc)) > maxBytes) reject('需求工作区超过 8 MB 上限');
  return doc;
}

/** 磁盘工作区：不将需求全文加入首页索引，串行写入避免多个 agent 同时领取。 */
class WorkspaceStore {
  constructor(root) { this.file = path.join(root, 'work', 'workspace.json'); this.queue = Promise.resolve(); }
  /** 第一次按需读取，后续只返回轻量索引；较旧的初始化不能覆盖刚提交的版本。 */
  async sync() {
    if (!this.syncData) {
      this.syncRead ||= this.read().then(doc => {
        if (!this.syncData || doc.revision >= this.syncData.revision) this.syncData = syncIndex(doc);
      }).finally(() => { this.syncRead = null; });
      await this.syncRead;
    }
    return this.syncData;
  }
  async read() {
    try { const stat = await fs.stat(this.file); if (stat.size > maxBytes) reject('需求工作区超过 8 MB 上限'); return validateDocument(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { format: 'CodeHealthWorkspace', version: 1, revision: 0, requirements: [], tasks: [], knowledge: [] }; throw error; }
  }
  /** operation 在写锁内校验版本和领取条件；失败不发布新文档。 */
  mutate(operation) {
    const work = this.queue.catch(() => {}).then(async () => {
      const doc = await this.read(), result = await operation(doc); doc.revision++;
      validateDocument(doc); await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file + '.tmp', JSON.stringify(doc)); await fs.rename(this.file + '.tmp', this.file);
      this.syncData = syncIndex(doc);
      return result;
    }); this.queue = work.then(() => undefined, () => undefined); return work;
  }
}

/** 保存人定义的需求/任务，或人和 agent 提议的知识草稿。scope 负责核对项目授权。 */
function saveRecord(doc, kind, input, actor, scope) {
  const values = fields(kind, input); scope(values.projectId);
  if (actor.type === 'agent' && (kind !== 'knowledge' || !values.projectId)) reject('agent 只能提议所属项目知识草稿', 403);
  let row;
  if (input.id) {
    row = find(doc, kind, input.id); scope(row.projectId); version(row, input.expectedVersion);
    if (row.projectId !== values.projectId) reject('记录不能改换项目');
    if (actor.type === 'agent') reject('agent 不能改写已有记录', 403);
    if (kind === 'tasks' && !['ready', 'blocked'].includes(row.status)) reject('请先退回或释放任务，再编辑', 409);
    if (kind === 'knowledge' && row.status === 'published') reject('请先撤回知识发布，再编辑', 409);
  } else {
    if (doc[kind].length >= 1000) reject('每类最多 1000 条记录');
    row = { id: crypto.randomUUID(), version: 0, history: [], createdAt: new Date().toISOString(), ...values,
      ...(kind === 'tasks' ? { status: 'ready', claim: null, submission: null } : kind === 'knowledge' ? { status: 'draft' } : {}) };
    doc[kind].unshift(row);
  }
  if (kind === 'tasks') {
    const r = values.requirementId ? find(doc, 'requirements', values.requirementId) : null;
    if (r && r.projectId !== values.projectId) reject('需求属于其他项目');
    values.requirementVersion = r?.version || null;
  }
  Object.assign(row, values); event(row, actor, input.id ? 'edit' : 'create', { ...values }); return row;
}

/** 领取租约为 30 分钟，心跳续期；过期或已释放才允许另一个 agent 领取。 */
function changeTask(doc, input, actor, scope, now = Date.now()) {
  const task = find(doc, 'tasks', input.id); scope(task.projectId); version(task, input.expectedVersion);
  const action = input.action, human = actor.type === 'human';
  if (action === 'claim') {
    if (!['ready', 'in_progress'].includes(task.status) || activeLease(task, now)) reject('任务已被领取或不处于可领取状态', 409);
    currentRequirement(doc, task);
    task.status = 'in_progress'; task.claim = { actor, expiresAt: human ? null : new Date(now + 30 * 60 * 1000).toISOString() };
    event(task, actor, 'claim', { expiresAt: task.claim.expiresAt });
  } else if (action === 'heartbeat') {
    if (human || task.status !== 'in_progress' || !activeLease(task, now) || task.claim.actor.id !== actor.id) reject('领取已失效或不属于当前 agent', 409);
    currentRequirement(doc, task);
    task.claim.expiresAt = new Date(now + 30 * 60 * 1000).toISOString(); event(task, actor, action, { expiresAt: task.claim.expiresAt });
  } else if (action === 'release') {
    if (task.status !== 'in_progress' || (!human && task.claim?.actor.id !== actor.id)) reject('任务不能由当前参与者释放', 409);
    task.status = 'ready'; task.claim = null; event(task, actor, action, text(input.reason, '释放理由', 1000, 8));
  } else if (action === 'submit') {
    if (task.status !== 'in_progress' || (!human && (!activeLease(task, now) || task.claim?.actor.id !== actor.id))) reject('请先领取任务；领取失效后不能提交', 409);
    if (human && task.claim?.actor.type === 'agent') reject('agent 领取的任务需由本人提交或先释放', 409);
    currentRequirement(doc, task);
    const s = input.submission;
    if (!s || typeof s !== 'object') reject('请提供提交证据');
    const submission = { summary: text(s.summary, '处理摘要', 3000, 8), changedFiles: files(s.changedFiles), tests: text(s.tests, '实际测试与结果', 3000, 8),
      reportId: s.reportId ? id(s.reportId, '扫描报告编号') : '', requirementId: task.requirementId, requirementVersion: task.requirementVersion,
      submittedAt: new Date(now).toISOString(), actor };
    if (task.requireReport && !submission.reportId) reject('此任务要求关联扫描报告');
    task.submission = submission; task.status = 'review'; task.claim = null; event(task, actor, action, submission);
  } else if (action === 'approve' || action === 'reject') {
    if (!human) reject('agent 不能批准或退回自己的成果', 403);
    if (task.status !== 'review') reject('任务尚未提交审核', 409);
    if (action === 'approve') currentRequirement(doc, task);
    task.status = action === 'approve' ? 'done' : 'ready'; task.claim = null; event(task, actor, action, text(input.reason, '审核理由', 2000, 8));
  } else if (action === 'block' || action === 'unblock') {
    if (!human || (action === 'block' ? task.status !== 'ready' : task.status !== 'blocked')) reject('当前状态不能执行此操作', 409);
    task.status = action === 'block' ? 'blocked' : 'ready'; event(task, actor, action, text(input.reason, '操作理由', 1000, 8));
  } else if (action === 'reopen') {
    if (!human || task.status !== 'done') reject('只有人工可重新打开已完成任务', 409);
    task.status = 'ready'; task.claim = null; event(task, actor, action, text(input.reason, '重做理由', 1000, 8));
  } else reject('任务操作不正确');
  return task;
}

module.exports = { WorkspaceStore, validateDocument, saveRecord, changeTask, activeLease, taskCoordination, find, fields, event, version, reject, text, id, kinds };
