const $ = selector => document.querySelector(selector);
const labels = { overview: '总览', projects: '项目管理', issues: '问题中心', history: '扫描历史', quality: '代码审查与证据', pipeline: '验收流水线', work: '需求与任务', knowledge: '问题知识库', agents: '本地 agent', gate: '质量门禁', settings: '环境设置', archives: '归档中心' };
const severityNames = { HIGH: '高风险', BLOCKER: '阻断', CRITICAL: '严重', MEDIUM: '中风险', MAJOR: '主要', LOW: '低风险', MINOR: '次要', INFO: '提示' };
let state, page = 'overview', environmentData, selectedProject = '', severity = '', search = '', polling, toastTimer;
let pollingBusy = false;
let viewedScanId = null;
let repairReturn = null;
let viewedPipelineId = null, pipelineProjectId = '', pipelineEditingCases = [], pipelineEditingCategories = {};
const pipelineResultNames = { pending: '未验证', passed: '通过', failed: '失败', notApplicable: '不适用（需理由）' };
let reviewStatus = '';
const reviewNames = { open: '待审查', confirmed: '已确认', fixing: '修复中', dismissed: '已排除（有理由）' };
let githubPullData, githubRepository = '';
const listOffsets = { issues: 0, history: 0, quality: 0, archives: 0 };
const listData = {}, listRequests = {};
let historyStatus = '', historyMode = '';
let requestSequence = 0;
let archivedProjectOffset = 0;
function issueCount(scan) { return scan?.issueCount ?? scan?.issues?.length ?? 0; }
/** Retired projects remain registered for historical evidence but do not count as active dashboard projects. */
function activeProjects() { return state.projects.filter(p => !p.archivedAt); }

/** Encode only the active view's filters; the server counts matches and returns one bounded page. */
function listQuery(key) {
  const query = new URLSearchParams({ offset: listOffsets[key], limit: 25 });
  if (key !== 'quality' && selectedProject) query.set('projectId', selectedProject);
  if (key === 'issues') { if (severity) query.set('severity', severity); if (search) query.set('search', search); if (reviewStatus) query.set('reviewStatus', reviewStatus); }
  else { query.set('kind', key === 'quality' ? 'quality' : key === 'archives' ? 'archive' : 'scan'); if (key === 'history') { if (historyStatus) query.set('status', historyStatus); if (historyMode) query.set('mode', historyMode); } }
  return `${key === 'issues' ? '/api/issues' : '/api/history'}?${query}`;
}
function listSignature(key) { return listQuery(key) + '|' + state.revision; }
/** Start missing page requests once, retaining an explicit loading state instead of claiming zero matches. */
function currentList(key) {
  const signature = listSignature(key);
  if (listData[key]?.signature === signature) return listData[key];
  if (listRequests[key]?.signature !== signature) void loadList(key, signature);
  return { rows: [], total: null, loading: true };
}
/** Cancel superseded searches and check both query and revision before displaying asynchronous results. */
async function loadList(key, signature) {
  listRequests[key]?.controller.abort();
  const controller = new AbortController(), sequence = ++requestSequence, url = listQuery(key);
  listRequests[key] = { controller, signature, sequence };
  try {
    const result = await api(url, undefined, controller.signal);
    if (controller.signal.aborted || listRequests[key]?.sequence !== sequence || url !== listQuery(key)) return;
    if (result.revision !== state.revision) await refresh(false);
    if (controller.signal.aborted || listRequests[key]?.sequence !== sequence || url !== listQuery(key)) return;
    if (result.revision !== state.revision) { delete listRequests[key]; if (page === key) render(); return; }
    listOffsets[key] = result.offset;
    listData[key] = { ...result, signature: listSignature(key) };
  } catch (error) {
    if (controller.signal.aborted || listRequests[key]?.sequence !== sequence) return;
    if (error.status === 409) { delete listRequests[key]; await refresh(false); if (page === key) render(); return; }
    listData[key] = { rows: [], total: null, error: error.message, signature };
  }
  if (page === key) {
    // Only refresh quality records: an arriving list must not erase a repository or Token being entered.
    if (key === 'quality' && $('#quality-records')) $('#quality-records').outerHTML = qualityRecords(listData[key]);
    else {
      const input = $('#issue-search'), focus = document.activeElement === input, position = input?.selectionStart;
      render(); if (focus) { $('#issue-search')?.focus(); $('#issue-search')?.setSelectionRange(position, position); }
    }
  }
}
function listPlaceholder(list, title, description, action = '') {
  if (list.loading) return '<div class="panel-body subtle">正在按页读取检查记录…</div>';
  if (list.error) return `<div class="panel-body"><p class="notice red" role="alert">${e(list.error)}</p>${button('重新读取', 'retry-list', `data-list="${page}"`)}</div>`;
  if (title === '还没有扫描记录' && state.stats.scans) { title = '当前筛选没有扫描记录'; description = '调整项目、执行状态或检查方式后再试。'; }
  return empty(title, description, action);
}
function pagination(total, key) {
  if (total <= 25) return '';
  const offset = listOffsets[key] || 0;
  return `<div class="panel-foot pagination"><span>第 ${Math.floor(offset / 25) + 1} / ${Math.ceil(total / 25)} 页 · 共 ${total} 条</span><div class="buttons">${button('上一页', 'list-page', `data-list="${key}" data-offset="${offset - 25}" ${offset === 0 ? 'disabled' : ''}`, 'small')}${button('下一页', 'list-page', `data-list="${key}" data-offset="${offset + 25}" ${offset + 25 >= total ? 'disabled' : ''}`, 'small')}</div></div>`;
}

/** Escape every user-controlled value before using HTML templates. */
function e(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
/** line 来自分析结果；未知位置明确提示，不能显示虚假的第 1 行。 */
function issueLine(line) { return Number.isSafeInteger(line) && line > 0 ? String(line) : '行号未提供'; }
function time(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未扫描'; }
function num(value, suffix = '') { return value == null ? '—' : `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}${suffix}`; }
function metric(value) { return value == null ? '未检测' : num(value, '%'); }
function latest(projectId) { return state.scans.find(s => s.projectId === projectId && s.status === 'completed' && s.scope !== 'changed'); }
function currentScans() { return activeProjects().map(p => latest(p.id)).filter(Boolean); }

function badge(status) {
  const text = { PASSED: '通过', FAILED: '未通过', UNKNOWN: '待评估', completed: '已完成', running: '运行中', failed: '执行失败' };
  return `<span class="badge ${['PASSED', 'completed'].includes(status) ? 'good' : ['FAILED', 'failed'].includes(status) ? 'bad' : 'warning'}">${text[status] || '尚未检测'}</span>`;
}
/** Render an action button without implicit form submission; actual save/start controls explicitly use type="submit". */
function button(text, action, extra = '', type = '') { return `<button type="button" class="button ${type}" data-action="${action}" ${extra}>${text}</button>`; }
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }

/** Shared API wrapper surfaces validation errors and never hides failed actions. */
async function api(url, data, signal) {
  try {
  const response = await fetch(url, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal } : { signal });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || '请求失败'); error.status = response.status; throw error; }
  return result;
  } catch (error) {
    // A failed detail read must release its slot so later background refreshes can retry.
    if (signal && signal === detailReadController?.signal) cancelDetailRead();
    throw error;
  }
}
async function refresh(renderPage = true) {
  state = await api('/api/state');
  if (renderPage) render();
  else if (page === 'quality' && $('#quality-records') && !$('#dialog').open) $('#quality-records').outerHTML = qualityRecords(currentList('quality'));
  ensurePolling();
}
function ensurePolling() {
  if (state.active && !polling) polling = setInterval(async () => {
    // 隐藏页面不读取详情；上次请求未结束时不叠加轮询和临时报告对象。
    if (document.hidden || pollingBusy) return;
    pollingBusy = true;
    try {
      await refresh(!['settings', 'quality', 'work', 'knowledge'].includes(page) && !$('#dialog').open);
      if (viewedScanId && $('#dialog').open) await scanDetail(viewedScanId, true);
      if (viewedPipelineId && $('#dialog').open) await pipelineReportModal(viewedPipelineId, !state.active, true);
      if (!state.active) { clearInterval(polling); polling = null; toast('扫描已结束，请查看扫描历史。'); }
    } catch (error) { if (error.name !== 'AbortError') toast(error.message); }
    finally { pollingBusy = false; }
  }, 1800);
}
function heading(title, subtitle, actions = '') { return `<div class="page-heading"><div><div class="eyebrow">LOCAL CODE HEALTH CENTER</div><h1>${title}</h1><p class="subtle">${subtitle}</p></div><div class="buttons">${actions}</div></div>`; }
function empty(title, description, action = '') { return `<div class="empty"><div class="empty-icon">◇</div><h3>${title}</h3><p>${description}</p>${action}</div>`; }
function panel(title, body, right = '', foot = '') { return `<section class="panel"><div class="panel-head"><h2>${title}</h2>${right}</div>${body}${foot ? `<div class="panel-foot">${foot}</div>` : ''}</section>`; }
function stat(label, value, note, symbol = '◇') { return `<article class="stat"><div class="stat-label">${label}<span class="stat-symbol">${symbol}</span></div><div class="stat-value">${value}</div><div class="stat-note">${note}</div></article>`; }
function projectOptions(all = true) { return `${all ? '<option value="">所有项目</option>' : ''}${state.projects.map(p => `<option value="${p.id}" ${selectedProject === p.id ? 'selected' : ''}>${e(p.name)}${p.archivedAt ? "（已归档）" : ""}</option>`).join('')}`; }

