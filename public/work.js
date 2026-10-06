const workNames = { requirements: '需求', tasks: '任务', knowledge: '知识' };
const workStatuses = { ready: '待领取', in_progress: '处理中', review: '待人工审核', done: '已审核完成', blocked: '暂时阻塞', draft: '待审核草稿', published: '已发布', open: '尚未完成', fulfilled: '关联任务已确认' };
let workKind = 'requirements', workProject = '', workStatus = '', workSearch = '', workOffset = 0, workData, workSequence = 0, workFormRow, workFormKind;
let workController;

/** 需求全文按页读取；请求过期后不能覆盖新筛选，也不进入平台首页状态。 */
function workPage() {
  const kind = page === 'knowledge' ? 'knowledge' : workKind;
  // 页面切换时清除不属于当前记录类型的状态，防止把任务状态用于知识筛选。
  const allowedStatuses = kind === 'tasks' ? ['ready', 'in_progress', 'review', 'done', 'blocked'] : kind === 'knowledge' ? ['draft', 'published'] : [];
  if (workStatus && !allowedStatuses.includes(workStatus)) { workStatus = ''; workOffset = 0; }
  const signature = JSON.stringify([page, kind, workProject, workStatus, workSearch, workOffset]);
  if (workData?.signature !== signature) {
    workData = { signature, loading: true }; void loadWork(signature, kind);
  }
  const list = workData;
  return heading(page === 'knowledge' ? '问题知识库' : '需求与任务', page === 'knowledge' ? '记录问题、原因、处理与实际验证，审核后供人和本地 agent 复用。' : '连接需求、处理任务、提交证据与人工审核。完成任务不等于项目自动验收通过。', button(`新增${workNames[kind]}`, 'work-new', `data-kind="${kind}"`, 'primary')) +
    (page === 'work' ? `<div class="buttons">${['requirements', 'tasks'].map(k => button(`查看${workNames[k]}列表`, 'work-kind', `data-kind="${k}"`, workKind === k ? 'primary' : '')).join('')}</div>` : '') +
    `<div class="filters"><select id="work-project" aria-label="协作项目筛选"><option value="">全部项目</option>${state.projects.map(p => `<option value="${p.id}" ${p.id === workProject ? 'selected' : ''}>${e(p.name)}${p.archivedAt ? '（已归档）' : ''}</option>`).join('')}</select><select id="work-status" aria-label="协作状态筛选"><option value="">全部状态</option>${(kind === 'tasks' ? ['ready', 'in_progress', 'review', 'done', 'blocked'] : kind === 'knowledge' ? ['draft', 'published'] : []).map(s => `<option value="${s}" ${s === workStatus ? 'selected' : ''}>${workStatuses[s]}</option>`).join('')}</select><input id="work-search" aria-label="搜索需求任务与知识" maxlength="200" value="${e(workSearch)}" placeholder="名称、问题或标签">${button('搜索', 'work-search')}${button('刷新列表', 'work-refresh')}</div>` +
    panel(`${workNames[kind]}记录`, list.loading ? '<div class="panel-body">正在读取协作记录…</div>' : list.error ? `<div class="panel-body notice red">${e(list.error)}</div>` : !list.total ? '<div class="panel-body">当前没有匹配记录，可新建一条开始。</div>' : `<div class="table-wrap"><table><thead><tr><th>名称 / 项目</th><th>进度</th><th>更新时间</th><th>操作</th></tr></thead><tbody>${list.rows.map(r => `<tr><td>${e(r.title)}<small>${e(state.projects.find(p => p.id === r.projectId)?.name || '通用知识')}${r.tags ? ' · ' + r.tags.map(e).join('、') : ''}</small></td><td>${e(workStatuses[r.status])}${kind === 'requirements' ? `<small>当前需求版本完成 ${r.done} / ${r.tasks} 个任务</small>` : kind === 'tasks' ? `<small>${e(r.owner)}${r.leaseExpired ? ' · 领取已过期，可重新领取' : r.expiresAt ? ' · 到期 ' + e(time(r.expiresAt)) : ''}${r.requireReport ? ' · 要求实际扫描验收' : ' · 人工确认，不代表自动质量通过'}</small>` : ''}</td><td>${e(time(r.updatedAt))}</td><td>${button('查看记录', 'work-detail', `data-kind="${kind}" data-id="${r.id}"`, 'small')}</td></tr>`).join('')}</tbody></table></div><div class="panel-foot"><span>共 ${list.total} 条 · 第 ${Math.floor(list.offset / 25) + 1} 页</span><div class="buttons">${button('上一页', 'work-page', `data-offset="${list.offset - 25}" ${list.offset ? '' : 'disabled'}`, 'small')}${button('下一页', 'work-page', `data-offset="${list.offset + 25}" ${list.offset + 25 < list.total ? '' : 'disabled'}`, 'small')}</div></div>`);
}
async function loadWork(signature, kind) {
  workController?.abort(); const controller = new AbortController(); workController = controller;
  const sequence = ++workSequence;
  try {
    const query = new URLSearchParams({ kind, projectId: workProject, status: workStatus, search: workSearch, offset: workOffset });
    const result = await api('/api/work/list?' + query, undefined, controller.signal);
    if (workSequence !== sequence || workData?.signature !== signature) return;
    workData = { ...result, signature };
  } catch (error) { if (workSequence !== sequence || workData?.signature !== signature) return; workData = { signature, error: error.message }; }
  if (['work', 'knowledge'].includes(page)) render();
}
function workReload() { workData = null; if (['work', 'knowledge'].includes(page)) render(); }
function workField(key, label, value = '', rows = 3, max = 3000) { return `<div class="field"><label for="work-${key}">${e(label)}</label><textarea id="work-${key}" name="${key}" rows="${rows}" maxlength="${max}" required>${e(value)}</textarea></div>`; }

