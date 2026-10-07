const crypto = require('node:crypto');

/** doc 为已提交工作区；仅保留同步必需的有界元数据，不保留正文、历史或凭据。 */
function syncIndex(doc) {
  const result = { revision: doc.revision };
  for (const kind of ['requirements', 'tasks', 'knowledge']) result[kind] = doc[kind].map(row => ({
    id: row.id, projectId: row.projectId, version: row.version, status: row.status,
    requirementId: row.requirementId || '',
    expiresAt: row.status === 'in_progress' && row.claim?.actor.type === 'agent' ? Date.parse(row.claim.expiresAt) : null
  }));
  return result;
}

/** projectIds 为可见项目集合，null 表示人工全部项目；now 用于识别无写入的租约到期。
 * publishedOnly 使 agent 的知识同步只反映已发布内容；返回值不暴露记录或全局版本。
 */
function syncView(index, kind, projectIds = null, publishedOnly = false, now = Date.now()) {
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
  return { token: crypto.createHash('sha256').update(JSON.stringify([kind, values])).digest('hex') };
}

module.exports = { syncIndex, syncView };