/** Draw only historical measurements. Empty histories contain no synthetic chart points. */
function trend(scans) {
  const rows = scans.filter(s => s.status === 'completed' && s.scope !== 'changed').slice(0, 12).reverse();
  if (!rows.length) return `<div class="empty-chart"><b>每一次检查，都让变化有迹可循</b><span class="subtle">${state.projects.length > 1 && state.scans.length ? '请选择一个项目，查看它的真实历史趋势。' : '完成首次扫描后，这里会显示真实的问题数量趋势。'}</span></div>`;
  const max = Math.max(...rows.map(r => issueCount(r)), 1);
  const point = (r, i) => [45 + i * 535 / Math.max(rows.length - 1, 1), 150 - issueCount(r) / max * 110];
  const points = rows.map(point);
  return `<svg class="chart" viewBox="0 0 620 190" role="img" aria-label="历史问题数量趋势">${[0, .5, 1].map(v => `<line class="gridline" x1="45" x2="590" y1="${150 - v * 110}" y2="${150 - v * 110}"/><text x="8" y="${154 - v * 110}">${Math.round(max * v)}</text>`).join('')}<polyline class="trend" points="${points.map(p => p.join(',')).join(' ')}"/>${points.map((p, i) => `<circle class="point" cx="${p[0]}" cy="${p[1]}" r="4"><title>${e(time(rows[i].startedAt))}：${issueCount(rows[i])} 条</title></circle>`).join('')}<text x="45" y="180">${e(new Date(rows[0].startedAt).toLocaleDateString('zh-CN'))}</text><text x="590" y="180" text-anchor="end">${e(new Date(rows.at(-1).startedAt).toLocaleDateString('zh-CN'))}</text></svg>`;
}
function projectTable() {
  if (!activeProjects().length) return empty('连接你的第一个项目', '添加本机 Maven 项目，从一次真实的代码检查开始。<br>还没准备好？也可以用内置示例验证本地检查。', button('＋ 添加项目', 'add-project', '', 'primary') + ' ' + button('扫描内置示例', 'fixture'));
  return `<div class="table-wrap"><table><thead><tr><th>项目</th><th>最近整体结果</th><th>问题数量</th><th>覆盖率</th><th>最近扫描</th><th>操作</th></tr></thead><tbody>${activeProjects().map(p => {
    const scan = latest(p.id);
    return `<tr><td><div class="project-name"><span class="project-avatar">${e(p.name[0].toUpperCase())}</span><div>${e(p.name)}<small>${e(p.key)} · Java 8 / Maven</small></div></div></td><td>${badge(scan?.gate?.status)}</td><td>${scan ? issueCount(scan) : '—'}</td><td>${metric(scan?.metrics?.coverage)}</td><td>${e(time(scan?.startedAt))}<small>最新尝试：${e(time(state.scans.find(s => s.projectId === p.id)?.startedAt))} · ${e(({ running: '正在检查', completed: '已完成', failed: '失败 / 未完成' })[state.scans.find(s => s.projectId === p.id)?.status] || '未检查')}</small>${scan?.mode === 'local' ? '<small class="badge">本地规则</small>' : ''}</td><td>${button('现在可以验收吗？', 'readiness', `data-id="${p.id}"`, 'small')}${button('开始检查 ↗', 'scan-project', `data-id="${p.id}"`, 'small')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function gateSummary(scan) {
  if (!scan) return `<div class="panel-body"><div class="gate-box"><div class="gate-icon">◇</div><div><strong>等待首次体检</strong><small>先建立基线，再持续改进。</small></div></div><div class="check-row"><span>新代码覆盖率</span><span>≥ ${state.settings.gate.coverage}%</span></div><div class="check-row"><span>新代码重复率</span><span>≤ ${state.settings.gate.duplication}%</span></div><div class="check-row"><span>新增严重问题 / 漏洞</span><span>0</span></div></div>`;
  return `<div class="panel-body"><div class="gate-box"><div class="gate-icon ${scan.gate?.status === 'FAILED' ? 'failed' : ''}">${scan.gate?.status === 'PASSED' ? '✓' : scan.gate?.status === 'FAILED' ? '!' : '◇'}</div><div><strong>${scan.gate?.status === 'PASSED' ? '检查通过' : scan.gate?.status === 'FAILED' ? '需要关注' : '待评估'}</strong><small>${scan.mode === 'local' ? '本地规则门禁 · 未执行完整体检' : '新代码门禁 · 当前扫描结果'}</small></div></div>${(scan.gate?.checks || []).map(c => `<div class="check-row"><span>${e(c.name)}</span><span class="${c.passed === true ? 'green' : c.passed === false ? 'red' : ''}">${c.value == null ? '未提供数据' : e(c.value)} <small>${e(c.target)}</small></span></div>`).join('')}</div>`;
}
function overview() {
  const scans = currentScans();
  const full = scans.filter(s => s.mode === 'full');
  const covers = full.map(s => s.metrics.coverage).filter(v => v != null);
  const latestScan = currentScans().sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return heading('让每一次改动，都更有把握。', '构建、测试、代码质量，一处掌握。让问题被发现，让改进看得见。', button('＋ 添加项目', 'add-project') + button('▷ 开始体检', 'scan', '', 'primary')) +
    `<div class="status-strip ${state.active ? '' : 'neutral'}"><span class="tiny-dot"></span><span>${state.active ? '扫描正在进行，你可以在扫描历史中查看进度。' : '本地规则检查已就绪。完整体检需配置 JDK、Maven 和 SonarQube。'}</span><a href="#${state.active ? 'history' : 'settings'}">${state.active ? '查看扫描' : '检查环境'} →</a></div>` +
    `<div class="stat-grid">${stat('纳入管理的项目', activeProjects().length, '本机 Maven 项目', '▱')}${stat('待处理问题', state.stats.issues, `${state.stats.highRisk} 条高风险问题`, '⊙')}${stat('平均测试覆盖率', covers.length ? num(covers.reduce((a, b) => a + b, 0) / covers.length) + '<small>%</small>' : '—', covers.length ? '仅统计完整扫描的真实报告' : '完整体检后提供，不估算覆盖率', '◴')}${stat('通过检查的项目', `${scans.filter(s => s.gate?.status === 'PASSED').length}<small>/ ${activeProjects().length}</small>`, '最近完成的整体检查；当前验收请核对最新尝试', '◇')}</div>` +
    `<div class="grid-two">${panel('代码质量趋势', `<div class="panel-body">${trend(selectedProject ? state.scans.filter(s => s.projectId === selectedProject) : activeProjects().length === 1 ? state.scans : [])}<div class="chart-caption"><span>未解决问题数量 · 最近 12 次扫描</span><span>持续改进，从建立基线开始</span></div></div>`, `<select id="trend-project" aria-label="趋势项目"><option value="">选择项目</option>${projectOptions(false)}</select>`)}${panel('质量门禁', gateSummary(selectedProject ? latest(selectedProject) : latestScan), '<a class="text-link" href="#gate">管理门禁 ↗</a>')}</div>` +
    panel('我的项目', projectTable(), `<span class="subtle">${activeProjects().length} 个本地项目</span>`, '<span>源码留在本机，检查记录持久保存。</span><a class="text-link" href="#projects">查看全部项目 →</a>') +
    workflowGuide();
}
function projectsPage() {
  return heading('项目管理', '连接本机 Maven 项目，源码无需复制或上传。', button('扫描内置示例', 'fixture') + button('＋ 添加项目', 'add-project', '', 'primary')) +
    panel('本地项目', projectTable()) + activeProjects().map(p => `<section class="panel"><div class="panel-body"><h3>${e(p.name)}</h3><p class="subtle">${e(p.path)}</p><p class="subtle">基线：${p.baselineId ? e(time(state.scans.find(s => s.id === p.baselineId)?.startedAt)) : '尚未设置；在扫描详情中选择一次已完成的检查。'}</p><div class="buttons">${button('编辑项目', 'edit-project', `data-id="${p.id}"`, 'small')}${button('质量约定', 'project-policy', `data-id="${p.id}"`, 'small')}${button('验收流水线', 'pipeline-open', `data-id="${p.id}"`, 'small')}${button('查看问题', 'project-issues', `data-id="${p.id}"`, 'small')}${button('查看历史', 'project-history', `data-id="${p.id}"`, 'small')}${button('归档项目', 'archive-project', `data-id="${p.id}"`, 'small')}<a class="button small" href="${e(state.settings.sonarUrl)}/dashboard?id=${encodeURIComponent(p.key)}" target="_blank" rel="noreferrer">SonarQube ↗</a></div></div></section>`).join('');
}
function issuesPage() {
  const list = currentList('issues'), rows = list.rows;
  return heading('问题中心', '展示整个项目的问题；本次 Git 改动结果请在扫描详情中查看。', button('修复任务清单', 'tasks-latest') + button('导出问题', 'export-issues')) +
    `<section class="panel"><div class="filter-bar"><input id="issue-search" placeholder="搜索问题、文件或规则…" aria-label="搜索问题" value="${e(search)}"><select id="filter-project" aria-label="筛选项目">${projectOptions()}</select><select id="filter-severity" aria-label="筛选风险"><option value="">所有风险等级</option>${Object.entries(severityNames).map(([id, label]) => `<option value="${id}" ${severity === id ? 'selected' : ''}>${label}</option>`).join('')}</select><select id="filter-review" aria-label="筛选审查状态"><option value="">所有审查状态</option>${Object.entries(reviewNames).map(([id, label]) => `<option value="${id}" ${reviewStatus === id ? 'selected' : ''}>${e(label)}</option>`).join('')}</select></div><div class="panel-foot"><span>匹配 ${list.total ?? '…'} 条 · 各项目最近一次已完成的扫描</span><span>本地规则为启发式提示，请结合代码确认</span></div>${rows.length ? rows.map(i => `<article class="issue-row"><span class="issue-marker ${e(i.severity)}"></span><div class="issue-main"><div class="issue-title">${e(i.message)}</div><div class="issue-meta"><span>${e(state.projects.find(p => p.id === i.projectId)?.name)}</span><span>${e(i.file)}:${issueLine(i.line)}</span><span>${e(i.rule)}</span><span>${i.type === 'LOCAL' ? '本地规则' : 'SonarQube'}</span></div>${i.excerpt ? `<code>${e(i.excerpt)}</code>` : ''}${issueReviewControls(i, i.scanId)}</div><span class="badge ${['HIGH', 'CRITICAL', 'BLOCKER'].includes(i.severity) ? 'bad' : 'warning'}">${e(severityNames[i.severity] || i.severity)}</span>${button('查看代码', 'source', `data-project="${i.projectId}" data-file="${e(i.file)}" data-line="${i.line}"`, 'small')}</article>`).join('') : listPlaceholder(list, '这里暂时没有问题', state.scans.length ? '当前筛选条件下没有发现问题。可以调整筛选，或再次检查代码。' : '完成一次扫描后，在这里查看真实的问题、位置与修复建议。', button('开始体检', 'scan', '', 'primary'))}${pagination(list.total, 'issues')}</section>`;
}
function historyPage() {
  const list = currentList('history'), scans = list.rows;
  return heading('扫描历史', '保留每次检查的结果、执行日志和质量变化。', button('开始体检', 'scan', '', 'primary')) +
    (state.scans.find(s => s.status === 'running') ? panel('正在检查', `<div class="panel-body">${progress(state.scans.find(s => s.status === 'running'))}</div>`) : '') +
    `<section class="panel"><div class="filter-bar"><select id="filter-project" aria-label="历史项目">${projectOptions()}</select><select id="history-status" aria-label="历史状态"><option value="">所有执行状态</option>${[["completed", "已完成"], ["failed", "执行失败"], ["running", "运行中"]].map(([id, label]) => `<option value="${id}" ${historyStatus === id ? "selected" : ""}>${label}</option>`).join("")}</select><select id="history-mode" aria-label="历史检查方式"><option value="">所有检查方式</option>${[["local", "整个项目 · 本地规则"], ["changed", "本次 Git 改动"], ["full", "完整体检"]].map(([id, label]) => `<option value="${id}" ${historyMode === id ? "selected" : ""}>${label}</option>`).join("")}</select><span class="subtle">${list.total ?? '…'} 次检查</span></div>${scans.length ? `<div class="table-wrap"><table><thead><tr><th>项目 / 时间</th><th>检查方式</th><th>执行状态</th><th>问题</th><th>质量门禁</th><th>操作</th></tr></thead><tbody>${scans.map(s => `<tr><td><div class="project-name"><div>${e(state.projects.find(p => p.id === s.projectId)?.name)}<small>${e(time(s.startedAt))}</small></div></div></td><td>${s.mode === 'full' ? '完整体检' : s.scope === 'changed' ? 'Git 改动' : '本地规则'}</td><td>${badge(s.status)}</td><td>${s.status === 'completed' ? issueCount(s) : '—'}</td><td>${badge(s.gate?.status)}</td><td>${button('查看详情', 'scan-detail', `data-id="${s.id}"`, 'small')}${archiveControl(s)}</td></tr>`).join('')}</tbody></table></div>` : listPlaceholder(list, '还没有扫描记录', '从第一次检查开始，建立可追踪的质量基线。')}<div class="panel-foot">${button('归档已选旧报告', 'archive-selected', '', 'small')}<a href="#archives">查看归档与恢复 →</a></div>${pagination(list.total, 'history')}</section>`;
}
function gatePage() {
  return heading('质量门禁', '历史代码逐步治理，新代码持续守护。以下规则用于平台的新代码门禁。') +
    `<div class="grid-two">${panel('新代码门禁 · Local Gate', `<div class="panel-body"><form id="gate-form"><div class="notice">仅完整体检使用以下阈值。本地规则扫描单独判断高风险问题是否为零。缺少新代码数据时显示“待评估”，不会自动通过。SonarQube 自身门禁会在扫描详情中独立展示。</div><div class="form-grid"><div class="field"><label for="coverage">新代码覆盖率 ≥</label><input id="coverage" name="coverage" type="number" min="0" max="100" step="0.1" value="${state.settings.gate.coverage}" required><small>建议从 60% 逐步提高到 80%。</small></div><div class="field"><label for="duplication">新代码重复率 ≤</label><input id="duplication" name="duplication" type="number" min="0" max="100" step="0.1" value="${state.settings.gate.duplication}" required><small>建议从 5% 逐步降到 3%。</small></div></div><div class="check-row"><span>新增 Blocker / Critical 问题</span><span class="green">必须为 0</span></div><div class="check-row"><span>新增 Vulnerability 安全漏洞</span><span class="green">必须为 0</span></div><div class="form-actions"><button class="button primary" type="submit">保存门禁</button></div></form></div>`)}${panel('循序渐进的治理', `<div class="panel-body"><div class="info-tile"><div class="number">STEP 01</div><h3>建立历史基线</h3><p>完成首轮扫描，在扫描详情中设为基线。平台基线用于问题增减比较；SonarQube 的 New Code 定义在它的项目设置中配置。</p></div><br><div class="info-tile"><div class="number">STEP 02</div><h3>守住新增代码</h3><p>优先处理新增严重问题与安全漏洞，逐步补齐测试。安全热点需要在 SonarQube 中人工审查。</p></div><br><div class="info-tile"><div class="number">STEP 03</div><h3>逐步提高标准</h3><p>测试成熟后再提高门禁要求。修改阈值只影响之后的扫描，历史记录保留当时的规则。</p></div></div>`)}</div>` +
    panel('项目质量约定', `<div class="panel-body"><p class="subtle">按项目定义任务约定、完整体检、测试数量及风险要求。旧报告保留旧要求。</p>${activeProjects().map(p => `<div class="check-row"><span>${e(p.name)}<small>${p.policy ? '已有项目约定 · ' + e(time(p.policy.updatedAt)) : '使用默认要求'}</small></span>${button('质量约定', 'project-policy', `data-id="${p.id}"`, 'small')}${button('验收流水线', 'pipeline-open', `data-id="${p.id}"`, 'small')}</div>`).join('') || '先添加项目后即可配置。'}</div>`) +
    panel('全局扫描规则', `<div class="panel-body"><form id="rules-form">${state.rules.map(r => `<div class="rule"><input type="checkbox" name="rules" value="${r.id}" id="rule-${r.id}" ${state.settings.enabledRules.includes(r.id) ? 'checked' : ''}><div><h3><label for="rule-${r.id}">${e(r.name)}</label></h3><p>${e(r.description)}</p></div><span class="badge">${e(severityNames[r.severity])}</span></div>`).join('')}<div class="form-actions"><button class="button primary" type="submit">保存规则</button></div></form></div>`);
}

/** Edit requirements for one registered project; future scans freeze these controls and effective thresholds. */
function projectPolicyModal(id) {
  const item = state.projects.find(p => p.id === id), p = item.policy || { requireBrief: false, requireFull: false, minTests: 0, blockMedium: false, gate: null }, gate = p.gate || state.settings.gate;
  modal('项目质量约定 · ' + e(item.name), `<p class="subtle">约定只影响后续扫描；旧报告保留原要求。高风险问题始终阻断，无论检查方式。填写人工验收不能解除自动阻断。</p><form id="policy-form"><input name="projectId" type="hidden" value="${id}">${[['requireBrief', '必须绑定完整 AI 任务约定'], ['requireFull', '必须完成构建与 Sonar 完整体检'], ['blockMedium', '中风险问题也必须为零'], ['overrideGate', '使用项目自己的覆盖率与重复率阈值']].map(([key, title]) => `<div class="field"><label><input name="${key}" type="checkbox" ${key === 'overrideGate' ? p.gate ? 'checked' : '' : p[key] ? 'checked' : ''}> ${title}</label></div>`).join('')}<div class="field"><label for="policy-tests">最低实际执行测试数</label><input id="policy-tests" name="minTests" type="number" min="0" max="1000000" step="1" value="${p.minTests}" required><small>0 表示不设最低数量。启用后读取本次 clean 构建的 Surefire / Failsafe 报告，跳过的测试不计入；本地规则扫描没有这项数据。</small></div><div class="form-grid"><div class="field"><label for="policy-coverage">项目新代码覆盖率 ≥</label><input id="policy-coverage" name="coverage" type="number" min="0" max="100" step="0.1" value="${gate.coverage}" required></div><div class="field"><label for="policy-duplication">项目新代码重复率 ≤</label><input id="policy-duplication" name="duplication" type="number" min="0" max="100" step="0.1" value="${gate.duplication}" required></div></div><div class="notice">覆盖率和重复率来自完整体检；本地规则无法代替实际测试。GitHub PR 检查不自动关联本机项目约定。最低测试数量不证明业务场景已覆盖，仍需人工检查验收证据。</div><div class="form-actions">${button('填写严格建议', 'policy-strict')}<button class="button primary" type="submit">保存项目约定</button></div></form>`);
}

/** Present automated checks and build-report counts exactly as captured for this historical scan. */
function gateEvidence(scan) {
  const checks = scan.gate?.checks || [], tests = scan.buildTests;
  return `<section class="panel"><div class="panel-body"><h3>本次门禁与项目约定</h3>${scan.policy ? `<p class="subtle">约定保存于 ${e(time(scan.policy.updatedAt))}，只适用于本次报告。</p>` : '<p class="subtle">本次未设置项目专属约定，使用默认要求。</p>'}${checks.map(c => `<div class="check-row"><span>${e(c.name)}<small>要求 ${e(c.target)}</small></span><span class="${c.passed === true ? 'green' : c.passed === false ? 'red' : ''}">${c.value == null ? '缺少数据' : e(c.value)}</span></div>`).join('')}${tests ? tests.available ? `<p>构建报告：执行 ${tests.executed} · 跳过 ${tests.skipped} · 失败 ${tests.failures} · 错误 ${tests.errors}</p><details><summary>查看测试报告路径</summary><p class="subtle">${tests.reports.map(e).join('<br>')}</p></details>` : `<p class="subtle">${e(tests.reason)}</p>` : '<p class="subtle">本次未记录构建测试数量。</p>'}</div></section>`;
}
function settingsPage() { return setupPage(); }
function render() {
  let next = location.hash.slice(1) || 'overview'; if (!labels[next]) next = 'overview';
  if (next !== page) releaseViewMemory(next);
  page = next;
  $('#breadcrumb').textContent = labels[page];
  $('#issue-count').textContent = state.stats.issues;
  document.querySelectorAll('[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page === page));
  $('#content').innerHTML = ({ overview, projects: projectsPage, issues: issuesPage, history: historyPage, quality: qualityPage, pipeline: pipelinePage, work: workPage, knowledge: workPage, agents: agentsPage, gate: gatePage, settings: settingsPage, archives: archivesPage })[page]();
}

/** 方案页面只读取项目与运行摘要；完整场景和历史证据在打开报告时按需获取。 */
function pipelinePage() {
  const projects = activeProjects();
  if (!projects.some(p => p.id === pipelineProjectId)) pipelineProjectId = projects[0]?.id || '';
  const item = projects.find(p => p.id === pipelineProjectId), plan = item?.pipelinePlan;
  const reports = state.scans.filter(s => s.projectId === pipelineProjectId && s.pipelinePlanId).slice(0, 12);
  return heading('验收流水线', '从需求到实际行为，逐阶段确认实现质量。失败与未验证不会被计为通过。') +
    panel('本轮迭代一键验收', '<div class="panel-body"><p>连续执行平台自检和完整的页面操作回归。只有两类证据完整通过、对应同一版代码，本轮才通过；失败或中断不会沿用旧成功。</p>' + button('查看本轮验收', 'iteration-check', '', 'primary') + '</div>') +
    panel('平台自身迭代检查', '<div class="panel-body"><p>检查当前平台的 JavaScript 语法、实际自动测试和代码版本。结果只覆盖自动自检范围，业务场景和页面体验仍需实际验收。</p>' + button('检查平台自身', 'platform-check', '', 'primary') + '</div>') +
    panel('页面操作自动回归', '<div class="panel-body"><p>使用独立示例，自动验证添加项目、扫描、验收证据、下载、失败阻断、复验、源码变化和窄屏显示。保存每项结果与截图。</p>' + button('查看页面回归', 'browser-check', '', 'primary') + '</div>') +
    (item ? panel('项目与验收方案', `<div class="panel-body"><label for="pipeline-project">选择验收项目</label><select id="pipeline-project">${projects.map(p => `<option value="${p.id}" ${p.id === pipelineProjectId ? 'selected' : ''}>${e(p.name)}</option>`).join('')}</select><p>${plan ? `${e(plan.name)} · ${plan.caseCount} 个场景 · ${plan.confirmed ? '已确认方案' : '模板草稿'} · ${e(time(plan.updatedAt))}` : '还没有保存验收方案。可从 30 个场景的模板开始，按实际业务调整。'}</p><div class="pipeline-map">${['需求与方案', '环境准备', '本地风险', '构建测试', '综合门禁', '多场景验证', '交付证据', '版本核对'].map((n, i) => `<span>${i + 1}. ${n}</span>`).join('')}</div><p class="subtle">自动阶段运行已有项目检查；业务场景需要实际执行后填写结果和证据。新扫描保留当时方案，修改方案不改写历史。${plan ? (plan.requireFull ? '本方案要求完整构建与测试。' : '本方案只要求本地检查，不包含自动构建和测试。') : ''}</p><div class="buttons">${button(plan ? '编辑验收方案' : '建立验收方案', 'pipeline-plan', `data-id="${item.id}"`, 'primary')}${plan ? button('按方案执行', 'pipeline-run', `data-id="${item.id}" ${state.active || !plan.confirmed ? 'disabled' : ''}`) + button('导出详细方案', 'pipeline-export-plan', `data-id="${item.id}"`) : ''}${button('填写任务约定', 'coding-brief', `data-id="${item.id}"`)}${button('检查运行环境', 'pipeline-environment')}</div></div>`) : empty('先添加项目', '为本机项目建立专属验收方案。', button('添加项目', 'add-project', '', 'primary'))) +
    panel('最近的流水线运行', reports.length ? `<div class="table-wrap"><table><thead><tr><th>运行时间 / 范围</th><th>自动检查</th><th>场景记录</th><th>操作</th></tr></thead><tbody>${reports.map(r => `<tr><td>${e(time(r.startedAt))}<small>${r.scope === 'changed' ? 'Git 改动' : r.mode === 'full' ? '完整体检' : '本地检查'} · ${r.pipelinePlanId === plan?.id ? '当前方案' : '历史方案'}</small></td><td>${badge(r.status)} ${badge(r.gate?.status)}</td><td>${r.pipelineCounts ? `通过 ${r.pipelineCounts.passed} / ${r.pipelineCounts.total}<small>失败 ${r.pipelineCounts.failed} · 未验证 ${r.pipelineCounts.pending} · 需重核 ${r.pipelineCounts.invalid} · 不适用 ${r.pipelineCounts.notApplicable}</small>` : '未读取'}<small>当前代码一致性需打开核对</small></td><td>${button('查看流水线', 'pipeline-report', `data-id="${r.id}"`, 'small')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="panel-body subtle">按方案运行后，查看各阶段和逐场景验收结果。</div>', item ? button('全部扫描历史', 'project-history', `data-id="${item.id}"`, 'small') : '');
}

/** data 为服务端实测结果；历史通过与当前文件不同必须显示失效，不使用人工填写的测试数量。 */
function platformCheckModal(data) {
  const names = { NOT_CHECKED: '尚未检查', RUNNING: '正在检查', PASSED: '平台自动自检通过', FAILED: '平台自动自检失败', STALE: '代码已变化或无法核对，请重跑' };
  const r = data.report;
  modal('平台自身迭代检查', `<p><span class="badge ${data.status === 'PASSED' ? 'good' : ['FAILED', 'STALE'].includes(data.status) ? 'bad' : 'warning'}">${e(names[data.status])}</span></p>${r ? `<p class="subtle">${e(time(r.startedAt))} · ${e(r.node)}</p>${r.checks.map(c => `<div class="check-row"><span>${e(c.name)}<small>${e(c.detail)}</small></span><span class="${c.passed ? 'green' : 'red'}">${c.passed ? '通过' : '失败'}</span></div>`).join('')}<p>${e(data.sourceCheck?.reason)}</p><p class="notice">${r.limits.map(e).join('<br>')}</p><details><summary>查看实际测试输出</summary><pre class="logs">${e(r.testOutput || r.error)}</pre></details><p><a class="button small" href="/api/export-file?file=report-${e(r.id)}.json">下载自检报告</a></p>` : '<p>自检固定执行当前平台的检查，不使用外部项目提供的命令。运行期间请保持代码不变。</p>'}<div class="buttons">${button('开始平台自检', 'platform-check-run', data.status === 'RUNNING' ? 'disabled' : '', 'primary')}${button('重新核对结果', 'platform-check')}</div>`);
}

/** data 为本次组合检查的实测汇总；展示当前阶段、分项证据和下一步操作。 */
function iterationCheckModal(data) {
  const names = { NOT_CHECKED: '尚未执行本轮验收', RUNNING: '本轮验收正在执行', PASSED: '本轮自动验收通过', FAILED: '本轮验收失败 / 未完成', STALE: '代码已变化或无法核对，请重跑' };
  const stages = { starting: '准备检查', platform: '平台自检', browser: '页面回归', completed: '完成核对' }, r = data.report;
  modal('本轮迭代一键验收', `<p><span class="badge ${data.status === 'PASSED' ? 'good' : ['FAILED', 'STALE'].includes(data.status) ? 'bad' : 'warning'}">${e(names[data.status])}</span></p>${r ? `<p>${e(time(r.startedAt))} · ${e(stages[r.stage] || r.stage)}</p>${(r.checks || []).map(c => `<div class="check-row"><span>${e(c.name)}<small>${e(c.detail)}</small></span><span class="${c.passed ? 'green' : 'red'}">${c.passed ? '通过' : '未通过'}</span></div>`).join('')}<p>${e(r.error || data.sourceCheck?.reason)}</p>${r.platform ? `<details><summary>平台自检证据</summary>${(r.platform.checks || []).map(c => `<p>${e(c.name)}：${e(c.detail)}</p>`).join('')}<a class="button small" href="/api/export-file?file=report-${e(r.platform.id)}.json">下载本轮自检报告</a></details>` : ''}${r.browser ? `<details><summary>页面流程与截图</summary>${(r.browser.scenarios || []).map(s => `<p>${e(s.name)}：${s.status === 'PASSED' ? '通过' : s.status === 'NOT_RUN' ? '未执行' : '失败'} ${e(s.error || '')}</p>`).join('')}${(r.browser.images || []).map(file => `<img class="browser-evidence" loading="lazy" alt="本轮页面回归实际截图" src="/api/export-file?file=${encodeURIComponent(file)}">`).join('')}</details>` : '<p>本轮页面回归尚未执行，不能用以前的成功结果补齐。</p>'}<p class="notice">${(r.limits || []).map(e).join('<br>')}</p><p><a class="button small" href="/api/export-file?file=report-${e(r.id)}.json">下载本轮完整验收报告</a></p>` : '<p>先执行平台自检，通过后继续真实页面回归。请保持代码不变；正式项目数据不会被修改。</p>'}<div class="buttons">${button('开始本轮验收', 'iteration-check-run', data.status === 'RUNNING' ? 'disabled' : '', 'primary')}${button('刷新本轮结果', 'iteration-check')}</div>`);
}

/** data 为固定浏览器流程的实测报告；截图只通过本机已验证的导出接口读取。 */
function browserCheckModal(data) {
  const names = { NOT_CHECKED: '尚未执行页面回归', RUNNING: '页面流程正在执行', PASSED: '页面自动回归通过', FAILED: '页面自动回归失败 / 未完成', STALE: '代码已变化或无法核对，请重新执行' }, r = data.report;
  modal('页面操作自动回归', `<p><span class="badge ${data.status === 'PASSED' ? 'good' : ['FAILED', 'STALE'].includes(data.status) ? 'bad' : 'warning'}">${e(names[data.status])}</span></p>${r ? `<p>通过 ${r.scenarios.filter(s => s.status === 'PASSED').length} / ${r.scenarios.length} 个记录流程 · ${e(time(r.startedAt))}</p>${r.scenarios.map(s => `<div class="check-row"><span>${e(s.name)}<small>${e(s.error || '')}</small></span><span class="${s.status === 'PASSED' ? 'green' : 'red'}">${s.status === 'PASSED' ? '通过' : s.status === 'NOT_RUN' ? '未执行' : '失败'}</span></div>`).join('')}<p>${e(r.error || data.sourceCheck?.reason)}</p><p class="notice">${r.limits.map(e).join('<br>')}</p><details><summary>查看实际操作截图（${r.images.length}）</summary>${r.images.map(file => `<p>${e(file)}</p><img class="browser-evidence" loading="lazy" alt="页面回归实际截图" src="/api/export-file?file=${encodeURIComponent(file)}">`).join('')}</details><p><a class="button small" href="/api/export-file?file=report-${e(r.id)}.json">下载页面回归报告</a></p>` : '<p>后台浏览器只操作全新的隔离实例，正式项目与验收记录不会被修改。请在检查期间保持平台代码不变。</p>'}<div class="buttons">${button('开始页面回归', 'browser-check-run', data.status === 'RUNNING' ? 'disabled' : '', 'primary')}${button('重新核对页面结果', 'browser-check')}</div>`);
}

/** 为一项可编辑场景创建表单字段；id 只作稳定编号，业务输入、步骤和预期结果由用户填写。 */
function pipelineCaseFields(c) {
  return `<details class="scenario-card" data-case-id="${e(c.id)}"><summary>${e(c.title)} · ${c.required ? '必测' : '可说明不适用'}</summary><div class="field"><label for="case-title-${c.id}">场景名称</label><input id="case-title-${c.id}" name="${c.id}-title" value="${e(c.title)}" maxlength="100" required></div><div class="form-grid"><div class="field"><label for="case-category-${c.id}">场景类别</label><select id="case-category-${c.id}" name="${c.id}-category">${Object.entries(pipelineEditingCategories).map(([id, name]) => `<option value="${id}" ${id === c.category ? 'selected' : ''}>${e(name)}</option>`).join('')}</select></div><label><input type="checkbox" name="${c.id}-required" ${c.required ? 'checked' : ''}> 必测（不能填不适用）</label></div>${[['input', '输入与前置条件'], ['steps', '验证步骤'], ['expected', '预期结果']].map(([key, name]) => `<div class="field"><label for="case-${key}-${c.id}">${name}</label><textarea id="case-${key}-${c.id}" name="${c.id}-${key}" rows="2" maxlength="1000" required>${e(c[key])}</textarea></div>`).join('')}<div class="field"><label for="case-test-ref-${c.id}">绑定自动测试（可选）</label><input id="case-test-ref-${c.id}" name="${c.id}-test-ref" maxlength="400" placeholder="com.example.FlowTest#normal" value="${e(c.testRef)}"><small>留空为人工验证；绑定后要求完整构建，结果不能由人工覆盖。</small></div>${button('移除此场景', 'pipeline-remove-case', `data-case="${e(c.id)}"`, 'small')}</details>`;
}

/** 按项目读取方案或初始模板；每次保存产生新版本，编辑不会覆盖已有报告中的条件。 */
async function pipelinePlanModal(projectId) {
  const data = await api('/api/pipeline/plan?projectId=' + encodeURIComponent(projectId)), p = data.plan || data.template;
  pipelineEditingCases = p.cases.map(c => c.id); pipelineEditingCategories = data.categories;
  modal('编辑验收方案', `<p class="notice">请把模板中的输入、步骤和预期结果改成项目实际条件。必测场景不能以“不适用”跳过；可选场景也要明确记录通过、失败或不适用理由。每个方案最多 60 个场景。</p><form id="pipeline-plan-form" novalidate><input type="hidden" name="projectId" value="${projectId}"><input type="hidden" name="expectedId" value="${e(data.plan?.id)}"><div class="field"><label for="pipeline-name">方案名称</label><input id="pipeline-name" name="name" maxlength="80" required value="${e(p.name)}"></div><label><input type="checkbox" id="pipeline-full" name="requireFull" ${p.requireFull ? 'checked' : ''}> 要求完整构建、自动测试和质量分析</label><div class="form-grid"><div class="field"><label for="pipeline-min-tests">最低实际执行测试数</label><input type="number" id="pipeline-min-tests" name="minTests" min="0" max="1000000" value="${p.minTests}" ${p.requireFull ? '' : 'disabled'} required></div><label><input type="checkbox" id="pipeline-no-skipped" name="noSkipped" ${p.noSkipped ? 'checked' : ''} ${p.requireFull ? '' : 'disabled'}> 不允许跳过自动测试</label></div><label><input type="checkbox" name="requireBrief" ${p.requireBrief ? 'checked' : ''}> 要求扫描时绑定完整任务约定</label><h3>逐场景验收条件</h3><div id="pipeline-case-fields">${p.cases.map(pipelineCaseFields).join('')}</div>${button('添加业务场景', 'pipeline-add-case')}<p><label><input type="checkbox" name="confirmed" ${p.confirmed ? 'checked' : ''}> 已按实际业务检查和调整这些场景</label></p><div class="form-actions"><button class="button primary" type="submit">保存方案版本</button></div></form>`);
}

/** 显示八阶段状态与逐场景证据；运行中刷新只更新报告，打开编辑表单后停止自动刷新。 */
async function pipelineReportModal(id, verify = true, background = false) {
  const request = beginDetailRead(background, 'pipeline', id); if (!request) return;
  const scroll = viewedPipelineId === id ? $('#dialog').scrollTop : 0;
  const view = verify ? await api('/api/pipeline/check', { id }, request.signal) : await api('/api/pipeline/report?id=' + encodeURIComponent(id), undefined, request.signal);
  if (!request.current()) return;
  const r = view.report, s = view.summary, plan = r.acceptancePipeline.plan;
  const names = { READY: '本次范围可验收', PENDING: '待完成场景与证据', BLOCKED: '验收受阻', RUNNING: '检查正在执行', PASSED: '通过', FAILED: '失败', NOT_REQUIRED: '方案未要求', WAITING: '等待执行' };
  modal('验收流水线报告', `<p>${e(state.projects.find(p => p.id === r.projectId)?.name)} · ${e(time(r.startedAt))} · ${e(plan.name)}</p><section class="notice ${s.status === 'BLOCKED' ? 'red' : ''}"><h3>${e(names[s.status])}</h3><p>核对时间：${e(time(s.checkedAt))} · ${r.mode === 'full' ? '完整体检' : r.scope === 'changed' ? '本次 Git 改动' : '本地检查'}</p><strong>下一步：${e(s.next)}</strong></section><div class="pipeline-stages">${s.stages.map(stage => `<article class="pipeline-stage"><div><strong>${e(stage.name)}</strong><span class="badge ${stage.status === 'PASSED' ? 'good' : ['FAILED', 'BLOCKED'].includes(stage.status) ? 'bad' : 'warning'}">${e(names[stage.status] || stage.status)}</span></div><p>${e(stage.detail)}</p></article>`).join('')}</div>${s.blockers.length ? `<details><summary>查看所有阻断条件（${s.blockers.length}）</summary>${s.blockers.map(b => `<p>${e(b)}</p>`).join('')}</details>` : ''}<h3>逐场景行为记录</h3><p class="subtle">通过 ${s.counts.passed} · 失败 ${s.counts.failed} · 未验证 ${s.counts.pending} · 需重核 ${s.counts.invalid} · 有理由不适用 ${s.counts.notApplicable}。绑定测试的结果由本次构建自动采集；其他记录为人工验证声明，平台不执行文字步骤。</p>${Object.entries(view.categories).map(([category, name]) => {
    const cases = plan.cases.filter(c => c.category === category);
    return cases.length ? `<h4>${e(name)}</h4>${cases.map(c => {
      const result = r.acceptancePipeline.results[c.id];
      return `<details class="scenario-card"><summary>${e(c.title)} · ${c.required ? '必测' : '可说明不适用'} · ${e(pipelineResultNames[result?.status || 'pending'])}${result && result.sourceStatus !== 'CURRENT' ? ' · 代码版本未确认' : ''}</summary><p><strong>输入与前置条件：</strong>${e(c.input)}</p><p><strong>验证步骤：</strong>${e(c.steps)}</p><p><strong>预期结果：</strong>${e(c.expected)}</p>${result ? `<p><strong>实际结果：</strong>${e(result.actual)}</p><p><strong>证据：</strong>${e(result.evidence)}</p><p class="subtle">记录 ${e(time(result.recordedAt))} · ${result.origin === 'automatic' ? '自动测试' : '人工声明'} · 当时核对 ${e(result.sourceStatus)}</p>` : '<p class="subtle">尚未记录实际验证。</p>'}${button(c.testRef ? '自动采集，需重跑复验' : '记录场景结果', 'pipeline-case', `data-id="${id}" data-case="${e(c.id)}" ${r.status === 'completed' && !c.testRef ? '' : 'disabled'}`, 'small')}</details>`;
    }).join('')}` : '';
  }).join('')}<details><summary>检查日志与范围限制</summary><pre class="log">${e(r.logs)}</pre>${s.limits.map(l => `<p>${e(l)}</p>`).join('')}</details><div class="form-actions">${button('重新核对流水线', 'pipeline-report', `data-id="${id}"`)}${button('填写交付验收证据', 'acceptance', `data-id="${id}" ${r.status === 'completed' ? '' : 'disabled'}`)}${button('导出详细验收记录', 'pipeline-export-report', `data-id="${id}"`, 'primary')}</div>`);
  if (r.status === 'running') viewedPipelineId = id;
  if (scroll) $('#dialog').scrollTop = scroll;
}

/** 编辑一个固定报告中的单个场景；服务端核对源码并检查旧记录时间，避免覆盖别人的证据。 */
async function pipelineCaseModal(id, caseId) {
  const view = await api('/api/pipeline/report?id=' + encodeURIComponent(id)), c = view.report.acceptancePipeline.plan.cases.find(c => c.id === caseId);
  if (!c) throw Error('场景不存在');
  const r = view.report.acceptancePipeline.results[caseId];
  modal('记录场景结果 · ' + c.title, `<p><strong>输入：</strong>${e(c.input)}</p><p><strong>步骤：</strong>${e(c.steps)}</p><p><strong>预期：</strong>${e(c.expected)}</p><p class="notice">记录你实际执行的验证，包括输入、环境、命令或操作、预期与实际差异。保存时自动核对代码；变化后的证据会保留，但不能用于本报告验收。</p>${r?.history?.length ? `<details><summary>之前的记录（${r.history.length}）</summary>${r.history.map(h => `<p>${e(time(h.recordedAt))} · ${e(pipelineResultNames[h.status])} · ${e(h.sourceStatus)}</p><p>${e(h.actual)}</p><p>${e(h.evidence)}</p>`).join('')}</details>` : ''}<form id="pipeline-result-form"><input type="hidden" name="id" value="${id}"><input type="hidden" name="caseId" value="${e(caseId)}"><input type="hidden" name="expectedRecordedAt" value="${e(r?.recordedAt)}"><div class="field"><label for="pipeline-case-status">本次场景结果</label><select id="pipeline-case-status" name="status">${Object.entries(pipelineResultNames).filter(([status]) => !c.required || status !== 'notApplicable').map(([status, name]) => `<option value="${status}" ${status === (r?.status || 'pending') ? 'selected' : ''}>${e(name)}</option>`).join('')}</select></div><div class="field"><label for="pipeline-case-actual">实际结果或不适用原因</label><textarea id="pipeline-case-actual" name="actual" rows="3" maxlength="1000">${e(r?.actual)}</textarea></div><div class="field"><label for="pipeline-case-evidence">验证方式与结果证据</label><textarea id="pipeline-case-evidence" name="evidence" rows="4" maxlength="1000">${e(r?.evidence)}</textarea></div><p class="subtle">除“未验证”外，两项各至少 8 字。不适用需要理由且只能用于可选场景。</p><div class="form-actions"><button type="submit" class="button primary">保存场景结果</button></div></form>`);
}

/** Show why protected reports remain visible; only eligible old records expose archive controls. */
function archiveControl(report) {
  return report.archiveProtection ? `<span class="badge" title="${e(report.archiveProtection)}">保留 · ${e(report.archiveProtection)}</span>` : `<label><input type="checkbox" name="archive-report" value="${report.id}" aria-label="选择归档 ${e(time(report.startedAt))}"></label>${button('归档', 'archive-report', `data-id="${report.id}"`, 'small')}`;
}

/** Page retired projects and on-disk archived report summaries; no source files or reports are deleted. */
function archivesPage() {
  const list = currentList('archives'), projects = state.projects.filter(p => p.archivedAt), offset = Math.min(archivedProjectOffset, Math.max(0, Math.ceil(projects.length / 25) - 1) * 25);
  archivedProjectOffset = offset;
  const projectRows = projects.slice(offset, offset + 25);
  return heading('归档中心', '整理旧记录，不删除源码、证据或报告。恢复后仍能追溯当时的要求。') +
    panel('已归档项目', `<div class="panel-body">${projectRows.length ? projectRows.map(p => `<div class="check-row"><span>${e(p.name)}<small>归档于 ${e(time(p.archivedAt))}</small></span><div class="buttons">${button('查看历史', 'project-history', `data-id="${p.id}"`, 'small')}${button('恢复项目', 'restore-project', `data-id="${p.id}"`, 'small')}</div></div>`).join('') : '<p class="subtle">没有已归档项目。在项目管理中归档暂时不用的项目。</p>'}${projects.length > 25 ? `<p>第 ${Math.floor(offset / 25) + 1} 页 · 共 ${projects.length} 个项目</p><div class="buttons">${button('上一页', 'archive-project-page', `data-offset="${Math.max(0, offset - 25)}" ${offset ? '' : 'disabled'}`)}${button('下一页', 'archive-project-page', `data-offset="${offset + 25}" ${offset + 25 >= projects.length ? 'disabled' : ''}`)}</div>` : ''}</div>`) +
    panel('已归档报告', `<div class="panel-body"><label for="archive-project">按项目筛选</label><select id="archive-project">${projectOptions()}</select><p class="subtle">按归档时间排列。摘要按页从磁盘读取；完整报告、人工验收与基线证据仍保留。当前最新检查和基线不能归档。</p></div>${list.rows.length ? `<div class="table-wrap"><table><thead><tr><th>检查对象</th><th>原检查时间</th><th>门禁</th><th>归档时间</th><th>操作</th></tr></thead><tbody>${list.rows.map(r => `<tr><td>${e(r.scope === 'github' ? r.repository + ' #' + r.number : state.projects.find(p => p.id === r.projectId)?.name)}</td><td>${e(time(r.startedAt))}</td><td>${badge(r.gate?.status)}</td><td>${e(time(r.archivedAt))}</td><td><div class="buttons">${button('查看报告', r.scope === 'github' ? 'github-detail' : 'scan-detail', `data-id="${r.id}"`, 'small')}${button('验收证据', 'acceptance', `data-id="${r.id}"`, 'small')}${button('恢复报告', 'restore-report', `data-id="${r.id}"`, 'small')}</div></td></tr>`).join('')}</tbody></table></div>` : listPlaceholder(list, '没有匹配的归档报告', '在扫描历史中归档旧报告，可随时恢复。')}`) + pagination(list.total, 'archives');
}

/** Separate automatic findings from evidence-based human acceptance for each historical report. */
function acceptanceBadge(report) {
  const sourceBlocked = report.acceptanceSourceCheck && report.acceptanceSourceCheck.status !== 'CURRENT';
  const status = report.readiness?.status || report.acceptanceStatus;
  const blocked = report.gate?.status !== 'PASSED' || status === 'BLOCKED' || sourceBlocked;
  const reviewed = !blocked && (status === 'REVIEWED' || (!report.acceptancePipeline && !report.pipelinePlanId && state.checklist.every(c => report.acceptance?.[c.id]?.checked && report.acceptance[c.id].evidence.length >= 8)));
  return `<span class="badge ${blocked ? 'bad' : reviewed ? 'good' : 'warning'}">${blocked ? report.gate?.status === 'PASSED' ? '验收受阻 · 条件未满足' : '自动检查未通过 / 不完整' : reviewed ? '人工验收已记录' : report.acceptancePipeline || report.pipelinePlanId ? '等待场景与人工验收' : '等待人工验收'}</span>`;
}

/** A read-only PR workflow and recorded verification evidence help review AI-generated changes. */
function qualityPage() {
  const list = currentList('quality');
  return heading('代码审查与证据', '检查 PR 改动、定义任务约定、记录交付证据。审查结果只对应本次检查范围。') +
    `<div class="info-grid"><div class="info-tile"><div class="number">01 / REQUIREMENTS</div><h3>先定义正确行为</h3><p>写清输入、结果与边界，避免“页面能打开”成为唯一验收条件。</p></div><div class="info-tile"><div class="number">02 / CHECK</div><h3>检查真实改动</h3><p>本地 Git 或 GitHub PR 检查，关注兼容性、凭据、异常与数据库风险。</p></div><div class="info-tile"><div class="number">03 / EVIDENCE</div><h3>留下验证证据</h3><p>记录测试结果和恢复方案，再导出修复任务。自动规则通过不等于业务正确。</p></div></div>` +
    briefOverview() + `<div class="grid-two">${panel('GitHub PR 检查', `<div class="panel-body"><p class="subtle">从 GitHub 读取代码，在本机检查。支持公开仓库；私有仓库需要 Token。仅检查 Java / SQL，不执行 PR 中的代码。</p><form id="github-pulls-form"><div class="field"><label for="github-repository">仓库名称或 GitHub 仓库地址</label><input id="github-repository" name="repository" placeholder="owner/repository" value="${e(githubRepository)}" required></div><div class="form-actions"><button class="button" type="submit">读取最近 30 个开放 PR</button></div></form><form id="github-review-form"><div class="field"><label for="github-number">PR 编号</label><input id="github-number" type="number" min="1" step="1" name="number" required placeholder="123"></div><p class="subtle">每次最多 100 个改动文件。报告记录具体提交；差异缺失或没有可检查源码时不会显示通过。</p><div class="form-actions"><button class="button primary" type="submit" ${state.githubActive ? 'disabled' : ''}>${state.githubActive ? 'GitHub 检查进行中' : '检查 PR 改动'}</button></div><p id="github-progress" class="subtle"></p></form>${githubPullData ? `<div class="pr-list"><p class="subtle">${e(githubPullData.repository)} · 最近 ${githubPullData.pulls.length} 个开放 PR</p>${githubPullData.pulls.length ? githubPullData.pulls.map(p => `<div class="check-row"><span>#${p.number} ${e(p.title)}<small>${e(p.author)}${p.draft ? ' · 草稿' : ''}</small></span>${button('选择', 'select-pr', `data-id="${p.number}"`, 'small')}</div>`).join('') : '<p class="subtle">未找到开放的 PR；也可以直接填写已有 PR 编号。</p>'}</div>` : ''}</div>`)}${optionalPanel('GitHub 访问配置', `<div class="panel-body"><p>${state.githubTokenConfigured ? '<span class="badge good">Token 已设置</span>' : '<span class="badge">公开仓库可直接读取</span>'}</p><form id="github-token-form"><div class="field"><label for="github-token">GitHub Token</label><input id="github-token" type="password" autocomplete="off" name="token" placeholder="填写具有仓库读取权限的 Token" required><small>仅保存在当前进程中；重启后需重新填写。只需 Contents 与 Pull requests 的读取权限。</small></div><div class="form-actions">${button('清除 Token', 'github-clear-token')}<button class="button" type="submit">保存 Token</button></div></form><div class="notice">报告保存在本机。这一版不会向 GitHub 发布评论、修改代码或合并 PR。完整构建与测试仍需对本机项目执行完整体检。</div></div>`)}</div>` +
    qualityRecords(list);
}

/** Show bounded requirement summaries per project, with full text loaded only when editing. */
function briefOverview() {
  return '<div id="brief-overview">' + panel('AI 任务约定', `<div class="panel-body"><p class="subtle">写清目标、改动范围、验收场景和测试计划，再交给 AI。保存的版本会绑定到之后的新扫描；填写完整不代表实现已通过。</p>${activeProjects().length ? activeProjects().map(p => `<div class="check-row"><span>${e(p.name)}<small>${p.codingBrief ? (p.codingBrief.ready ? '约定已填写' : '草稿 · 缺少 ' + e(p.codingBrief.missing.join('、'))) + ' · ' + e(time(p.codingBrief.updatedAt)) : '尚未定义任务约定'}</small></span>${button('编辑任务约定', 'coding-brief', `data-id="${p.id}"`, 'small')}</div>`).join('') : '<p>先在项目管理中添加项目，即可定义任务约定。</p>'}</div>`) + '</div>';
}

/** Load a project's saved version into an escaped editable form; parameters: registered project ID. */
async function codingBriefModal(id) {
  const item = state.projects.find(p => p.id === id), result = await api('/api/coding-brief?projectId=' + encodeURIComponent(id));
  modal('AI 任务约定 · ' + item.name, `<p class="subtle">每项最多 3000 字。必填项可以暂存为空，平台会明确标为草稿。请勿填写密码、Token 或私人数据。</p><form id="coding-brief-form"><input type="hidden" name="projectId" value="${id}">${state.briefFields.map(f => `<div class="field"><label for="brief-${f.id}">${e(f.name)}${f.required ? ' *' : ''}</label><textarea id="brief-${f.id}" name="${f.id}" rows="3" maxlength="3000" placeholder="${e({ goal: '例如：重复提交订单时只创建一笔，返回原订单编号', scope: '例如：仅修改订单服务与对应测试；保持公开接口不变', constraints: '例如：Java 8；不新增依赖；不改写已执行迁移', acceptance: '例如：正常下单、重复下单、无权限和数据库失败时的预期行为', tests: '填写需运行的测试命令、测试范围，以及期望验证的行为', rollback: '说明失败时如何回退代码、恢复数据' }[f.id])}">${e(result.brief?.[f.id])}</textarea></div>`).join('')}<div class="notice">保存后开始的新扫描会保留这版约定。已有报告保留原版本；本功能不自动判断实现是否符合文字要求。</div><div class="form-actions">${result.brief ? button('保存并预览说明', 'brief-preview', `data-id="${id}"`) : ''}<button type="submit" class="button primary">保存任务约定</button></div></form>`);
}

/** Save the active task form and refresh only summaries; form is the editable HTML form. */
async function saveCodingBriefForm(form) {
  const data = new FormData(form), brief = Object.fromEntries(state.briefFields.map(f => [f.id, data.get(f.id)]));
  const result = await api('/api/coding-brief', { projectId: data.get('projectId'), brief });
  await refresh(false);
  if ($('#brief-overview')) $('#brief-overview').outerHTML = briefOverview();
  return result;
}

/** Render missing verification evidence and scope limits without inventing successful tests. */
function readinessPanel(report, briefOnly = false) {
  const r = report.readiness;
  if (!r) return '';
  const gaps = briefOnly ? '' : `<div class="notice ${r.blockers.length ? 'red' : ''}"><strong>验收缺口 · ${r.missing.length} 项证据待补充</strong>${r.blockers.map(text => `<p>${e(text)}</p>`).join('')}<p>${r.missing.length ? '待补充：' + e(r.missing.join('、')) : '人工证据已填写，请结合原始记录核实。'}</p>${r.limits.map(text => `<p class="subtle">${e(text)}</p>`).join('')}</div>`;
  return gaps + (report.codingBrief ? `<details><summary>查看本次检查绑定的任务约定 · ${e(time(report.codingBrief.updatedAt))}</summary>${state.briefFields.map(f => `<p><strong>${e(f.name)}</strong></p><pre class="log">${e(report.codingBrief[f.id] || '尚未填写')}</pre>`).join('')}</details>` : '');
}

/** Display a point-in-time decision with explicit scope, verification time, and next action. */
function currentReadinessPanel(r) {
  const names = { READY: '本次范围可验收', BLOCKED: '验收受阻', PENDING: '待补充证据', NOT_CHECKED: '尚未检查' };
  return `<section class="notice ${r.status === 'BLOCKED' ? 'red' : ''}"><h3>${e(names[r.status])}</h3><p>范围：${e({ project: '整个项目', changed: '本次 Git 改动', github: '固定 GitHub PR 提交' }[r.scope] || '未检查')} · 核对时间：${e(time(r.checkedAt))}</p>${(r.checks || []).map(c => `<div class="check-row"><span>${e(c.name)}</span><span>${e(c.value)}</span></div>`).join('')}${r.blockers.map(t => `<p>${e(t)}</p>`).join('')}<p>${r.missing.length ? '待补充：' + e(r.missing.join('、')) : ''}</p><strong>下一步：${e(r.next)}</strong>${r.limits.map(t => `<p class="subtle">${e(t)}</p>`).join('')}</section>`;
}

/** Check the latest project attempt on demand; older successful reports cannot mask failures. */
async function readinessModal(projectId) {
  const r = await api('/api/readiness', { projectId });
  modal('现在可以验收吗？', currentReadinessPanel(r) + `<div class="form-actions">${r.reportId ? button('打开本次报告', 'scan-detail', `data-id="${r.reportId}"`) + button('填写验收证据', 'acceptance', `data-id="${r.reportId}"`) : ''}${button('重新检查', 'scan-project', `data-id="${projectId}"`)}</div>`);
}

/** Show review provenance without hiding findings or weakening automatic checks. */
function issueReviewControls(issue, reportId) {
  const r = issue.review;
  return `<div class="issue-review"><span class="badge">${e(reviewNames[r?.status || 'open'])}</span>${r?.event ? `<span class="badge warning">${r.event === 'returned' ? '再次出现' : '证据变化'} · ${r.status === 'open' ? '需重新审查' : '已记录审查'}</span>` : ''}${r?.reason ? `<p class="subtle">${e(r.reason)}</p>` : ''}${button('审查问题', 'issue-review', `data-id="${reportId}" data-tracking="${e(issue.trackingId)}"`, 'small')}${state.scans.some(s => s.id === reportId && s.projectId) ? button('转为跟踪任务', 'work-from-issue', `data-id="${reportId}" data-tracking="${e(issue.trackingId)}"`, 'small') : ''}</div>`;
}

/** Load one report and edit a specific finding with its original and previous review evidence. */
async function issueReviewModal(id, trackingId) {
  const origin = repairReturn?.id === id ? { ...repairReturn } : null;
  const request = beginDetailRead();
  const report = await api(`/api/report?id=${encodeURIComponent(id)}`, undefined, request.signal);
  if (!request.current()) return;
  const issue = report.issues.find(i => i.trackingId === trackingId);
  if (!issue) throw Error('问题已变化，请重新读取');
  const r = issue.review;
  modal('问题审查', `<h3>${e(issue.message)}</h3><p>${e(issue.file)}:${issueLine(issue.line)} · ${e(issue.rule)}</p><code>${e(issue.excerpt)}</code><p class="notice">审查仅记录判断。已排除的问题仍保留在报告与门禁中；变更或再次出现需要重新审查。</p>${r?.prior ? `<p>此前判断：${e(reviewNames[r.prior.status])} · ${e(r.prior.reason)}</p>` : ''}${r?.history?.length ? `<details><summary>之前的审查记录</summary>${r.history.map(h => `<p>${e(time(h.updatedAt))} · ${e(reviewNames[h.status])} · ${e(h.reason)}</p>`).join('')}</details>` : ''}<form id="issue-review-form">${origin ? `<input type="hidden" name="returnOffset" value="${origin.offset}"><input type="hidden" name="returnGithub" value="${origin.github}">` : ''}<input type="hidden" name="id" value="${id}"><input type="hidden" name="trackingId" value="${e(trackingId)}"><div class="field"><label for="review-state">审查状态</label><select id="review-state" name="status">${Object.entries(reviewNames).map(([s, n]) => `<option value="${s}" ${s === (r?.status || 'open') ? 'selected' : ''}>${e(n)}</option>`).join('')}</select></div><div class="field"><label for="review-reason">判断依据（8 到 2000 字）</label><textarea id="review-reason" name="reason" rows="4" minlength="8" maxlength="2000" required>${e(r?.reason)}</textarea></div><div class="form-actions">${origin ? button('返回修复清单', 'tasks-page', `data-id="${id}" data-offset="${origin.offset}" data-github="${origin.github}"`) : ''}<button type="submit" class="button primary">保存审查</button></div></form>`);
}

/** Render only the bounded quality-record list, preserving in-progress GitHub form input. */
function qualityRecords(list) {
  const reports = list.rows;
  return '<div id="quality-records">' + panel('检查与验收记录', reports.length ? `<div class="table-wrap"><table><thead><tr><th>检查对象</th><th>自动规则</th><th>人工验收</th><th>时间</th><th>操作</th></tr></thead><tbody>${reports.map(r => `<tr><td>${e(r.scope === 'github' ? `${r.repository} #${r.number}` : state.projects.find(p => p.id === r.projectId)?.name)}<small>${r.scope === 'github' ? 'GitHub PR · ' + e(r.headSha.slice(0, 10)) : r.scope === 'changed' ? '本次 Git 改动' : r.mode === 'full' ? '完整体检' : '整个项目 · 本地规则'}</small></td><td>${badge(r.gate?.status)}<small>${issueCount(r)} 条问题</small></td><td>${acceptanceBadge(r)}</td><td>${e(time(r.startedAt))}</td><td><div class="buttons">${button('详情', r.scope === 'github' ? 'github-detail' : 'scan-detail', `data-id="${r.id}"`, 'small')}${button('验收', 'acceptance', `data-id="${r.id}"`, 'small')}${archiveControl(r)}</div></td></tr>`).join('')}</tbody></table></div>` : listPlaceholder(list, '还没有检查记录', '完成本地检查或 GitHub PR 检查后，在这里记录验证证据。')) + `<div class="panel-foot">${button('归档已选旧报告', 'archive-selected', '', 'small')}<a href="#archives">查看归档与恢复 →</a></div>` + pagination(list.total, 'quality') + '</div>';
}

/** Edit verification evidence tied to a report, not to future code or the entire repository. */
async function acceptanceModal(id) {
  const report = await api('/api/report?id=' + encodeURIComponent(id));
  const currentReadiness = await api('/api/readiness', { id });
  modal('人工验收与证据', `<p>本报告保存的验收记录：${acceptanceBadge(report)}</p><p class="subtle">记录对应 ${e(time(report.startedAt))} 的检查结果。勾选与文字是你的人工声明；平台不会把它当成自动执行的测试。</p>${currentReadinessPanel(currentReadiness)}${report.acceptancePipeline ? button('逐场景验收记录', 'pipeline-report', `data-id="${id}"`) : ''}${readinessPanel(report, true)}${sourceVersionPanel(report)}<form id="acceptance-form"><input name="id" type="hidden" value="${id}">${state.checklist.map(c => `<div class="field"><label><input type="checkbox" name="${c.id}" ${report.acceptance?.[c.id]?.checked ? 'checked' : ''}> ${e(c.name)}</label><small>${e(c.description)}</small><textarea name="${c.id}-evidence" aria-label="${e(c.name)}验证证据" rows="3" maxlength="2000" placeholder="填写验证方式、结果或相关记录；勾选后至少 8 字">${e(report.acceptance?.[c.id]?.evidence)}</textarea></div>`).join('')}<div class="notice">有高风险问题、数据不完整或自动检查未通过时，人工勾选无法解除阻断。验收后的代码变动需要新检查。</div><div class="form-actions"><button class="button primary" type="submit">保存验收记录</button></div></form>`);
}

/** Display immutable PR metadata and bounded local findings; no remote source is retained. */
async function githubDetail(id, offset = 0) {
  const request = beginDetailRead();
  const [r, result] = await Promise.all([api('/api/report/view?id=' + encodeURIComponent(id), undefined, request.signal), api('/api/tasks/page?id=' + encodeURIComponent(id) + '&offset=' + offset, undefined, request.signal)]);
  if (!request.current()) return;
  modal('GitHub PR 检查报告', `<h3>${e(r.repository)} #${r.number} · ${e(r.title)}</h3><p>${badge(r.gate.status)} ${acceptanceBadge(r)}</p><p class="subtle">HEAD ${e(r.headSha)}<br>BASE ${e(r.baseSha)}</p><div class="notice">${r.notes.map(e).join('<br>')}</div><p class="subtle">${r.changedFiles} 个改动文件 · 检查 ${r.checkedFiles} 个 Java / SQL 文件 · ${r.touchedTests} 个测试文件改动</p>${repairTaskList(result, id, true)}<div class="form-actions"><a class="button" href="${e(r.url)}" target="_blank" rel="noreferrer">打开 GitHub PR ↗</a>${button('记录验收', 'acceptance', `data-id="${id}"`)}${button('导出修复与验收清单', 'export-tasks', `data-id="${id}"`, 'primary')}${button('导出 SARIF', 'export-sarif', `data-id="${id}"`)}</div>`);
  repairReturn = { id, offset, github: true };
}
function modal(title, html) { cancelDetailRead(); repairReturn = null; viewedScanId = null; viewedPipelineId = null; $('#dialog-content').innerHTML = `<div class="modal-head"><h2>${title}</h2><button class="close" data-action="close" aria-label="关闭">×</button></div>${html}`; $('#dialog').scrollTop = 0; if (!$('#dialog').open) $('#dialog').showModal(); }
function addProjectModal(item) {
  modal(item ? '编辑本地项目' : '添加本地项目', `<form id="project-form">${item ? `<input type="hidden" name="id" value="${item.id}">` : ''}<div class="field"><label for="project-name">项目名称</label><input id="project-name" name="name" placeholder="BidPlatform V2" value="${e(item?.name)}" maxlength="80" required></div><div class="field"><label for="project-key">项目 Key</label><input id="project-key" name="key" placeholder="bidplatform-v2" value="${e(item?.key)}" ${item ? 'readonly' : ''} pattern="[a-zA-Z0-9][a-zA-Z0-9_.:\\-]*" required><small>与 SonarQube 中的项目 Key 保持一致；已有项目 Key 不变。</small></div><div class="field"><label for="project-path">项目根目录</label><input id="project-path" name="path" placeholder="D:\\projects\\bidplatform_v2" value="${e(item?.path)}" required><small>填写包含 pom.xml 的本机完整路径。迁移到新电脑后可在此更新。</small></div><div class="form-actions">${button('取消', 'close')}<button class="button primary" type="submit">${item ? '保存项目' : '添加项目'}</button></div></form>`);
}
function scanModal(id) {
  if (!activeProjects().length) { addProjectModal(); return; }
  modal('开始代码体检', `<form id="scan-form"><div class="field"><label for="scan-project">选择项目</label><select id="scan-project" name="projectId">${activeProjects().map(p => `<option value="${p.id}" ${id === p.id ? 'selected' : ''}>${e(p.name)}</option>`).join('')}</select></div><div class="scan-choice"><label><input type="radio" name="mode" value="local" checked>整个项目 · 本地规则 <span class="badge good">即开即用</span></label><p>检查整个项目的兼容性、异常处理、迁移等问题。无需 JDK 或 Docker。</p></div><div class="scan-choice"><label><input type="radio" name="mode" value="changed">本次 Git 改动 <span class="badge">聚焦新增修改</span></label><p>对照当前 HEAD，检查暂存、未暂存和未跟踪的 Java / SQL 改动。已提交的改动不包含在内，结果不会覆盖整个项目的指标。</p></div><div class="scan-choice"><label><input type="radio" name="mode" value="full">完整质量体检</label><p>Java 8 构建与测试 → JaCoCo → Java 21 SonarScanner → SonarQube。会执行项目的 Maven 构建流程。</p></div><div id="preflight-results"></div><div class="form-actions">${button('取消', 'close')}${button('检查准备情况', 'preflight')}<button class="button primary" type="submit" ${state.active ? 'disabled' : ''}>${state.active ? '已有扫描运行中' : '开始检查'}</button></div></form>`);
}

/** Map a scan choice to the server's explicit mode and scope. */
function scanRequest(form) { const data = new FormData(form); return { projectId: data.get('projectId'), mode: data.get('mode') === 'changed' ? 'local' : data.get('mode'), scope: data.get('mode') === 'changed' ? 'changed' : 'project' }; }
async function checkReady(form) {
  const choice = scanRequest(form);
  const report = await api('/api/preflight', choice);
  if (!$('#dialog').open || !document.contains(form) || JSON.stringify(choice) !== JSON.stringify(scanRequest(form))) return false;
  $('#preflight-results').innerHTML = `<div class="readiness ${report.ready ? 'ready' : 'blocked'}"><strong>${report.ready ? '准备就绪，可以开始检查' : '请先处理以下缺项'}</strong>${report.checks.map(c => `<div class="readiness-row"><span class="${c.passed ? 'green' : 'red'}">${c.passed ? '✓' : '○'} ${e(c.name)}</span><span>${e(c.detail)}</span></div>`).join('')}</div>`;
  return report.ready;
}
/** Show real pipeline stages and elapsed time instead of an invented percentage. */
function progress(scan) {
  const stages = scan.mode === 'full' ? [['preflight', '准备检查'], ['snapshot', '记录版本'], ['local', '本地规则'], ['build', '构建与测试'], ['sonar', '提交分析'], ['processing', '等待处理'], ['import', '读取结果']] : [['preflight', '准备检查'], ['snapshot', '记录版本'], ['local', scan.scope === 'changed' ? '检查改动' : '本地规则']];
  // Legacy reports never ran the version stage; do not draw a completed step for missing evidence.
  if (!scan.sourceSnapshot && scan.stage !== 'snapshot') stages.splice(1, 1);
  const at = scan.stage === 'done' ? stages.length : stages.findIndex(s => s[0] === scan.stage);
  const seconds = Math.max(0, Math.round((new Date(scan.finishedAt || Date.now()) - new Date(scan.startedAt)) / 1000));
  return `<div class="pipeline">${stages.map(([id, title], index) => `<div class="pipeline-step ${index < at ? 'done' : index === at ? 'current' : ''}"><span>${index < at ? '✓' : index + 1}</span>${title}</div>`).join('')}</div><p class="subtle">${scan.status === 'running' ? '正在执行' : scan.status === 'completed' ? '已完成' : '执行结束'} · 已用时 ${seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒'} · ${scan.scope === 'changed' ? '本次 Git 改动' : '整个项目'}</p>${scan.fileProgress ? `<p class="subtle">已检查 ${scan.fileProgress.completed} / ${scan.fileProgress.total} 个源文件</p>` : ''}${scan.status === 'running' && scan.stage === 'local' ? `<div class="form-actions">${button(scan.stopRequested ? '正在停止…' : '停止本地规则检查', 'stop-scan', `data-id="${scan.id}" ${scan.stopRequested ? 'disabled' : ''}`)}</div>` : ''}`;
}

/** Render one page of findings; paging retains global numbering and never changes full exports. */
function repairTaskList(result, id, github = false) {
  const { tasks, total, offset, limit } = result;
  const attrs = position => 'data-id="' + id + '" data-offset="' + position + '" data-github="' + github + '"';
  return '<p class="subtle" aria-live="polite">' + (tasks.length ? '显示第 ' + (offset + 1) + '–' + (offset + tasks.length) + ' 条，共 ' + total + ' 条' : total ? '此页没有问题，共 ' + total + ' 条' : '本次扫描没有需要整理的修复任务。') + '</p><div class="task-list">' + tasks.map(t => '<article class="repair-task"><div class="task-heading"><span class="badge ' + (['HIGH', 'CRITICAL', 'BLOCKER'].includes(t.severity) ? 'bad' : 'warning') + '">' + e(severityNames[t.severity] || t.severity) + '</span><strong>' + t.number + '. ' + e(t.message) + '</strong></div><p class="subtle">' + e(t.file) + ':' + issueLine(t.line) + ' · ' + e(t.rule) + '</p>' + (github && t.excerpt ? '<code>' + e(t.excerpt) + '</code>' : '') + issueReviewControls(t, id) + '<p>' + e(t.advice) + '</p><p class="subtle">验收：' + e(t.verification) + '</p></article>').join('') + '</div><div class="form-actions">' + (offset > 0 ? button('上一页', 'tasks-page', attrs(Math.max(0, offset - limit))) : '') + (offset + tasks.length < total ? button('下一页', 'tasks-page', attrs(offset + limit)) : '') + '</div>';
}
/** Load only 25 risk-ordered tasks; id identifies the report and offset is the requested page start. */
async function showTasks(id, offset = 0) {
  const request = beginDetailRead();
  const result = await api('/api/tasks/page?id=' + encodeURIComponent(id) + '&offset=' + offset, undefined, request.signal);
  if (!request.current()) return;
  const scan = result.scan, item = state.projects.find(p => p.id === scan?.projectId);
  modal('修复任务清单', '<p class="subtle">' + e(item?.name) + ' · ' + e(time(scan?.startedAt)) + ' · ' + (scan?.scope === 'changed' ? '本次 Git 改动' : '整个项目') + '</p><div class="notice">按风险排序，每页最多 25 条。建议结合代码确认后再修复；完整导出包含全部问题，可交给 Codex。</div>' + repairTaskList(result, id) + '<div class="form-actions">' + button('导出 Markdown', 'export-tasks', 'data-id="' + id + '"', 'primary') + '</div>');
  repairReturn = { id, offset, github: false };
}

/** Compare stable rule/file/line identities against a user-selected baseline. */
async function scanDetail(id, background = false) {
  const request = beginDetailRead(background, 'scan', id); if (!request) return;
  const previousScroll = viewedScanId === id ? $('#dialog').scrollTop : 0;
  const scan = await api(`/api/scan/view?id=${encodeURIComponent(id)}`, undefined, request.signal);
  if (!request.current()) return;
  const item = state.projects.find(p => p.id === scan.projectId);
  const diff = scan.comparison;
  const comparison = diff?.available ? `<div class="comparison"><h3>相对基线 / 上次同类扫描</h3><div class="comparison-counts"><span class="red">新增 ${diff.addedCount}</span><span class="green">已消失 ${diff.removedCount}</span><span>仍存在 ${diff.unchanged}</span></div>${Object.entries(diff.delta).map(([key, value]) => `<p class="subtle">${({ coverage: '覆盖率', duplicated_lines_density: '重复率', complexity: '复杂度' })[key]}变化：${value > 0 ? '+' : ''}${value}${key === 'complexity' ? '' : ' 个百分点'}</p>`).join('')}<p class="subtle">本地问题按规则、文件与证据匹配；仅行号移动不会被当作修复。</p></div>` : `<p class="subtle">${e(diff?.reason || '选择基线或完成第二次同类检查后，可比较变化。')}</p>`;
  modal('扫描详情', `${scan.archivedAt ? '<p class="notice">这份报告已归档。证据仍保留；需要设为基线时，请先恢复报告。</p>' : ''}<p class="subtle">${e(item?.name)} · ${e(time(scan.startedAt))} · ${scan.mode === 'full' ? '完整体检' : scan.scope === 'changed' ? '本次 Git 改动' : '本地规则'}</p><p>${badge(scan.status)} ${badge(scan.gate?.status)}</p>${progress(scan)}${scan.error ? `<div class="notice red">${e(scan.error)}</div>` : ''}${scan.scope === 'changed' ? `<div class="notice">仅报告本次改动附近的问题，不能据此判断整个项目通过。涉及 ${scan.checkedFiles ?? '待计算'} 个改动文件。${e(scan.changes?.description)}</div>` : ''}${gateEvidence(scan)}${sourceVersionPanel(scan)}${scan.acceptancePipeline ? button('查看验收流水线', 'pipeline-report', `data-id="${scan.id}"`) : ''}<p>${button('查看当前验收条件', 'acceptance', `data-id="${scan.id}"`)}</p><div class="detail-grid">${stat('问题数量', scan.status === 'completed' ? issueCount(scan) : '未完成', scan.status === 'completed' ? '本次检查结果' : '未完成的检查不能计为零问题')}${stat('覆盖率', metric(scan.metrics?.coverage), '仅来自 JaCoCo / SonarQube')}${stat('安全热点', num(scan.metrics?.security_hotspots), '请在 SonarQube 中审查')}${stat('重复率', metric(scan.metrics?.duplicated_lines_density), 'SonarQube 实测')}${stat('复杂度', num(scan.metrics?.complexity), 'SonarQube 实测')}${stat('代码行数', num(scan.metrics?.ncloc ?? scan.metrics?.lines), scan.mode === 'local' ? '整个项目，包括上下文' : '有效代码行')}</div>${comparison}${scan.sonarGate ? `<p class="subtle">SonarQube 自身门禁：${e(scan.sonarGate.status)}</p>` : ''}<pre class="log">${e(scan.logs || '等待日志…')}</pre><div class="form-actions">${scan.status === 'completed' ? button('修复任务清单', 'tasks', `data-id="${scan.id}"`) : ''}${scan.status === 'completed' && scan.scope !== 'changed' && !scan.archivedAt ? button('设为基线', 'baseline', `data-id="${scan.id}" data-project="${scan.projectId}"`) : ''}${button('导出报告', 'export-scan', `data-id="${scan.id}"`)}${scan.status === 'completed' ? button('导出 SARIF', 'export-sarif', `data-id="${scan.id}"`) : ''}</div>`);
  if (scan.status === 'running') viewedScanId = scan.id;
  if (previousScroll) $('#dialog').scrollTop = previousScroll;
}
/** options 指定保存报告及可选导出格式；下载只分享记录的发现，不改变验收结果。 */
async function exportReport(options) {
  const result = await api('/api/export', options);
  modal(options.kind === 'sarif' ? 'SARIF 已导出' : '报告已导出', `<div class="notice">${options.kind === 'sarif' ? '可在对应项目或仓库中交给支持 SARIF 的检查工具。保留原检查范围、风险与门禁；不证明当前代码或测试通过。' : '报告已保存到本机，即使浏览器不支持下载也能直接找到文件。'}</div><p class="subtle">${e(result.path)}</p><div class="form-actions"><a class="button primary" href="${e(result.url)}" download="${e(result.file)}">下载副本</a>${button('完成', 'close')}</div>`);
}

document.addEventListener('click', async event => {
  const control = event.target.closest('[data-action]'); if (!control) return;
  if (control.dataset.action.startsWith('work-')) return;
  const { action, id, project, file, line } = control.dataset;
  try {
    if (action === 'pipeline-open') { pipelineProjectId = id; location.hash = 'pipeline'; if (page === 'pipeline') render(); }
    if (action === 'pipeline-plan') await pipelinePlanModal(id);
    if (action === 'pipeline-run') {
      control.disabled = true;
      const scan = await api('/api/pipeline/run', { projectId: id }); await refresh(false); await pipelineReportModal(scan.id);
    }
    if (action === 'pipeline-report') await pipelineReportModal(id);
    if (action === 'pipeline-case') await pipelineCaseModal(id, control.dataset.case);
    if (action === 'pipeline-environment') { environmentData = await api('/api/environment'); location.hash = 'settings'; }
    if (action === 'pipeline-export-plan' || action === 'pipeline-export-report') {
      const result = await api('/api/pipeline/export', action === 'pipeline-export-plan' ? { projectId: id } : { id });
      modal('验收方案与记录已导出', `<p>${e(result.path)}</p><p class="subtle">保留方案版本、逐场景条件、已填写结果和未满足条件。</p><div class="form-actions"><a class="button primary" href="${e(result.url)}" download="${e(result.file)}">下载 Markdown</a></div>`);
    }
    if (action === 'pipeline-add-case') {
      if (pipelineEditingCases.length >= 60) throw Error('最多 60 个场景');
      const c = { id: 'case-' + crypto.randomUUID(), category: 'functional', title: '新业务场景', required: true, input: '', steps: '', expected: '' };
      pipelineEditingCases.push(c.id); $('#pipeline-case-fields').insertAdjacentHTML('beforeend', pipelineCaseFields(c));
      const target = document.querySelector(`[data-case-id="${c.id}"]`); target.open = true; target.scrollIntoView({ block: 'center' });
    }
    if (action === 'pipeline-remove-case') {
      pipelineEditingCases = pipelineEditingCases.filter(id => id !== control.dataset.case); control.closest('[data-case-id]').remove();
    }
    if (action === 'iteration-check') iterationCheckModal(await api('/api/iteration-check'));
    if (action === 'iteration-check-run') {
      iterationCheckModal({ status: 'RUNNING', report: null });
      try { iterationCheckModal(await api('/api/iteration-check/run', {})); }
      catch (error) { iterationCheckModal(await api('/api/iteration-check')); throw error; }
    }
    if (action === 'platform-check') platformCheckModal(await api('/api/platform-check'));
    if (action === 'browser-check') browserCheckModal(await api('/api/browser-check'));
    if (action === 'browser-check-run') {
      browserCheckModal({ status: 'RUNNING', report: null });
      try { browserCheckModal(await api('/api/browser-check/run', {})); }
      catch (error) { browserCheckModal(await api('/api/browser-check')); throw error; }
    }
    if (action === 'platform-check-run') {
      platformCheckModal({ status: 'RUNNING', report: null });
      try { platformCheckModal(await api('/api/platform-check/run', {})); }
      catch (error) { platformCheckModal(await api('/api/platform-check')); throw error; }
    }
    if (action === 'readiness') { control.disabled = true; try { await readinessModal(id); } finally { control.disabled = false; } }
    if (action === 'issue-review') await issueReviewModal(id, control.dataset.tracking);
    if (action === 'list-page') {
      const key = control.dataset.list, offset = Number(control.dataset.offset);
      if (Object.hasOwn(listOffsets, key) && Number.isInteger(offset) && offset >= 0) {
        listOffsets[key] = offset;
        if (key === 'quality' && $('#quality-records')) $('#quality-records').outerHTML = qualityRecords(currentList(key)); else render();
      }
    }
    if (action === 'retry-list') {
      const key = control.dataset.list;
      if (Object.hasOwn(listOffsets, key)) { listRequests[key]?.controller.abort(); delete listRequests[key]; delete listData[key]; render(); }
    }
    if (action === 'runtime') {
      const health = await api('/api/health');
      modal('平台运行状态', `<p><span class="badge good">${e(health.status)}</span> CodeHealth ${e(health.version)} · ${e(health.node)}</p><div class="detail-grid">${stat('平台进程内存', num(health.memory.rssMB, ' MB'), '操作系统统计的当前常驻内存')}${stat('主服务 JavaScript 堆', num(health.memory.heapMB, ' MB'), '不包含检查线程的堆、浏览器与构建')}${stat('已运行', num(health.uptimeSeconds, ' 秒'), '当前服务进程')}</div><div class="notice">历史报告详情按需从磁盘读取，不常驻内存。以上读数只包含平台服务，不包含浏览器、JDK、Maven 或 SonarQube。</div><p class="subtle">数据目录：${e(health.storage.path)}<br>扫描 ${health.storage.scans} 次 · GitHub 检查 ${health.storage.githubReviews} 次<br>监听：127.0.0.1:${health.port}</p>`);
    }
    if (action === 'backup') {
      control.disabled = true; control.textContent = '正在创建备份…';
      const result = await api('/api/backup', {});
      modal('备份已创建', `<p><span class="badge good">已完成</span> ${result.files} 个文件 · 压缩后 ${(result.compressedBytes / 1024).toFixed(1)} KB</p><p class="subtle">备份包含本机报告和人工填写的内容。原件保存在数据目录的 backups 文件夹。</p><p><a class="button primary" href="${e(result.url)}" download="${e(result.file)}">下载备份</a></p><h3>在新电脑恢复</h3><p>解压平台迁移包，安装 Node.js 20+，打开平台目录中的终端，运行：</p><pre class="log">node scripts/restore-backup.js "备份文件的完整路径.jsonl.gz" "新数据目录的完整路径"</pre><p>目标目录必须不存在。恢复成功后，用新数据目录启动：</p><pre class="log">.\\scripts\\start.ps1 -DataDirectory "新数据目录的完整路径"</pre><p class="subtle">然后编辑项目路径与 JDK 配置，并重新填写需要的 Token。恢复失败不会覆盖已有数据。</p>`);
      control.disabled = false; control.textContent = '创建数据备份';
    }
    if (action === 'close') { cancelDetailRead(); $('#dialog').close(); }
    if (action === 'add-project') addProjectModal();
    if (action === 'freshness') {
      const result = await api('/api/freshness', { id });
      const target = document.querySelector('#source-freshness');
      if (target && target.dataset.id === id) target.innerHTML = freshnessResult(result);
    }
    if (action === 'archive-project' || action === 'restore-project') {
      await api(action === 'archive-project' ? '/api/projects/archive' : '/api/projects/restore', { id });
      if (selectedProject === id) selectedProject = '';
      await refresh(); toast(action === 'archive-project' ? '项目已归档；源码和报告保留，可在归档中心恢复。' : '项目已恢复。');
    }
    if (action === 'archive-report' || action === 'archive-selected') {
      const ids = action === 'archive-report' ? [id] : [...document.querySelectorAll('input[name="archive-report"]:checked')].map(input => input.value);
      if (!ids.length) throw new Error('请先选择要归档的旧报告。');
      await api('/api/reports/archive', { ids }); await refresh(); toast(`已归档 ${ids.length} 份报告，可在归档中心恢复。`);
    }
    if (action === 'restore-report') { await api('/api/reports/restore', { id }); await refresh(); toast('报告已恢复，按原检查时间排列。'); }
    if (action === 'archive-project-page') { archivedProjectOffset = Number(control.dataset.offset); render(); }
    if (action === 'edit-project') addProjectModal(state.projects.find(p => p.id === id));
    if (action === 'project-policy') projectPolicyModal(id);
    if (action === 'policy-strict') {
      const form = $('#policy-form');
      for (const name of ['requireBrief', 'requireFull', 'blockMedium', 'overrideGate']) form.elements[name].checked = true;
      form.elements.minTests.value = '1'; form.elements.coverage.value = '80'; form.elements.duplication.value = '3';
      toast('已填写建议，保存后生效。');
    }
    if (action === 'scan' || action === 'scan-project') scanModal(id);
    if (action === 'fixture') {
      control.disabled = true;
      // The server resolves this fixture's real location; no example result is pre-populated.
      const meta = await api('/api/fixture');
      let item = state.projects.find(p => p.key === 'java8-rule-fixture');
      if (!item) item = await api('/api/projects', { name: 'Java 8 规则验证示例', key: 'java8-rule-fixture', path: meta.path });
      await api('/api/scans', { projectId: item.id, mode: 'local' });
      await refresh(); location.hash = 'history'; toast('正在检查内置示例的真实源文件。示例包含故意设置的问题。');
    }
    if (action === 'project-issues' || action === 'project-history') { selectedProject = id; location.hash = action === 'project-issues' ? 'issues' : 'history'; render(); }
    if (action === 'scan-detail') await scanDetail(id);
    if (action === 'stop-scan') {
      control.disabled = true;
      await api('/api/scans/stop', { id }); await scanDetail(id); await refresh(false);
      toast('已请求停止；未完成结果不能作为通过或验收依据。');
    }
    if (action === 'github-detail') await githubDetail(id);
    if (action === 'acceptance') await acceptanceModal(id);
    if (action === 'coding-brief') await codingBriefModal(id);
    if (action === 'brief-preview') {
      const editing = $('#coding-brief-form');
      if (editing) await saveCodingBriefForm(editing);
      const result = await api('/api/coding-brief?projectId=' + encodeURIComponent(id));
      modal('可交给 AI 的任务说明', `<pre class="log">${e(result.markdown || '请先保存任务约定')}</pre><div class="form-actions">${button('返回编辑', 'coding-brief', `data-id="${id}"`)}${button('导出 Markdown', 'brief-export', `data-id="${id}"`, 'primary')}</div>`);
    }
    if (action === 'brief-export') {
      const result = await api('/api/coding-brief/export', { projectId: id });
      const link = document.createElement('a'); link.href = result.url; link.download = result.file; link.click();
      toast('任务说明已导出。');
    }
    if (action === 'select-pr') { $('#github-repository').value = githubPullData.repository; $('#github-number').value = id; $('#github-number').focus(); }
    if (action === 'github-clear-token') { await api('/api/github/token', { clear: true }); await refresh(); toast('GitHub Token 已清除。'); }
    if (action === 'preflight') { control.disabled = true; control.textContent = '检查中…'; await checkReady($('#scan-form')); control.textContent = '重新检查'; control.disabled = false; }
    if (action === 'tasks') await showTasks(id);
    if (action === 'tasks-page') {
      const offset = Number(control.dataset.offset);
      if (control.dataset.github === 'true') await githubDetail(id, offset); else await showTasks(id, offset);
    }
    if (action === 'tasks-latest') {
      const scan = selectedProject ? latest(selectedProject) : state.scans.find(s => s.status === 'completed' && s.scope !== 'changed');
      if (!scan) throw new Error('请先完成一次整个项目扫描。');
      await showTasks(scan.id);
    }
    if (action === 'export-tasks') await exportReport({ scanId: id, kind: 'tasks' });
    if (action === 'export-sarif') await exportReport({ scanId: id, kind: 'sarif' });
    if (action === 'baseline') { await api('/api/baseline', { projectId: project, scanId: id }); await refresh(); $('#dialog').close(); toast('已保存质量基线。'); }
    if (action === 'source') {
      const result = await api(`/api/source?project=${encodeURIComponent(project)}&file=${encodeURIComponent(file)}`);
      const rows = result.source.split('\n'), at = Number(line);
      modal('源文件位置', `<p class="subtle">${e(file)}:${issueLine(at)}</p><div class="source">${rows.map((row, i) => `<span class="source-line ${i + 1 === at ? 'highlight' : ''}"><span class="line-num">${i + 1}</span>${e(row)}</span>`).join('')}</div>`);
      $('#dialog .highlight')?.scrollIntoView({ block: 'center' });
    }
    if (action === 'export-issues') await exportReport({ projectId: selectedProject, severity, search, reviewStatus });
    if (action === 'export-scan') await exportReport({ scanId: id });
    if (action === 'environment') { control.disabled = true; control.textContent = '检查中…'; environmentData = await api('/api/environment'); render(); toast('环境检查完成。'); }
    if (action === 'clear-token') { await api('/api/settings', { settings: state.settings, clearToken: true }); await refresh(); toast('已清除当前进程中的 Token。'); }
    if (action === 'sonar-start' || action === 'sonar-stop') {
      control.disabled = true; control.textContent = '操作中…';
      const result = await api('/api/sonar-control', { action: action === 'sonar-start' ? 'start' : 'stop' });
      modal('服务操作结果', `<pre class="log">${e(result.logs)}</pre>`); render();
    }
  } catch (error) { if (error.name !== 'AbortError') toast(error.message); control.disabled = false; if (action === 'backup') control.textContent = '创建数据备份'; if (action === 'environment' || action.startsWith('sonar-')) render(); }
});
document.addEventListener('submit', async event => {
  if (event.target.getAttribute('id')?.startsWith('work-')) return;
  event.preventDefault(); const form = event.target; const data = new FormData(form); const submit = form.querySelector('[type="submit"]');
  // A field named "id" shadows HTMLFormElement.id; always read the actual attribute.
  const formId = form.getAttribute('id');
  form.querySelector('.form-error')?.remove();
  if (submit) submit.disabled = true;
  try {
    if (formId === 'pipeline-plan-form') {
      const requireFull = data.has('requireFull');
      const plan = { name: data.get('name'), confirmed: data.has('confirmed'), requireFull, requireBrief: data.has('requireBrief'), minTests: requireFull ? Number(data.get('minTests')) : 0, noSkipped: requireFull && data.has('noSkipped'),
        cases: pipelineEditingCases.map(id => ({ id, category: data.get(id + '-category'), required: data.has(id + '-required'), title: data.get(id + '-title'), input: data.get(id + '-input'), steps: data.get(id + '-steps'), expected: data.get(id + '-expected'), testRef: data.get(id + '-test-ref') || '' })) };
      await api('/api/pipeline/plan', { projectId: data.get('projectId'), expectedId: data.get('expectedId'), plan });
      $('#dialog').close(); await refresh(); toast(plan.confirmed ? '验收方案已保存，后续扫描绑定此版本。' : '方案草稿已保存，确认后才能按方案执行。');
    }
    if (formId === 'pipeline-result-form') {
      await api('/api/pipeline/result', { id: data.get('id'), caseId: data.get('caseId'), expectedRecordedAt: data.get('expectedRecordedAt'), result: { status: data.get('status'), actual: data.get('actual'), evidence: data.get('evidence') } });
      await refresh(false); await pipelineReportModal(data.get('id')); toast('场景结果已保存，验收结论按证据重新计算。');
    }
    if (formId === 'issue-review-form') {
      const saveRequest = beginDetailRead();
      await api('/api/issues/review', Object.fromEntries(data));
      if (!saveRequest.current()) { toast('审查记录已保存。'); return; }
      if (data.has('returnOffset')) {
        await refresh(false);
        if (!saveRequest.current()) return;
        const offset = Number(data.get('returnOffset'));
        if (data.get('returnGithub') === 'true') await githubDetail(data.get('id'), offset); else await showTasks(data.get('id'), offset);
      } else { $('#dialog').close(); await refresh(); }
      toast('审查记录已保存；自动门禁保持原检查结果。');
    }
    if (formId === 'policy-form') {
      const policy = { requireBrief: data.has('requireBrief'), requireFull: data.has('requireFull'), blockMedium: data.has('blockMedium'), minTests: Number(data.get('minTests')), gate: data.has('overrideGate') ? { coverage: Number(data.get('coverage')), duplication: Number(data.get('duplication')) } : null };
      await api('/api/projects/policy', { projectId: data.get('projectId'), policy });
      $('#dialog').close(); await refresh(); toast('项目质量约定已保存，之后的新扫描生效。');
    }
    if (formId === 'coding-brief-form') {
      const result = await saveCodingBriefForm(form);
      $('#dialog').close();
      toast(result.ready ? '任务约定已保存；之后的新扫描将绑定此版本。' : '草稿已保存，缺少：' + result.missing.join('、'));
    }
    if (formId === 'github-token-form') { await api('/api/github/token', { token: data.get('token') }); form.reset(); await refresh(); toast('GitHub Token 已保存在当前进程中。'); }
    if (formId === 'github-pulls-form') { githubRepository = data.get('repository'); githubPullData = await api('/api/github/pulls', { repository: githubRepository }); render(); }
    if (formId === 'github-review-form') {
      githubRepository = $('#github-repository').value;
      $('#github-progress').textContent = '正在读取固定提交的改动并检查；较大的 PR 需要一些时间…';
      const report = await api('/api/github/review', { repository: githubRepository, number: Number(data.get('number')) });
      await refresh(); await githubDetail(report.id); toast('PR 检查已完成，报告仅保存在本机。');
    }
    if (formId === 'acceptance-form') {
      const acceptance = Object.fromEntries(state.checklist.map(c => [c.id, { checked: data.has(c.id), evidence: data.get(`${c.id}-evidence`) }]));
      await api('/api/acceptance', { id: data.get('id'), acceptance }); $('#dialog').close(); await refresh(); toast('验收证据已保存。');
    }
    if (formId === 'project-form') { await api(data.get('id') ? '/api/projects/update' : '/api/projects', Object.fromEntries(data)); $('#dialog').close(); await refresh(); toast('项目已保存，可以开始本地规则检查。'); }
    if (formId === 'scan-form') { if (!await checkReady(form)) return; await api('/api/scans', scanRequest(form)); $('#dialog').close(); await refresh(); location.hash = 'history'; toast('扫描已开始。'); }
    if (formId === 'gate-form') { await api('/api/settings', { settings: { ...state.settings, gate: { coverage: Number(data.get('coverage')), duplication: Number(data.get('duplication')) } } }); await refresh(); toast('已保存，后续扫描将使用新的门禁阈值。'); }
    if (formId === 'rules-form') { await api('/api/settings', { settings: { ...state.settings, enabledRules: data.getAll('rules') } }); await refresh(); toast('规则已保存。'); }
    if (formId === 'settings-form') {
      await api('/api/settings', { settings: { ...state.settings, sonarUrl: data.get('sonarUrl'), java8Home: data.get('java8Home'), java21Home: data.get('java21Home') }, token: data.get('token') });
      await refresh(); toast('设置已保存。Token 仅保留在当前运行的进程中。');
    }
  } catch (error) {
    // Dialogs live above the toast layer: keep validation feedback inside the submitted form.
    const feedback = document.createElement('p'); feedback.className = 'notice red form-error'; feedback.setAttribute('role', 'alert'); feedback.textContent = error.message;
    form.insertBefore(feedback, form.querySelector('.form-actions'));
    toast(error.message); if ($('#github-progress')) $('#github-progress').textContent = '';
  } finally { if (submit) submit.disabled = false; }
});
document.addEventListener('change', event => {
  if (event.target.id === 'pipeline-project') { pipelineProjectId = event.target.value; render(); }
  if (event.target.id === 'pipeline-full') { const enabled = event.target.checked; $('#pipeline-min-tests').disabled = !enabled; $('#pipeline-no-skipped').disabled = !enabled; if (!enabled) { $('#pipeline-min-tests').value = 0; $('#pipeline-no-skipped').checked = false; } }
  if (event.target.id === 'filter-review') { reviewStatus = event.target.value; listOffsets.issues = 0; render(); }
  if (event.target.id === 'archive-project') { selectedProject = event.target.value; listOffsets.archives = 0; render(); }
  if (['filter-project', 'trend-project', 'filter-severity', 'history-status', 'history-mode'].includes(event.target.id)) { listOffsets.issues = 0; listOffsets.history = 0; }
  if (event.target.closest('#scan-form')) { if ($('#preflight-results')) $('#preflight-results').innerHTML = ''; }
  if (['filter-project', 'trend-project'].includes(event.target.id)) { selectedProject = event.target.value; render(); }
  if (event.target.id === 'filter-severity') { severity = event.target.value; render(); }
  if (event.target.id === 'history-status') { historyStatus = event.target.value; render(); }
  if (event.target.id === 'history-mode') { historyMode = event.target.value; render(); }
});
let searchTimer;
document.addEventListener('input', event => {
  if (event.target.id === 'issue-search') {
    listOffsets.issues = 0;
    search = event.target.value; clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { const position = event.target.selectionStart; render(); $('#issue-search')?.focus(); $('#issue-search')?.setSelectionRange(position, position); }, 250);
  }
});
window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0, behavior: 'instant' }); });
$('#dialog').addEventListener('click', event => { if (event.target === $('#dialog')) { const box = $('#dialog').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) { cancelDetailRead(); $('#dialog').close(); } } });
$('#dialog').addEventListener('cancel', cancelDetailRead);
$('#dialog').addEventListener('close', () => {
  // close 事件可能在新弹窗打开后才到达，不能清除刚打开的内容。
  if ($('#dialog').open) return;
  cancelDetailRead(); repairReturn = null; viewedScanId = null; viewedPipelineId = null;
  $('#dialog-content').replaceChildren(); workFormRow = null; workFormKind = null;
  pipelineEditingCases = []; pipelineEditingCategories = {};
});
$('#today').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
refresh().catch(error => { $('#content').innerHTML = empty('平台暂时不可用', e(error.message)); });

