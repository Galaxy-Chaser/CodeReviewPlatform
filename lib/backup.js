const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { createGzip, createGunzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { acquireDataLock } = require('./data-lock');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const allowed = new RegExp(`^(?:state(?:-before-details)?\\.json|work/workspace\\.json|(?:details|briefs|archives|pipelines)/${uuid}\\.json|reports/(?:(?:report|tasks|issues|brief|pipeline)-${uuid}\\.(?:json|md)|sarif-${uuid}\\.sarif|browser-${uuid}-[a-z0-9-]{1,40}\\.png))$`);
const maxFileBytes = 32 * 1024 * 1024, maxTotalBytes = 2 * 1024 * 1024 * 1024;

/** Select persisted data referenced by a stable index, plus existing report exports; credentials and previous backups are excluded. */
async function selectedFiles(root, state) {
  const names = new Set(['state.json']);
  try { await fs.access(path.join(root, 'work', 'workspace.json')); names.add('work/workspace.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.iterationCheckId) {
    names.add(`reports/report-${state.iterationCheckId}.json`);
    const report = JSON.parse(await fs.readFile(path.join(root, 'reports', `report-${state.iterationCheckId}.json`), 'utf8'));
    // 本轮引用的分项证据必须完整存在，不能仅备份一个“通过”结论。
    for (const part of [report.platform, report.browser].filter(Boolean)) names.add(`reports/report-${part.id}.json`);
    for (const image of report.browser?.images || []) {
      if (!new RegExp(`^browser-${report.browser.id}-[a-z0-9-]{1,40}\\.png$`).test(image)) throw Error('本轮验收截图路径不正确');
      names.add('reports/' + image);
    }
  }
  if (state.platformCheckId) names.add(`reports/report-${state.platformCheckId}.json`);
  if (state.browserCheckId) names.add(`reports/report-${state.browserCheckId}.json`);
  if (state.browserCheckId) {
    const report = JSON.parse(await fs.readFile(path.join(root, 'reports', `report-${state.browserCheckId}.json`), 'utf8'));
    for (const image of report.images || []) {
      if (!new RegExp(`^browser-${state.browserCheckId}-[a-z0-9-]{1,40}\\.png$`).test(image)) throw Error('页面回归截图路径不正确');
      names.add('reports/' + image);
    }
  }
  for (const report of [...state.scans, ...state.githubReviews]) names.add(`details/${report.id}.json`);
  for (const id of state.archivedReports || []) { names.add(`details/${id}.json`); names.add(`archives/${id}.json`); }
  for (const project of state.projects) if (project.codingBrief) names.add(`briefs/${project.codingBrief.id}.json`);
  for (const project of state.projects) if (project.pipelinePlan) names.add(`pipelines/${project.pipelinePlan.id}.json`);
  try { await fs.access(path.join(root, 'state-before-details.json')); names.add('state-before-details.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of await fs.readdir(path.join(root, 'reports'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (entry.isFile() && allowed.test('reports/' + entry.name)) names.add('reports/' + entry.name);
  }
  for (const name of names) if (!allowed.test(name)) throw new Error('备份文件编号不正确');
  return [...names];
}

/** Create an atomic compressed snapshot using 64 KB source chunks. Caller must hold the directory lock and freeze mutations. */
async function createBackup(root, state) {
  const file = `backup-${crypto.randomUUID()}.jsonl.gz`, directory = path.join(root, 'backups');
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, file), names = await selectedFiles(root, state);
  let total = 0;
  async function* records() {
    yield JSON.stringify({ format: 'CodeHealthBackup', version: 1, createdAt: new Date().toISOString(), files: names.length }) + '\n';
    for (const name of names) {
      const source = path.join(root, name), stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) throw new Error('备份文件过大或不是普通文件：' + name);
      yield JSON.stringify({ file: name, bytes: stat.size }) + '\n';
      const hash = crypto.createHash('sha256'); let bytes = 0;
      for await (const chunk of createReadStream(source, { highWaterMark: 65536 })) {
        bytes += chunk.length; total += chunk.length;
        if (bytes > maxFileBytes || total > maxTotalBytes) throw new Error('备份超过大小上限');
        hash.update(chunk); yield JSON.stringify({ data: chunk.toString('base64') }) + '\n';
      }
      if (bytes !== stat.size) throw new Error('备份期间文件发生变化：' + name);
      yield JSON.stringify({ end: name, sha256: hash.digest('hex') }) + '\n';
    }
    yield JSON.stringify({ done: true, files: names.length, bytes: total }) + '\n';
  }
  try { await pipeline(records(), createGzip(), createWriteStream(destination + '.tmp', { flags: 'wx' })); await fs.rename(destination + '.tmp', destination); }
  catch (error) { await fs.unlink(destination + '.tmp').catch(() => {}); throw error; }
  return { file, files: names.length, bytes: total, compressedBytes: (await fs.stat(destination)).size, url: `/api/export-file?file=${file}` };
}

/** Parse bounded archive lines after decompression; arbitrary long lines are rejected before JSON parsing. */
async function* archiveLines(stream) {
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk.toString('utf8');
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      if (at > 100000) throw new Error('备份记录过大');
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      yield JSON.parse(line);
    }
    if (pending.length > 100000) throw new Error('备份记录过大');
  }
  if (pending) throw new Error('备份记录未完整结束');
}

