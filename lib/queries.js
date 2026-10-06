const { summarize } = require('./report-store');
const { protectionReason } = require('./archives');
const { identify, states } = require('./issue-review');
const severities = ['HIGH', 'BLOCKER', 'CRITICAL', 'MEDIUM', 'MAJOR', 'LOW', 'MINOR', 'INFO'];

/** Validate query filters and page boundaries. Invalid values are errors, never silently ignored. */
function options(input = {}) {
  const result = { projectId: input.projectId || '', severity: input.severity || '', search: input.search || '', status: input.status || '', mode: input.mode || '' };
  for (const value of Object.values(result)) if (typeof value !== 'string') throw new Error('筛选条件格式不正确');
  if (result.search.length > 500) throw new Error('搜索内容不能超过 500 字');
  if (result.severity && !severities.includes(result.severity)) throw new Error('风险等级不正确');
  if (result.status && !['running', 'completed', 'failed'].includes(result.status)) throw new Error('执行状态不正确');
  if (result.mode && !['local', 'full', 'changed'].includes(result.mode)) throw new Error('检查方式不正确');
  result.reviewStatus = input.reviewStatus || '';
  if (result.reviewStatus && !states.includes(result.reviewStatus)) throw new Error('审查状态不正确');
  for (const [key, fallback, max] of [['offset', 0, 10000000], ['limit', 25, 100]]) {
    const raw = input[key] ?? fallback;
    if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max || (key === 'limit' && Number(raw) < 1)) throw new Error('分页参数不正确');
    result[key] = Number(raw);
  }
  return result;
}

/** Latest completed whole-project reports are the only source for dashboard and issue-center counts. */
function latestSummaries(state) {
  const registered = new Set(state.projects.filter(p => !p.archivedAt).map(p => p.id)), latest = new Map();
  for (const scan of state.scans) {
    if (registered.has(scan.projectId) && scan.status === 'completed' && scan.scope !== 'changed' && !latest.has(scan.projectId)) latest.set(scan.projectId, scan);
    if (latest.size === registered.size) break;
  }
  return state.projects.map(p => latest.get(p.id)).filter(Boolean);
}

/** Construct a bounded dashboard snapshot without reading a single report detail file. */
function compactState(state, runningScan) {
  const latest = latestSummaries(state), keep = new Set(state.scans.slice(0, 25).map(s => s.id));
  const counts = new Map(state.projects.filter(p => !p.archivedAt).map(p => [p.id, 0]));
  for (const item of state.projects) if (item.baselineId) keep.add(item.baselineId);
  for (const scan of state.scans) {
    const count = counts.get(scan.projectId);
    if (count !== undefined && count < 12 && scan.status === 'completed' && scan.scope !== 'changed') { keep.add(scan.id); counts.set(scan.projectId, count + 1); }
  }
  for (const scan of latest) keep.add(scan.id);
  // Keep each project's latest attempt even when many other projects have newer reports.
  const attempts = new Set();
  for (const scan of state.scans) if (!attempts.has(scan.projectId)) { attempts.add(scan.projectId); keep.add(scan.id); }
  let issues = 0, high = 0;
  for (const scan of latest) { issues += scan.issueCount || 0; high += ['HIGH', 'CRITICAL', 'BLOCKER'].reduce((sum, key) => sum + (scan.severityCounts?.[key] || 0), 0); }
  return { projects: state.projects, settings: state.settings,
    scans: state.scans.filter(s => keep.has(s.id)).map(s => runningScan?.id === s.id ? summarize(runningScan) : s),
    stats: { issues, highRisk: high, scans: state.scans.length, githubReviews: state.githubReviews.length, archivedReports: state.archivedReports?.length || 0, archivedProjects: state.projects.filter(p => p.archivedAt).length } };
}

/** Shared matcher keeps page searches and full exports consistent, including redacted code evidence. */
function issueMatches(issue, filters) {
  return (!filters.projectId || issue.projectId === filters.projectId) && (!filters.severity || issue.severity === filters.severity) &&
    (!filters.reviewStatus || (issue.review?.status || 'open') === filters.reviewStatus) &&
    `${issue.message} ${issue.file} ${issue.rule} ${issue.excerpt || ''}`.toLowerCase().includes(filters.search.toLowerCase());
}

/** Read one latest report at a time. Older histories, partial scans and unrelated projects are not loaded. */
async function* matchingIssues(state, loadReport, filters) {
  const selected = latestSummaries(state).filter(s => !filters.projectId || s.projectId === filters.projectId);
  for (const summary of selected) {
    const report = await loadReport(summary.id);
    for (const issue of identify(report)) {
      const row = { ...issue, projectId: summary.projectId, scanId: summary.id };
      if (issueMatches(row, filters)) yield row;
    }
  }
}

/** Count all matches while retaining at most two pages; out-of-range requests clamp to the final page. */
async function issuePage(state, loadReport, filters) {
  let total = 0;
  const rows = [], tail = [];
  for await (const row of matchingIssues(state, loadReport, filters)) {
    if (total >= filters.offset && rows.length < filters.limit) rows.push(row);
    tail.push(row); if (tail.length > filters.limit) tail.shift(); total++;
  }
  let offset = filters.offset;
  if (!total) offset = 0;
  else if (offset >= total) { offset = Math.floor((total - 1) / filters.limit) * filters.limit; return { rows: tail.slice(tail.length - (total - offset)), total, offset, limit: filters.limit }; }
  return { rows, total, offset, limit: filters.limit };
}

/** Page lightweight history summaries; quality history includes only completed reviewable reports. */
function historyPage(state, filters, kind = 'scan', runningScan) {
  if (!['scan', 'quality'].includes(kind)) throw new Error('历史类型不正确');
  const source = kind === 'quality' ? [...state.scans.filter(s => s.status === 'completed'), ...state.githubReviews].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) : state.scans;
  const matching = source.filter(s => (!filters.projectId || filters.projectId === s.projectId) && (!filters.status || filters.status === s.status) &&
    (!filters.mode || (filters.mode === 'changed' ? s.scope === 'changed' : s.mode === filters.mode && s.scope !== 'changed')));
  const total = matching.length, offset = Math.min(filters.offset, Math.max(0, Math.ceil(total / filters.limit) - 1) * filters.limit);
  return { rows: matching.slice(offset, offset + filters.limit).map(s => ({ ...(runningScan?.id === s.id ? summarize(runningScan) : s), archiveProtection: protectionReason(state, s) })), total, offset, limit: filters.limit };
}
module.exports = { options, latestSummaries, compactState, issueMatches, matchingIssues, issuePage, historyPage };
