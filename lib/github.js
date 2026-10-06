const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { catalog } = require('./rules');
const { scanInWorker } = require('./scanner');

/** Accept only github.com owner/repository names; no arbitrary URL is sent credentials. */
function repository(value) {
  const name = String(value || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(name) || name.split('/')[1] === '..') throw new Error('请输入 GitHub 仓库，例如 owner/repository');
  return name;
}

/** GET-only GitHub client with fixed origin, bounded response, timeout, and no redirect credentials. */
async function request(endpoint, token = '') {
  if (!endpoint.startsWith('/repos/') || endpoint.includes('://')) throw new Error('GitHub 请求地址不正确');
  const response = await fetch(`https://api.github.com${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CodeHealth-local', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  if (!response.ok) throw new Error(({ 401: 'GitHub Token 无效或已过期', 403: 'GitHub 权限不足或请求额度已用尽', 404: '仓库 / PR 不存在，或 Token 无权访问' })[response.status] || `GitHub 请求失败 (${response.status})`);
  let size = 0, parts = [];
  for await (const part of response.body) { size += part.length; if (size > 8 * 1024 * 1024) throw new Error('GitHub 响应过大，请缩小改动范围'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

/** Return at most the latest 30 open PRs; caller explicitly picks a number to review. */
async function listPulls(repo, token, get = request) {
  repo = repository(repo);
  const pulls = await get(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`, token);
  return { repository: repo, limit: 30, pulls: pulls.map(p => ({ number: p.number, title: p.title, author: p.user?.login, draft: p.draft })) };
}

/** Parse changed head lines, including adjacent surviving context for pure deletions. */
function patchRanges(patch) {
  const ranges = [];
  let line = null;
  for (const row of String(patch || '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (line === null) continue;
    if (row.startsWith('+')) { ranges.push([line, line]); line++; }
    else if (row.startsWith('-')) ranges.push([Math.max(1, line - 1), Math.max(1, line)]);
    else if (row.startsWith(' ')) line++;
  }
  return ranges;
}

/** Review Java/SQL head snapshots locally, never running code; reports retain SHAs, not downloaded sources. */
async function reviewPull(repo, number, token, enabled = catalog.map(r => r.id), get = request) {
  repo = repository(repo);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('PR 编号必须是正整数');
  const endpoint = `/repos/${repo}/pulls/${number}`;
  const pr = await get(endpoint, token);
  if (!/^[a-f0-9]{40,64}$/.test(pr.head?.sha || '') || !/^[a-f0-9]{40,64}$/.test(pr.base?.sha || '')) throw new Error('PR 提交信息不完整');
  if (!pr.head.repo) throw new Error('PR 来源仓库已删除，无法读取代码');
  const headRepo = repository(pr.head.repo.full_name);
  if (pr.changed_files > 100) throw new Error('本次 PR 超过 100 个文件，请拆分后检查');
  const files = await get(`${endpoint}/files?per_page=100`, token);
  if (!Array.isArray(files) || files.length !== pr.changed_files) throw new Error('PR 文件列表不完整，请重新检查或拆分改动');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codehealth-pr-'));
  const notes = [], ranges = new Map();
  let bytes = 0, checkedFiles = 0;
  try {
    for (const file of files) {
      if (!/\.(java|sql)$/i.test(file.filename)) continue;
      if (file.status === 'removed') { notes.push(`已删除文件需要人工审查：${file.filename}`); continue; }
      if (!file.patch || !patchRanges(file.patch).length) { notes.push(`缺少可用差异，未检查：${file.filename}`); continue; }
      const patchRows = file.patch.split('\n');
      if (patchRows.filter(r => r.startsWith('+')).length !== file.additions || patchRows.filter(r => r.startsWith('-')).length !== file.deletions) { notes.push(`差异不完整，未检查：${file.filename}`); continue; }
      if (file.filename.includes('\\') || file.filename.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(file.filename) || file.filename.includes(':')) throw new Error('PR 文件路径不安全');
      if (file.filename.split('/').some(p => ['.git', '.idea', '.codegraph', 'target', 'node_modules', 'data', 'build'].includes(p))) { notes.push(`构建或排除目录未检查：${file.filename}`); continue; }
      const content = await get(`/repos/${headRepo}/contents/${file.filename.split('/').map(encodeURIComponent).join('/')}?ref=${pr.head.sha}`, token);
      if (content.type !== 'file' || content.encoding !== 'base64' || !content.content || content.sha !== file.sha || content.size > 1024 * 1024) { notes.push(`文件过大或快照无法核实，未检查：${file.filename}`); continue; }
      const source = Buffer.from(content.content, 'base64');
      const blobSha = crypto.createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
      if (blobSha !== file.sha) throw new Error('源码内容与 PR 文件快照不一致，请重新检查');
      bytes += source.length;
      if (bytes > 8 * 1024 * 1024 || source.length > 1024 * 1024) throw new Error('PR 源码超过检查上限，请拆分改动');
      const target = path.join(root, ...file.filename.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, source);
      ranges.set(file.filename, patchRanges(file.patch)); checkedFiles++;
    }
    const local = await scanInWorker(root, enabled);
    const issues = local.issues.filter(i => ['large-service', 'migration-version'].includes(i.rule) || (ranges.get(i.file) || []).some(([a, b]) => i.line <= b && (i.endLine || i.line) >= a));
    const current = await get(endpoint, token);
    if (current.head?.sha !== pr.head.sha || current.base?.sha !== pr.base.sha || current.changed_files !== pr.changed_files) throw new Error('检查过程中 PR 已更新，请重新检查最新提交');
    if (!checkedFiles) notes.push('没有可检查的 Java / SQL 改动');
    notes.push('只检查 PR 改动行及删除附近的上下文；不包含编译、测试、覆盖率或整个项目的迁移冲突。');
    const incomplete = files.some(f => /\.(java|sql)$/i.test(f.filename) && f.status !== 'removed' && !ranges.has(f.filename));
    const high = issues.some(i => i.severity === 'HIGH');
    const touchedTests = files.filter(f => f.status !== 'removed' && /(?:^|\/)(?:test|tests)(?:\/|$)|(?:Test|Tests)\.java$/i.test(f.filename)).length;
    if (!touchedTests) notes.push('本次 PR 未发现测试文件改动，请确认已有测试是否覆盖新的行为。');
    return { id: crypto.randomUUID(), repository: repo, number, title: pr.title, url: `https://github.com/${repo}/pull/${number}`, headSha: pr.head.sha, baseSha: pr.base.sha,
      startedAt: new Date().toISOString(), status: 'completed', scope: 'github', mode: 'local', issues, checkedFiles, changedFiles: files.length, touchedTests, notes,
      settings: { enabledRules: [...enabled], localRuleVersion: 3 }, gate: { status: high ? 'FAILED' : incomplete || !checkedFiles ? 'UNKNOWN' : 'PASSED' } };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
module.exports = { repository, request, listPulls, patchRanges, reviewPull };