/** 将操作快照转成可读说明；完整原始证据仍保存在协作记录中。 */
function workHistoryDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (!detail) return '';
  const labels = { title: '名称', description: '说明', criteria: '验收条件', allowedPaths: '允许改动范围', symptom: '问题表现', cause: '原因', solution: '处理方法', verification: '验证步骤', summary: '处理摘要', tests: '实际测试', reportId: '扫描报告编号' };
  const lines = Object.entries(labels).filter(([key]) => detail[key]).map(([key, label]) => `${label}：${detail[key]}`);
  if (detail.changedFiles?.length) lines.push('改动文件：' + detail.changedFiles.join('、'));
  if (detail.expiresAt) lines.push('领取有效期至：' + time(detail.expiresAt));
  if (typeof detail.requireReport === 'boolean') lines.push(detail.requireReport ? '要求实际扫描验收' : '人工确认任务，不代表自动质量通过');
  if (detail.tags?.length) lines.push('标签：' + detail.tags.join('、'));
  return lines.join('\n');
}

/** row 为已保存记录或预填草稿；保存携带版本，避免覆盖其他人/agent 的操作。 */
async function workForm(kind, row = {}) {
  workFormKind = kind; workFormRow = row;
  const projectId = row.projectId ?? (workProject || (kind === 'knowledge' ? '' : activeProjects()[0]?.id || ''));
  modal(`${row.id ? '编辑' : '新增'}${workNames[kind]}`, `<form id="work-record-form"><div class="field"><label for="work-title">名称</label><input id="work-title" name="title" maxlength="120" required value="${e(row.title)}"></div><div class="field"><label for="work-record-project">所属项目</label><select id="work-record-project" name="projectId" ${row.id ? 'disabled' : ''}>${kind === 'knowledge' ? '<option value="">通用知识</option>' : ''}${activeProjects().map(p => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${e(p.name)}</option>`).join('')}</select></div>${kind === 'requirements' ? workField('description', '需求说明', row.description) + workField('criteria', '验收条件', row.criteria) + workField('allowedPaths', '允许改动范围与约束', row.allowedPaths, 2, 1000) : kind === 'tasks' ? `<div class="field"><label for="work-requirement">关联需求（可选）</label><select id="work-requirement" name="requirementId"><option value="">独立任务</option></select><small>列出本项目前 25 条需求；其他需求可从详情直接创建关联任务。</small></div>${workField('description', '任务说明', row.description)}${workField('criteria', '任务验收条件', row.criteria)}<label><input type="checkbox" name="requireReport" ${row.requireReport !== false ? 'checked' : ''}> 完成前要求实际扫描验收通过</label><p class="subtle">文档或研究任务可取消；人工确认仍不表示代码质量通过。</p>` : ['symptom', 'cause', 'solution', 'verification'].map((k, i) => workField(k, ['问题表现', '原因', '处理方法', '实际验证与复用步骤'][i], row[k])).join('') + `<div class="field"><label for="work-tags">标签（逗号分隔，最多 8 个）</label><input id="work-tags" name="tags" maxlength="328" value="${e(row.tags?.join('，'))}"></div>`}<div class="form-actions">${button('取消', 'close')}<button type="submit" class="button primary">保存${kind === 'knowledge' ? '草稿' : workNames[kind]}</button></div></form>`);
  if (kind === 'tasks') await workRequirementOptions(projectId, row.requirementId);
}
/** 项目改变后只提供该项目需求；保留详情入口传入的旧需求，即使不在第一页。 */
async function workRequirementOptions(projectId, selected = '') {
  const target = $('#work-requirement'); if (!target || !projectId) return;
  const result = await api('/api/work/list?' + new URLSearchParams({ kind: 'requirements', projectId }));
  if ($('#work-requirement') !== target || $('#work-record-project').value !== projectId) return;
  const rows = result.rows;
  if (selected && !rows.some(r => r.id === selected)) rows.push((await api('/api/work/detail?kind=requirements&id=' + selected)).row);
  target.innerHTML = '<option value="">独立任务</option>' + rows.map(r => `<option value="${r.id}" ${r.id === selected ? 'selected' : ''}>${e(r.title)}</option>`).join('');
}
/** 阅读完整记录、相关知识及历史，所有文本转义后显示，不执行 Markdown/HTML。 */
async function workDetail(kind, id) {
  const row = (await api(`/api/work/detail?kind=${kind}&id=${id}`)).row; workFormRow = row; workFormKind = kind;
  const fieldNames = kind === 'requirements' ? [['description', '需求说明'], ['criteria', '验收条件'], ['allowedPaths', '允许改动范围']] : kind === 'tasks' ? [['description', '任务说明'], ['criteria', '验收条件']] : [['symptom', '问题表现'], ['cause', '原因'], ['solution', '处理方法'], ['verification', '验证步骤']];
  let extra = kind === 'knowledge' ? `<p>${e(workStatuses[row.status])} · ${e(row.tags.join('、'))}</p>${row.source?.taskId ? button('查看来源任务', 'work-detail', `data-kind="tasks" data-id="${row.source.taskId}"`, 'small') : ''}` : '';
  if (kind === 'tasks') {
    const context = await api('/api/work/context?id=' + id);
    extra = `<p>${e(workStatuses[row.status])} · ${row.requireReport ? '要求实际扫描验收' : '人工确认任务，不代表自动质量通过'}${row.claim ? ' · ' + e(row.claim.actor.name) : ''}</p>${context.requirement ? `<p>关联需求：${e(context.requirement.title)} · 任务绑定 v${row.requirementVersion} / 当前 v${context.requirement.version}</p>` : ''}${row.source ? `<p>来源问题：${e(row.source.rule)} · ${e(row.source.file)}</p>` : ''}${row.submission ? `<h3>最近提交证据</h3><pre class="work-text">${e(row.submission.summary)}\n改动文件：${e(row.submission.changedFiles.join('、'))}\n实际测试：${e(row.submission.tests)}</pre>${row.submission.reportId ? button('打开提交的扫描报告', 'scan-detail', `data-id="${row.submission.reportId}"`) : ''}` : ''}<h3>相关已发布知识</h3>${context.knowledge.length ? context.knowledge.map(k => button(k.title, 'work-detail', `data-kind="knowledge" data-id="${k.id}"`, 'small')).join('') : '<p>暂未匹配到知识，可按问题关键词在知识库查找。</p>'}`;
  }
  const actions = kind === 'requirements' ? button('新增关联任务', 'work-child-task', `data-id="${id}"`, 'primary') : kind === 'knowledge' ? button(row.status === 'published' ? '撤回发布' : '审核并发布', 'work-publish', `data-id="${id}"`, 'primary') : (['ready', 'in_progress'].includes(row.status) && !activeWorkClaim(row) ? button('人工领取任务', 'work-task-action', `data-task-action="claim" data-id="${id}"`, 'primary') : '') + (row.status === 'in_progress' ? button('释放任务', 'work-task-action', `data-task-action="release" data-id="${id}"`) + (row.claim?.actor.type === 'human' ? button('提交处理证据', 'work-submit', `data-id="${id}"`, 'primary') : '') : '') + (row.status === 'review' ? button('审核通过', 'work-task-action', `data-task-action="approve" data-id="${id}"`, 'primary') + button('退回重做', 'work-task-action', `data-task-action="reject" data-id="${id}"`) : '') + (row.status === 'done' ? button('沉淀为知识草稿', 'work-task-knowledge', `data-id="${id}"`, 'primary') + button('重新打开任务', 'work-task-action', `data-task-action="reopen" data-id="${id}"`) : '') + (['ready', 'blocked'].includes(row.status) ? button(row.status === 'ready' ? '标记阻塞' : '解除阻塞', 'work-task-action', `data-task-action="${row.status === 'ready' ? 'block' : 'unblock'}" data-id="${id}"`) : '');
  const actionNames = { create: '创建记录', edit: '编辑记录', claim: '领取任务', heartbeat: '续期', release: '释放任务', submit: '提交处理证据', approve: '审核通过', reject: '退回重做', block: '标记阻塞', unblock: '解除阻塞', reopen: '重新打开任务', publish: '审核发布', withdraw: '撤回发布' };
  modal(row.title, `${fieldNames.map(([k, name]) => `<h3>${name}</h3><pre class="work-text">${e(row[k])}</pre>`).join('')}${extra}<div class="buttons">${actions}${kind !== 'tasks' || ['ready', 'blocked'].includes(row.status) ? button('编辑记录', 'work-edit', `data-kind="${kind}" data-id="${id}" ${kind === 'knowledge' && row.status === 'published' ? 'disabled' : ''}`) : ''}</div><details><summary>查看 ${row.history.length} 条处理历史</summary>${row.history.map(h => `<p>${e(time(h.at))} · ${e(h.actor.name)} · ${e(actionNames[h.action] || h.action)}</p><pre class="work-text">${e(workHistoryDetail(h.detail))}</pre>`).join('')}</details>`);
}
function activeWorkClaim(row) { return row.claim && (row.claim.actor.type === 'human' || Date.parse(row.claim.expiresAt) > Date.now()); }

/** 连接页不保留认证缓存；只有新授权响应显示一次凭据。 */
function agentsPage() {
  return heading('本地 agent 协作', '授权指定项目，让本机 agent 领取任务、续期、提交证据和提议知识。成果仍由你审核。', button('授权本地 agent', 'work-agent-new', '', 'primary')) + panel('本地连接与操作', '<div class="panel-body"><p>在授权窗口选择项目并取得凭据，将它放入 agent 的 HEALTH_AGENT_TOKEN 环境变量。使用 scripts/local-agent.js 或专用本机接口参与。</p><p>领取有效期 30 分钟，可通过心跳续期；过期可重新领取。凭据只在当前平台进程中有效，重启需重新授权。</p><p class="notice">这用于可信本机参与者协作，不是隔离恶意进程的沙箱。平台不自动启动 agent，也不执行任务文字中的命令。</p>' + button('查看与撤销连接', 'work-agents') + '</div>');
}
document.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]'); if (!control?.dataset.action.startsWith('work-')) return;
  const a = control.dataset.action, id = control.dataset.id, kind = control.dataset.kind; control.disabled = true;
  try {
    if (a === 'work-kind') { workKind = kind; workStatus = ''; workOffset = 0; workReload(); }
    if (a === 'work-refresh') workReload();
    if (a === 'work-search') { workSearch = $('#work-search').value; workOffset = 0; workReload(); }
    if (a === 'work-page') { workOffset = Number(control.dataset.offset); workReload(); }
    if (a === 'work-new') await workForm(kind);
    if (a === 'work-detail') await workDetail(kind, id);
    if (a === 'work-edit') await workForm(kind, (await api(`/api/work/detail?kind=${kind}&id=${id}`)).row);
    if (a === 'work-child-task') { const r = (await api('/api/work/detail?kind=requirements&id=' + id)).row; await workForm('tasks', { projectId: r.projectId, requirementId: id, criteria: r.criteria }); }
    if (a === 'work-task-knowledge') { const t = (await api('/api/work/detail?kind=tasks&id=' + id)).row; await workForm('knowledge', { projectId: t.projectId, title: '经验：' + t.title, solution: t.submission.summary, verification: t.submission.tests, source: { taskId: id } }); }
    if (a === 'work-from-issue') { const r = await api('/api/report?id=' + id); if (!r.projectId) throw Error('仅支持本地项目扫描问题'); const created = await api('/api/work/from-issue', { projectId: r.projectId, source: { reportId: id, trackingId: control.dataset.tracking } }); workReload(); await workDetail('tasks', created.row.id); }
    if (a === 'work-task-action' || a === 'work-publish') {
      const r = (await api(`/api/work/detail?kind=${a === 'work-publish' ? 'knowledge' : 'tasks'}&id=${id}`)).row;
      if (control.dataset.taskAction === 'claim') { await api('/api/work/task', { id, expectedVersion: r.version, action: 'claim' }); workReload(); await workDetail('tasks', id); }
      else { workFormRow = r; modal(a === 'work-publish' ? '确认知识审核' : '记录任务操作依据', `<form id="work-action-form"><input type="hidden" name="action" value="${e(a === 'work-publish' ? 'publish' : control.dataset.taskAction)}">${workField('reason', '审核或操作理由（至少 8 字）', '', 3, 1000)}<div class="form-actions"><button type="submit" class="button primary">确认保存</button></div></form>`); }
    }
    if (a === 'work-submit') { workFormRow = (await api('/api/work/detail?kind=tasks&id=' + id)).row; modal('提交实际处理证据', `<form id="work-submit-form">${workField('summary', '处理摘要（至少 8 字）')}${workField('tests', '实际执行的测试与结果（至少 8 字）')}<div class="field"><label for="work-changedFiles">改动文件（每行一个相对路径）</label><textarea id="work-changedFiles" name="changedFiles" rows="2" maxlength="12000"></textarea></div><div class="field"><label for="work-reportId">扫描报告编号</label><input id="work-reportId" name="reportId" ${workFormRow.requireReport ? 'required' : ''} placeholder="扫描详情中的 UUID"></div><div class="form-actions"><button type="submit" class="button primary">提交人工审核</button></div></form>`); }
    if (a === 'work-agent-new') modal('授权本地 agent', `<form id="work-agent-form"><div class="field"><label for="work-agent-name">agent 名称</label><input id="work-agent-name" name="name" maxlength="80" required></div><p>允许参与的项目：</p>${activeProjects().map(p => `<label class="check-row"><span>${e(p.name)}</span><input type="checkbox" name="projects" value="${p.id}"></label>`).join('')}<div class="form-actions"><button type="submit" class="button primary">建立本地连接</button></div></form>`);
    if (a === 'work-agents') { const result = await api('/api/work/agents'); modal('当前本地 agent 连接', result.agents.length ? result.agents.map(a => `<div class="check-row"><span>${e(a.name)}<small>${a.projectIds.map(id => e(state.projects.find(p => p.id === id)?.name)).join('、')}</small></span>${button('撤销连接', 'work-agent-revoke', `data-id="${a.id}"`, 'small')}</div>`).join('') : '<p>当前没有授权连接。</p>'); }
    if (a === 'work-agent-revoke') { await api('/api/work/agents/revoke', { id }); $('#dialog').close(); toast('连接已撤销；未完成任务可由你释放。'); }
  } catch (error) { toast(error.message); const target = $('#dialog-content'); if ($('#dialog').open) { target.querySelector('.work-error')?.remove(); const p = document.createElement('p'); p.className = 'notice red work-error'; p.setAttribute('role', 'alert'); p.textContent = error.message; target.append(p); } }
  finally { control.disabled = false; }
});
document.addEventListener('change', async event => {
  if (event.target.id === 'work-project' || event.target.id === 'work-status') { workProject = $('#work-project').value; workStatus = $('#work-status').value; workOffset = 0; workReload(); }
  if (event.target.id === 'work-record-project' && workFormKind === 'tasks') { try { await workRequirementOptions(event.target.value); } catch (error) { toast(error.message); } }
});
document.addEventListener('submit', async event => {
  const form = event.target, formId = form.getAttribute('id'); if (!formId?.startsWith('work-')) return;
  event.preventDefault(); const data = new FormData(form), submit = form.querySelector('[type="submit"]'); submit.disabled = true; form.querySelector('.form-error')?.remove();
  try {
    if (formId === 'work-record-form') {
      const record = { ...Object.fromEntries(data), ...(workFormRow.id ? { id: workFormRow.id, expectedVersion: workFormRow.version, projectId: workFormRow.projectId } : {}), source: workFormRow.source || null };
      if (workFormKind === 'tasks') record.requireReport = data.has('requireReport');
      if (workFormKind === 'knowledge') record.tags = String(record.tags || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
      const result = await api('/api/work/save', { kind: workFormKind, record }); workReload(); await workDetail(workFormKind, result.row.id);
    }
    if (formId === 'work-action-form') {
      const r = workFormRow, action = data.get('action');
      await api(action === 'publish' ? '/api/work/knowledge/publish' : '/api/work/task', { id: r.id, expectedVersion: r.version, action, publish: r.status !== 'published', reason: data.get('reason') }); workReload(); await workDetail(action === 'publish' ? 'knowledge' : 'tasks', r.id);
    }
    if (formId === 'work-submit-form') { const r = workFormRow; await api('/api/work/task', { id: r.id, expectedVersion: r.version, action: 'submit', submission: { summary: data.get('summary'), tests: data.get('tests'), changedFiles: data.get('changedFiles').split(/\r?\n/).map(s => s.trim()).filter(Boolean), reportId: data.get('reportId') } }); workReload(); await workDetail('tasks', r.id); }
    if (formId === 'work-agent-form') { const result = await api('/api/work/agents/register', { name: data.get('name'), projectIds: data.getAll('projects') }); modal('本地 agent 连接已建立', `<p>${e(result.notice)}</p><p>平台地址：${e(location.origin)}</p><div class="field"><label for="work-agent-secret">本次连接凭据</label><input id="work-agent-secret" readonly value="${e(result.token)}"></div><p>设置 HEALTH_PLATFORM_URL 为本机平台地址，HEALTH_AGENT_TOKEN 为上面的凭据，然后让 agent 运行 scripts/local-agent.js list，或调用专用接口。</p><p class="notice">请勿把凭据提交到 GitHub、粘贴到任务或知识正文。</p>`); }
    toast('协作记录已保存。');
  } catch (error) { const p = document.createElement('p'); p.className = 'notice red form-error'; p.setAttribute('role', 'alert'); p.textContent = error.message; form.append(p); }
  finally { submit.disabled = false; }
});