/** Show immutable snapshot evidence separately from an explicitly requested current file check. */
function sourceVersionPanel(report) {
  if (report.scope === 'github') return '';
  const saved = report.sourceSnapshot;
  return '<section class="notice"><h3>代码版本与报告一致性</h3><p>' + (saved ? '本次记录 ' + (saved.fileCount ?? saved.files?.length) + ' 个文件 · SHA-256 ' + e(saved.digest.slice(0, 16)) + '…' : '旧报告未记录代码指纹；请重新检查后验收。') + '</p>' + (saved ? '<p class="subtle">' + e(saved.scope) + '</p>' : '') + '<p>保存验收时会自动核对。结果只代表核对时刻；文件一致不代表业务正确或测试通过。</p>' + button('核对当前代码', 'freshness', 'data-id="' + report.id + '"') + '<div id="source-freshness" data-id="' + report.id + '">' + (report.acceptanceSourceCheck ? '<p>上次保存验收时：</p>' + freshnessResult(report.acceptanceSourceCheck) : '<p class="subtle">尚未核对当前文件。</p>') + '</div></section>';
}
/** Render bounded path-only changes without exposing source or credentials. */
function freshnessResult(result) {
  const names = { CURRENT: '核对时文件一致', STALE: '代码已变化 · 需要重新检查', UNKNOWN: '无法核实 · 不能确认当前版本' }, kinds = { added: '新增', removed: '删除', modified: '修改' };
  return '<p><strong>' + e(names[result.status]) + '</strong> · ' + e(time(result.checkedAt)) + '</p><p>' + e(result.reason) + '</p>' + (result.counts ? '<p>新增 ' + result.counts.added + ' · 修改 ' + result.counts.modified + ' · 删除 ' + result.counts.removed + (result.headChanged ? ' · Git 基准变化' : '') + '</p>' : '') + (result.changes?.length ? '<ul>' + result.changes.map(change => '<li>' + e(kinds[change.kind]) + '：' + e(change.file) + '</li>').join('') + '</ul><p class="subtle">最多展示 25 个变化路径。</p>' : '');
}
