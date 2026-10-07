const crypto = require('node:crypto');
// 只绑定不可变索引；旧提交不再被引用时，其最多 64 个小型标记也可回收。
const views = new WeakMap();
const maxViews = 64;

/** doc 为已提交工作区；仅保留同步必需的有界元数据，不保留正文、历史或凭据。 */
function syncIndex(doc) {
  const result = { revision: doc.revision };
  for (const kind of ['requirements', 'tasks', 'knowledge']) result[kind] = Object.freeze(doc[kind].map(row => Object.freeze({
    id: row.id, projectId: row.projectId, version: row.version, status: row.status,
    requirementId: row.requirementId || '',
    expiresAt: row.status === 'in_progress' && row.claim?.actor.type === 'agent' ? Date.parse(row.claim.expiresAt) : null
  })));
  Object.freeze(result); views.set(result, new Map());
  return result;
}

/** projectIds 为可见项目集合，null 表示人工全部项目；now 用于识别无写入的租约到期。
 * publishedOnly 使 agent 的知识同步只反映已发布内容；返回值不暴露记录或全局版本。
 */
function syncView(index, kind, projectIds = null, publishedOnly = false, now = Date.now()) {
  // 范围键仅保留最多 31 个项目编号，不存正文或凭据；未知/可变索引继续直接计算。
  const cache = views.get(index);
  const bounded = !projectIds || (projectIds.length <= 31 && projectIds.every(id => typeof id === 'string' && id.length <= 36));
  const key = cache && bounded ? JSON.stringify([kind, projectIds ? [...new Set(projectIds)].sort() : null, !!publishedOnly]) : null;
  const saved = key && cache.get(key);
  // 精确到期时必须重算；系统时钟回退也不能沿用后来时刻的领取判断。
  if (saved && now >= saved.from && now < saved.until) return { token: saved.token };
  const visible = row => !projectIds || projectIds.includes(row.projectId);
  const rows = index[kind].filter(row => visible(row) && (!publishedOnly || row.status === 'published'));
  const values = rows.map(row => [row.id, row.version, row.expiresAt !== null && row.expiresAt <= now]);
  // 需求列表的完成数量取决于任务状态和绑定版本，不能只核对需求本身。
  if (kind === 'requirements') {
    const ids = new Set(rows.map(row => row.id));
    values.push(...index.tasks.filter(row => ids.has(row.requirementId)).map(row => [row.id, row.version]));
  }
  // 任务的可领取状态依赖当前需求；需求更新即使不改任务，也必须通知参与者重读。
  if (kind === 'tasks') {
    const ids = new Set(rows.map(row => row.requirementId).filter(Boolean));
    values.push(...index.requirements.filter(row => ids.has(row.id)).map(row => [row.id, row.version]));
  }
  const token = crypto.createHash('sha256').update(JSON.stringify([kind, values])).digest('hex');
  if (key) {
    const until = rows.reduce((next, row) => row.expiresAt !== null && row.expiresAt > now ? Math.min(next, row.expiresAt) : next, Infinity);
    if (!cache.has(key) && cache.size >= maxViews) cache.delete(cache.keys().next().value);
    cache.set(key, { token, from: now, until });
  }
  return { token };
}

module.exports = { syncIndex, syncView };
