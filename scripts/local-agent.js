const fs = require('node:fs/promises');

/** agent 只连接本机平台。认证由环境变量提供，避免把凭据写进命令历史或任务文档。 */
async function main() {
  const base = new URL(process.env.HEALTH_PLATFORM_URL || 'http://127.0.0.1:4310');
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw Error('仅允许本机 HTTP 平台地址');
  const token = process.env.HEALTH_AGENT_TOKEN;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token || '')) throw Error('请先设置平台授权的 HEALTH_AGENT_TOKEN');
  const [command, taskId, extra, file] = process.argv.slice(2);
  /** 固定 API 请求，连接/读取 30 秒超时；不执行任务内容中的命令。 */
  async function request(route, data) {
    const response = await fetch(new URL('/api/agent/' + route, base), { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(30000) });
    const result = await response.json(); if (!response.ok) throw Error(result.error || `请求失败 ${response.status}`); return result;
  }
  /** 读取有界证据文件；文件路径只是本地输入，不发送给平台执行。 */
  async function input(name) { if (!name) throw Error('请使用 --file 指定 JSON 文件'); const s = await fs.stat(name); if (!s.isFile() || s.size > 32000) throw Error('证据 JSON 文件最多 32 KB'); return JSON.parse(await fs.readFile(name, 'utf8')); }
  let result;
  if (command === 'list' || command === 'knowledge-list') {
    const args = process.argv.slice(3), query = new URLSearchParams({ kind: command === 'list' ? 'tasks' : 'knowledge' });
    const options = { '--project': 'projectId', '--status': 'status', '--offset': 'offset', '--search': 'search' };
    for (let i = 0; i < args.length; i += 2) { if (!options[args[i]] || args[i + 1] === undefined || query.has(options[args[i]])) throw Error('列表参数不正确'); query.set(options[args[i]], args[i + 1]); }
    result = await request('list?' + query);
  }
  else if (command === 'knowledge' && taskId === '--file' && extra && !file) result = await request('save', { kind: 'knowledge', record: await input(extra) });
  else if (['context', 'claim', 'heartbeat', 'release', 'submit'].includes(command) && /^[a-f0-9-]{36}$/.test(taskId || '')) {
    const context = await request('context?id=' + taskId);
    if (command === 'context') { if (extra) throw Error('不支持额外参数'); result = context; }
    else {
      const data = { id: taskId, expectedVersion: context.task.version, action: command };
      if (command === 'release') data.reason = '本地 agent 主动释放任务，交由后续参与者处理';
      if (command === 'submit') { if (extra !== '--file') throw Error('提交需指定 --file'); data.submission = await input(file); }
      else if (extra) throw Error('不支持额外参数');
      result = await request('task', data);
    }
  } else throw Error('用法：list/knowledge-list [--project ID --status STATUS --search TEXT --offset N] | context/claim/heartbeat/release TASK_ID | submit TASK_ID --file evidence.json | knowledge --file draft.json');
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
