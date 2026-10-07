const { states } = require('./issue-review');
const riskGroups = { BLOCKER: 'high', CRITICAL: 'high', HIGH: 'high', MAJOR: 'medium', MEDIUM: 'medium', MINOR: 'low', LOW: 'low', INFO: 'low' };

/** issue 是原始发现；未知风险保留为 unknown，不推断或降低原始严重性。 */
function riskOf(issue) { return Object.hasOwn(riskGroups, issue.severity) ? riskGroups[issue.severity] : 'unknown'; }
/** 缺少审查状态表示尚未审查；非法旧状态不能当作已确认或已排除。 */
function reviewOf(issue) { const status = issue.review?.status ?? 'open'; return states.includes(status) ? status : 'unknown'; }

/** report 为完整保存记录或运行中的记录；返回固定大小计数，不保留正文、位置列表或历史。 */
function findingSummary(report) {
  if (!Array.isArray(report.issues)) return { available: false, complete: false };
  const risk = { high: 0, medium: 0, low: 0, unknown: 0 }, review = { open: 0, confirmed: 0, fixing: 0, dismissed: 0, unknown: 0 };
  const files = new Set(); let missingFiles = 0;
  for (const issue of report.issues) {
    risk[riskOf(issue)]++; review[reviewOf(issue)]++;
    if (typeof issue.file === 'string' && issue.file.trim()) files.add(issue.file); else missingFiles++;
  }
  return { available: true, complete: report.status === 'completed', total: report.issues.length, files: files.size, missingFiles, risk, review };
}

/** values 只允许风险组和审查状态；未提供时查看全部，拒绝非法或含糊的筛选。 */
function findingFilters(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !['risk', 'review'].includes(key))) throw Error('修复清单筛选格式不正确');
  const risk = values.risk === undefined ? 'all' : values.risk, review = values.review === undefined ? 'all' : values.review;
  if (!['all', 'high', 'medium', 'low'].includes(risk)) throw Error('风险筛选不正确');
  if (!['all', 'active', ...states].includes(review)) throw Error('审查筛选不正确');
  return { risk, review };
}

/** issue 为原记录，filters 已校验；未排除包括未知状态，筛选不改写风险或人工判断。 */
function matchesFinding(issue, filters) {
  const review = reviewOf(issue);
  return (filters.risk === 'all' || riskOf(issue) === filters.risk) &&
    (filters.review === 'all' || (filters.review === 'active' ? review !== 'dismissed' : review === filters.review));
}
module.exports = { findingSummary, findingFilters, matchesFinding };
