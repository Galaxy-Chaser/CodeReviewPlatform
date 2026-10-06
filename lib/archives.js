const fs = require('node:fs/promises');
const path = require('node:path');

/** Keep archived report metadata on disk; only IDs remain in the resident index. */
class ArchiveStore {
  constructor(root) { this.directory = path.join(root, 'archives'); }
  /** Convert a validated report ID to a local archive metadata path. */
  file(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error('报告编号不正确');
    return path.join(this.directory, id + '.json');
  }
  /** Persist compact metadata before the caller commits its index change. */
  async put(summary, archivedAt) {
    const file = this.file(summary.id); await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify({ ...summary, archivedAt })); await fs.rename(file + '.tmp', file);
  }
  /** Read one archived summary, without retaining a report cache. */
  async get(id) { const value = JSON.parse(await fs.readFile(this.file(id), 'utf8')); if (value.id !== id || !value.archivedAt) throw new Error('归档摘要不正确'); return value; }
}

/** Explain why a report must stay visible: latest attempts, latest completed whole scans, baselines and latest PR snapshots. */
function protectionReason(state, report) {
  if (report.status === 'running') return '检查正在运行';
  if (state.projects.some(p => p.baselineId === report.id)) return '项目基线';
  if (report.scope === 'github') {
    if (state.githubReviews.find(r => r.repository === report.repository && r.number === report.number)?.id === report.id) return '此 PR 的最新检查';
  } else {
    if (state.scans.find(r => r.projectId === report.projectId)?.id === report.id) return '项目最新一次检查';
    if (state.scans.find(r => r.projectId === report.projectId && r.status === 'completed' && r.scope !== 'changed')?.id === report.id) return '项目最新完整范围结果';
  }
  return '';
}

/** Archive 1–100 selected old reports under an exclusive mutation reservation. Details remain unchanged and recoverable. */
async function archiveReports(state, ids, store) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length) throw new Error('请选择 1 到 100 个不重复的旧报告');
  const reports = ids.map(id => {
    const report = [...state.scans, ...state.githubReviews].find(r => r.id === id);
    if (!report) throw new Error('报告不存在或已经归档');
    const reason = protectionReason(state, report); if (reason) throw new Error(`不能归档：${reason}`);
    return report;
  });
  const archivedAt = new Date().toISOString();
  for (const report of reports) await store.put(report, archivedAt);
  const selected = new Set(ids);
  state.scans = state.scans.filter(r => !selected.has(r.id)); state.githubReviews = state.githubReviews.filter(r => !selected.has(r.id));
  state.archivedReports = [...ids, ...(state.archivedReports || [])];
  return { count: ids.length };
}

/** Restore metadata in timestamp order; stable sorting keeps current records ahead of restored ties. */
async function restoreReport(state, id, store) {
  if (!state.archivedReports?.includes(id)) throw new Error('报告未归档');
  const summary = await store.get(id); delete summary.archivedAt;
  const collection = summary.scope === 'github' ? state.githubReviews : state.scans;
  collection.push(summary); collection.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  state.archivedReports = state.archivedReports.filter(value => value !== id);
  return summary;
}

/** Page archives in newest archive order, reading one summary at a time with bounded result/tail storage. */
async function archivedPage(state, filters, store) {
  let total = 0; const rows = [], tail = [];
  for (const id of state.archivedReports || []) {
    const row = await store.get(id);
    if (filters.projectId && row.projectId !== filters.projectId || filters.status && row.status !== filters.status || filters.mode && (filters.mode === 'changed' ? row.scope !== 'changed' : row.mode !== filters.mode || row.scope === 'changed')) continue;
    if (total >= filters.offset && rows.length < filters.limit) rows.push(row);
    tail.push(row); if (tail.length > filters.limit) tail.shift(); total++;
  }
  let offset = filters.offset;
  if (!total) offset = 0;
  else if (offset >= total) { offset = Math.floor((total - 1) / filters.limit) * filters.limit; return { rows: tail.slice(-(total - offset)), total, offset, limit: filters.limit }; }
  return { rows, total, offset, limit: filters.limit };
}
module.exports = { ArchiveStore, protectionReason, archiveReports, restoreReport, archivedPage };