/** Verify references before exposing restored data; at most one report's JSON is loaded at a time. */
async function validateRestored(root) {
  const state = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
  if (state.storageVersion !== 1 || !Array.isArray(state.projects) || !Array.isArray(state.scans) || !Array.isArray(state.githubReviews) || !state.settings) throw new Error('备份中的索引格式不正确');
  const settings = state.settings;
  let sonar; try { sonar = new URL(settings.sonarUrl); } catch { throw new Error('备份环境设置不正确'); }
  if (sonar.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(sonar.hostname) || sonar.username || sonar.password || typeof settings.java8Home !== 'string' || typeof settings.java21Home !== 'string' || !['coverage', 'duplication'].every(key => Number.isFinite(settings.gate?.[key]) && settings.gate[key] >= 0 && settings.gate[key] <= 100) || !Array.isArray(settings.enabledRules) || settings.enabledRules.some(id => !require('./rules').catalog.some(r => r.id === id))) throw new Error('备份环境设置不正确');
  const projectIds = new Set(), projectKeys = new Set(), reportIds = new Set();
  if (state.iterationCheckId) {
    if (!new RegExp('^' + uuid + '$').test(state.iterationCheckId)) throw Error('本轮验收报告编号不正确');
    const report = JSON.parse(await fs.readFile(path.join(root, 'reports', `report-${state.iterationCheckId}.json`), 'utf8'));
    if (report.id !== state.iterationCheckId || report.kind !== 'iteration' || !['PASSED', 'FAILED'].includes(report.status)) throw Error('本轮验收报告引用不正确');
    for (const part of [report.platform, report.browser].filter(Boolean)) {
      if (!new RegExp('^' + uuid + '$').test(part.id)) throw Error('本轮分项报告编号不正确');
      const saved = JSON.parse(await fs.readFile(path.join(root, 'reports', `report-${part.id}.json`), 'utf8'));
      if (JSON.stringify(saved) !== JSON.stringify(part)) throw Error('本轮分项报告内容不一致');
    }
    for (const image of report.browser?.images || []) {
      if (!new RegExp(`^browser-${report.browser.id}-[a-z0-9-]{1,40}\\.png$`).test(image)) throw Error('本轮验收截图路径不正确');
      await fs.access(path.join(root, 'reports', image));
    }
  }
  if (state.platformCheckId) {
    if (!new RegExp('^' + uuid + '$').test(state.platformCheckId)) throw Error('平台自检报告编号不正确');
    const report = JSON.parse(await fs.readFile(path.join(root, 'reports', `report-${state.platformCheckId}.json`), 'utf8'));
    if (report.id !== state.platformCheckId || !['PASSED', 'FAILED'].includes(report.status)) throw Error('平台自检报告引用不正确');
  }
  if (state.browserCheckId) {
    if (!new RegExp('^' + uuid + '$').test(state.browserCheckId)) throw Error('页面回归报告编号不正确');
    const report = JSON.parse(await fs.readFile(path.join(root, 'reports', `report-${state.browserCheckId}.json`), 'utf8'));
    if (report.id !== state.browserCheckId || report.kind !== 'browser' || !['PASSED', 'FAILED'].includes(report.status)) throw Error('页面回归报告引用不正确');
    for (const image of report.images || []) {
      if (!new RegExp(`^browser-${state.browserCheckId}-[a-z0-9-]{1,40}\\.png$`).test(image)) throw Error('页面回归截图路径不正确');
      await fs.access(path.join(root, 'reports', image));
    }
  }
  for (const project of state.projects) {
    if (!new RegExp('^' + uuid + '$').test(project.id) || typeof project.name !== 'string' || typeof project.key !== 'string' || typeof project.path !== 'string' || projectIds.has(project.id) || projectKeys.has(project.key)) throw new Error('备份项目列表不正确');
    projectIds.add(project.id); projectKeys.add(project.key);
    if (project.codingBrief && (typeof project.codingBrief.ready !== 'boolean' || !Array.isArray(project.codingBrief.missing))) throw new Error('备份任务约定摘要不正确');
    if (project.policy) require('./project-policy').validatePolicy(project.policy);
  }
  if (state.archivedReports !== undefined && !Array.isArray(state.archivedReports)) throw new Error('归档索引不正确');
  const archiveStore = new (require('./archives').ArchiveStore)(root);
  // Read archived summaries individually so restoring a large history does not load its metadata together.
  async function* summaries() {
    yield* state.scans; yield* state.githubReviews;
    for (const id of state.archivedReports || []) yield await archiveStore.get(id);
  }
  for await (const report of summaries()) {
    if (reportIds.has(report.id) || (report.scope !== 'github' && !projectIds.has(report.projectId))) throw new Error('报告引用不正确'); reportIds.add(report.id);
    const name = `details/${report.id}.json`; if (!allowed.test(name)) throw new Error('报告编号不正确');
    const detail = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    if (detail.id !== report.id || detail.status !== report.status || detail.issues?.length !== report.issueCount) throw new Error('报告与索引不一致');
    if (detail.policy) require('./project-policy').validatePolicy(detail.policy);
    if (detail.acceptancePipeline) require('./acceptance-pipeline').validatePlan(detail.acceptancePipeline.plan);
  }
  for (const project of state.projects) {
    if (project.pipelinePlan) {
      const name = `pipelines/${project.pipelinePlan.id}.json`; if (!allowed.test(name)) throw new Error('验收方案编号不正确');
      const plan = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
      if (plan.id !== project.pipelinePlan.id) throw new Error('验收方案与索引不一致');
      require('./acceptance-pipeline').validatePlan(plan);
    }
    if (project.baselineId && !state.scans.some(s => s.id === project.baselineId && s.projectId === project.id)) throw new Error('基线引用不存在');
    if (project.codingBrief) {
      const name = `briefs/${project.codingBrief.id}.json`; if (!allowed.test(name)) throw new Error('任务约定编号不正确');
      const brief = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
      if (brief.id !== project.codingBrief.id) throw new Error('任务约定与索引不一致');
    }
  }
  try {
    const work = JSON.parse(await fs.readFile(path.join(root, 'work', 'workspace.json'), 'utf8'));
    require('./workspace').validateDocument(work, projectIds, new Map(state.scans.map(s => [s.id, s.projectId])));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Restore to a nonexistent destination; verify paths/checksums/references before publishing under an exclusive data lock. */
async function restoreBackup(archive, destination) {
  destination = path.resolve(destination);
  try { await fs.lstat(destination); throw new Error('恢复目标已存在；请选择不存在的新目录，原数据不会覆盖'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = destination + '.restoring-' + crypto.randomUUID();
  await fs.mkdir(staging, { recursive: true });
  const input = createReadStream(archive), unzip = createGunzip();
  input.on('error', error => unzip.destroy(error)); input.pipe(unzip);
  let handle, current, hash, bytes = 0, total = 0, header, ended = false;
  const seen = new Set();
  try {
    for await (const record of archiveLines(unzip)) {
      if (!header) {
        if (record.format !== 'CodeHealthBackup' || record.version !== 1 || !Number.isSafeInteger(record.files) || record.files < 1 || record.files > 100000) throw new Error('不支持的备份格式');
        header = record; continue;
      }
      if (ended) throw new Error('备份结束后仍有数据');
      if (record.file !== undefined) {
        if (handle || typeof record.file !== 'string' || !allowed.test(record.file) || seen.has(record.file) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > maxFileBytes) throw new Error('备份文件路径或大小不正确');
        current = record; bytes = 0; hash = crypto.createHash('sha256'); seen.add(record.file);
        const target = path.join(staging, record.file); await fs.mkdir(path.dirname(target), { recursive: true }); handle = await fs.open(target, 'wx');
      } else if (record.data !== undefined) {
        if (!handle || typeof record.data !== 'string') throw new Error('备份内容编码不正确');
        const chunk = Buffer.from(record.data, 'base64'); if (chunk.toString('base64') !== record.data) throw new Error('备份内容编码不正确'); bytes += chunk.length; total += chunk.length;
        if (bytes > current.bytes || total > maxTotalBytes) throw new Error('备份解压数据超过上限');
        hash.update(chunk);
        let offset = 0; while (offset < chunk.length) { const written = await handle.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw new Error('恢复写入失败'); offset += written.bytesWritten; }
      } else if (record.end !== undefined) {
        if (!handle || record.end !== current.file || bytes !== current.bytes || hash.digest('hex') !== record.sha256) throw new Error('备份校验失败');
        await handle.close(); handle = null;
      } else if (record.done === true) {
        if (handle || record.files !== seen.size || record.files !== header.files || record.bytes !== total) throw new Error('备份清单不完整'); ended = true;
      } else throw new Error('备份记录不正确');
    }
    if (!ended || !seen.has('state.json')) throw new Error('备份未完成');
    await validateRestored(staging);
    // mkdir is exclusive, preventing a second restore or newly-created user directory from being overwritten.
    await fs.mkdir(destination);
    const publishingLock = await acquireDataLock(destination);
    try { for (const entry of await fs.readdir(staging)) await fs.rename(path.join(staging, entry), path.join(destination, entry)); }
    catch (error) { throw new Error('恢复发布失败，请保留暂存目录并检查：' + staging + '；' + error.message); }
    await publishingLock.release();
    await fs.rmdir(staging); return { destination, files: seen.size, bytes: total };
  } catch (error) { await handle?.close().catch(() => {}); throw error; }
  finally { input.destroy(); unzip.destroy(); }
}
module.exports = { createBackup, restoreBackup };
