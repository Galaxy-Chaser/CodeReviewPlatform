const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { catalog } = require('./lib/rules');
const { scanInWorker } = require('./lib/scanner');
const { acquireDataLock } = require('./lib/data-lock');
const { createBackup } = require('./lib/backup');
const { validatePolicy, applyPolicy } = require('./lib/project-policy');
const { collectTestEvidence } = require('./lib/test-evidence');
const { ArchiveStore, archiveReports, restoreReport, archivedPage } = require('./lib/archives');
const { sourceSnapshot, compareSnapshot } = require('./lib/source-snapshot');
const { request: sonarRequest, importAnalysis } = require('./lib/sonar');
const { mavenProbeArgs } = require('./lib/environment');
const { changedLines, filterChanged } = require('./lib/git-changes');
const { preflight } = require('./lib/preflight');
const { repairTasks, repairTaskPage, tasksMarkdown, compareScans } = require('./lib/reports');
const { reportView } = require('./lib/report-view');
const { checklist, validateAcceptance, acceptanceStatus, reviewReadiness } = require('./lib/acceptance');
const { fields: briefFields, validateBrief, briefStatus, briefMarkdown } = require('./lib/coding-brief');
const { listPulls, reviewPull } = require('./lib/github');
const { ReportStore, summarize } = require('./lib/report-store');
const queries = require('./lib/queries');
const { writeArray } = require('./lib/json-export');
const { createReadStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { identify, carryReviews, setReview } = require('./lib/issue-review');
const { readiness } = require('./lib/readiness');
const { PipelineStore, categories: pipelineCategories, template: pipelineTemplate, evaluatePipeline, setCaseResult, applyAutomaticCases, planMarkdown } = require('./lib/acceptance-pipeline');
const ROOT = __dirname;
const { runPlatformCheck, platformCheckView } = require('./lib/platform-check');
const { runBrowserRegression } = require('./scripts/check-browser');
const { browserCheckView } = require('./lib/browser-check');
const { runIterationCheck, iterationCheckView } = require('./lib/iteration-check');
const { createWorkApi } = require('./lib/work-api');
const DATA = process.env.HEALTH_DATA_DIR || path.join(ROOT, 'data');
const port = Number(process.env.PORT || 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 到 65535 之间的整数');
const reportStore = new ReportStore(DATA);
const archiveStore = new ArchiveStore(DATA);
const pipelineStore = new PipelineStore(DATA);
const defaults = { sonarUrl: 'http://127.0.0.1:9000', java8Home: process.env.JAVA8_HOME || '', java21Home: process.env.JAVA21_HOME || '',
  gate: { coverage: 60, duplication: 5 }, enabledRules: catalog.map(r => r.id) };
let state;
let token = process.env.SONAR_TOKEN || '';
let githubToken = process.env.GITHUB_TOKEN || '';
let githubActive = false;
let active = false;
let runningScan = null;
let scanController = null;
let backupActive = false, pendingMutations = 0, maintenanceActive = false;
let freshnessActive = false;
let reviewMutationActive = false;
let platformCheckActive = false;
let browserCheckActive = false;
let iterationCheckActive = false;
let initialized = false;
let writeQueue = Promise.resolve();
let revision = 0;
const workApi = createWorkApi(DATA, {
  projects: () => state.projects, body, brief: loadBrief, plan: loadPipeline,
  report: async id => { const r = await loadReport(id); return { ...r, issues: identify(r) }; },
  approve: async task => {
    const report = await loadReport(task.submission?.reportId);
    if (report.projectId !== task.projectId) fail('提交报告属于其他项目');
    const current = await checkFreshness(report), latest = state.scans.find(s => s.projectId === task.projectId);
    const ready = readiness(report, current, latest?.id);
    if (ready.status !== 'READY') fail('提交报告尚未满足当前验收条件：' + [...ready.blockers, ...ready.missing].join('；'), 409);
  }
});

/** Persist state atomically and sequentially, so a crash cannot leave a half-written JSON file. */
function save() {
  revision++;
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const json = JSON.stringify(state, null, 2);
    await fs.mkdir(DATA, { recursive: true });
    await fs.writeFile(path.join(DATA, 'state.tmp'), json);
    await fs.rename(path.join(DATA, 'state.tmp'), path.join(DATA, 'state.json'));
  });
  return writeQueue;
}
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }

/** Read a bounded JSON body. All mutations require JSON and a same-origin browser request. */
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail('请求必须使用 JSON', 415);
  let raw = '';
  for await (const part of req) { raw += part; if (raw.length > 64000) fail('请求内容过大', 413); }
  try { return JSON.parse(raw || '{}'); } catch { fail('JSON 格式不正确'); }
}
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function project(id) { return state.projects.find(p => p.id === id) || fail('项目不存在', 404); }

/** 对外只在最终报告保存后宣布完成，避免读取到尚未传递审查记录的中间结果。 */
function visibleRunningScan() {
  return runningScan ? { ...runningScan, status: 'running' } : null;
}

/** Locate a report through the index; arbitrary disk paths are never accepted. */
async function loadReport(id) {
  if (runningScan?.id === id) return visibleRunningScan();
  if (state.archivedReports.includes(id)) return { ...await reportStore.get(id), archivedAt: (await archiveStore.get(id)).archivedAt };
  if (![...state.scans, ...state.githubReviews].some(r => r.id === id)) fail('报告不存在', 404);
  return reportStore.get(id);
}

/** Read the immutable requirement version referenced by a registered project; old scans retain their own snapshot. */
async function loadBrief(item) {
  if (!item.codingBrief) return null;
  if (!/^[a-f0-9-]{36}$/.test(item.codingBrief.id)) fail('任务约定编号不正确');
  return JSON.parse(await fs.readFile(path.join(DATA, 'briefs', item.codingBrief.id + '.json'), 'utf8'));
}

/** 为项目按需读取当前验收方案；不存在时返回 null，完整正文不进入首页索引。 */
async function loadPipeline(item) { return item.pipelinePlan ? pipelineStore.get(item.pipelinePlan.id) : null; }

/** 使用固定方案和任务约定开始扫描；data.pipelineRun 按方案选择完整 / 本地模式，仍只执行受控的既有构建。 */
async function startScan(data) {
  if (active || reviewMutationActive) fail('已有扫描或审查保存运行中，请等待完成', 409);
  const item = project(data.projectId);
  if (item.archivedAt) fail('项目已归档，请先在归档中心恢复项目');
  const [codingBrief, plan] = await Promise.all([loadBrief(item), loadPipeline(item)]);
  if (data.pipelineRun && (!plan || !plan.confirmed)) fail('请先保存并确认项目验收方案');
  const mode = data.pipelineRun ? (plan.requireFull ? 'full' : 'local') : data.mode;
  const scope = data.pipelineRun ? 'project' : data.scope || 'project';
  if (!['local', 'full'].includes(mode)) fail('扫描模式不正确');
  if (!['project', 'changed'].includes(scope) || (scope === 'changed' && mode === 'full')) fail('本次改动检查只支持本地规则；完整体检扫描整个项目');
  if (active || reviewMutationActive) fail('已有扫描或审查保存运行中，请等待完成', 409);
  if (item.archivedAt) fail('项目已归档，请先恢复');
  // A plan may change while its old file is read. Require the selected version to still be current at startup.
  if ((item.pipelinePlan?.id || null) !== (plan?.id || null) || (item.codingBrief?.id || null) !== (codingBrief?.id || null)) fail('任务约定或验收方案已更新，请重新开始', 409);
  const policy = item.policy ? structuredClone(item.policy) : null;
  const scan = { id: crypto.randomUUID(), projectId: item.id, mode, scope, status: 'running', stage: 'preflight', startedAt: new Date().toISOString(), logs: '', issues: [], policy,
    settings: { ...structuredClone(state.settings), localRuleVersion: 3, gate: structuredClone(policy?.gate || state.settings.gate) },
    ...(codingBrief ? { codingBrief } : {}), ...(plan ? { acceptancePipeline: { plan, results: {} } } : {}) };
  state.scans.unshift(summarize(scan)); runningScan = scan; scanController = new AbortController(); active = true; await save();
  executeScan(scan, item, scan.settings).catch(console.error); return scan;
}

/** 根据最新扫描、当前方案和当前源码生成只读流水线视图；核对期间数据变化时要求重试。 */
async function pipelineView(id, verify = false) {
  const snapshotRevision = revision, report = await loadReport(id);
  if (!report.acceptancePipeline) fail('本报告没有绑定验收方案');
  const freshness = verify && report.status === 'completed' ? await checkFreshness(report) : report.acceptanceSourceCheck;
  if (snapshotRevision !== revision) fail('流水线或证据已更新，请重新读取', 409);
  const item = project(report.projectId), latest = state.scans.find(s => s.projectId === item.id);
  return { report, freshness, categories: pipelineCategories, summary: evaluatePipeline(report, freshness, latest?.id, item.pipelinePlan?.id) };
}

/** Persist details first, then replace the index entry. This ordering survives interrupted writes. */
async function persistReport(report, collection = state.scans) {
  if (state.archivedReports.includes(report.id)) {
    const archivedAt = (await archiveStore.get(report.id)).archivedAt;
    const detail = { ...report }; delete detail.archivedAt;
    const summary = await reportStore.put(detail); await archiveStore.put(summary, archivedAt); await save(); return;
  }
  const summary = await reportStore.put(report);
  const at = collection.findIndex(r => r.id === report.id);
  if (at < 0) collection.unshift(summary); else collection[at] = summary;
  await save();
}

/** Validate a query against registered projects before loading any source findings. */
function queryOptions(input) { const result = queries.options(input); if (result.projectId) project(result.projectId); return result; }

/** Stream all filtered issues to an atomic export, keeping memory independent of total match count. */
async function exportIssues(filters) {
  const file = `issues-${crypto.randomUUID()}.json`, destination = path.join(DATA, 'reports', file);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const handle = await fs.open(destination + '.tmp', 'wx');
  try {
    await writeArray(handle, queries.matchingIssues(state, loadReport, filters));
    await handle.close(); await fs.rename(destination + '.tmp', destination);
    return { path: destination, url: `/api/export-file?file=${file}`, file };
  } catch (error) { await handle.close().catch(() => {}); await fs.unlink(destination + '.tmp').catch(() => {}); throw error; }
}

/** Compute comparisons on request without retaining duplicate finding arrays in the history index. */
async function scanWithComparison(id) {
  const scan = await loadReport(id), item = project(scan.projectId);
  const previous = state.scans.find(s => s.id === item.baselineId) || state.scans.find(s => s.id !== scan.id && s.projectId === scan.projectId && s.status === 'completed' && s.startedAt < scan.startedAt && s.mode === scan.mode && (s.scope || 'project') === (scan.scope || 'project'));
  return { ...scan, comparison: compareScans(scan, previous ? await loadReport(previous.id) : null) };
}

/** Spawn a fixed executable with individual arguments, never a user supplied shell command. */
function run(executable, args, log, env = {}, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true, shell: false });
    const timer = setTimeout(() => { child.kill(); reject(new Error('操作超时')); }, timeoutMs);
    child.stdout.on('data', data => log(data.toString()));
    child.stderr.on('data', data => log(data.toString()));
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`操作失败，退出码 ${code}`)); });
  });
}
function powershell() { return process.platform === 'win32' ? 'powershell.exe' : 'pwsh'; }

/** Recheck one local working copy at a time; unreadable evidence cannot confirm freshness. */
async function checkFreshness(report) {
  if (report.scope === 'github') return { status: 'UNKNOWN', checkedAt: new Date().toISOString(), reason: 'GitHub 报告对应固定 HEAD；本机文件核对不适用，PR 更新后需重新检查' };
  if (!report.sourceSnapshot) return compareSnapshot(null, null);
  if (freshnessActive) fail('正在核对代码版本，请稍后再试', 409);
  freshnessActive = true;
  try {
    const item = project(report.projectId), current = await sourceSnapshot(item.path);
    const head = report.scope === 'changed' ? (await changedLines(item.path)).head : undefined;
    return compareSnapshot(report.sourceSnapshot, current, report.scope === 'changed' ? report.changes?.head : undefined, head);
  } catch (error) { return { status: 'UNKNOWN', checkedAt: new Date().toISOString(), reason: '无法核实当前代码：' + error.message }; }
  finally { freshnessActive = false; }
}

/** Execute one scan at a time and save both successes and failures as reviewable history. */
async function executeScan(scan, item, settings) {
  const scanToken = token;
  const log = value => { const clean = scanToken ? value.split(scanToken).join('[REDACTED]') : value; scan.logs = (scan.logs + clean).slice(-150000); };
  try {
    scan.stage = 'preflight';
    log('检查扫描前置条件…\n');
    scan.preflight = await preflight(item, settings, scanToken, scan.mode, scan.scope);
    if (!scan.preflight.ready) throw new Error(scan.preflight.checks.filter(c => !c.passed).map(c => `${c.name}：${c.detail}`).join('；'));
    scan.stage = 'snapshot';
    log('记录源码与配置版本指纹…\n');
    scan.sourceSnapshot = await sourceSnapshot(item.path, { signal: scanController.signal });
    const initialChanges = scan.scope === 'changed' ? await changedLines(item.path) : null;
    scan.stage = 'local';
    log('开始本地规则检查…\n');
    const local = await scanInWorker(item.path, settings.enabledRules, { signal: scanController.signal, onProgress: progress => { scan.fileProgress = progress; } });
    if (scan.scope === 'changed') {
      scan.changes = initialChanges;
      local.issues = filterChanged(local.issues, scan.changes);
      scan.checkedFiles = scan.changes.files.length;
      log(`检查本次改动：${scan.checkedFiles} 个 Java / SQL 文件。已保留项目上下文以检查重复迁移版本。\n`);
    }
    if (scanController.signal.aborted) throw new Error('检查已停止，结果未完成；请重新检查后验收');
    Object.assign(scan, local);
    scan.localCompleted = true;
    scan.metrics = { files: local.files, lines: local.lines };
    if (scan.mode === 'full') {
      if (!scanToken) throw new Error('请在环境设置中填写 SONAR_TOKEN。');
      scan.stage = 'build';
      log('使用 Java 8 构建与测试，然后使用 Java 21 扫描…\n');
      const buildStartedAt = Date.now();
      scan.build = { status: 'running', startedAt: new Date(buildStartedAt).toISOString() };
      const stageLog = value => { if (value.includes('[2/3]')) { scan.stage = 'sonar'; scan.build.status = 'completed'; scan.build.finishedAt = new Date().toISOString(); } if (value.includes('[3/3]')) scan.stage = 'processing'; log(value); };
      try {
        await run(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'sonar-scan.ps1'),
        '-ProjectPath', item.path, '-ProjectKey', item.key, '-SonarUrl', settings.sonarUrl, '-NoBrowser'], stageLog,
        { JAVA8_HOME: settings.java8Home, JAVA21_HOME: settings.java21Home, SONAR_TOKEN: scanToken });
        scan.build.status = 'completed'; scan.build.finishedAt ||= new Date().toISOString();
      } catch (error) {
        if (scan.build.status !== 'completed') { scan.build.status = 'failed'; scan.build.finishedAt = new Date().toISOString(); }
        // Failed test builds can still emit reports. Preserve counts without turning the failed scan into a pass.
        scan.buildTests = await collectTestEvidence(item.path, buildStartedAt, { testRefs: scan.acceptancePipeline?.plan.cases.map(c => c.testRef).filter(Boolean) });
        throw error;
      }
      scan.stage = 'import';
      scan.buildTests = await collectTestEvidence(item.path, buildStartedAt, { testRefs: scan.acceptancePipeline?.plan.cases.map(c => c.testRef).filter(Boolean) });
      log(scan.buildTests.available ? `构建报告记录实际执行 ${scan.buildTests.executed} 个测试，跳过 ${scan.buildTests.skipped} 个。\n` : scan.buildTests.reason + '\n');
      const report = await importAnalysis(settings, item.key, scanToken);
      Object.assign(scan, report, { issues: [...local.issues, ...report.issues] });
    } else {
      scan.gate = { status: 'PASSED', checks: [] };
      if (scan.scope === 'changed' && !scan.checkedFiles) scan.gate = { status: 'UNKNOWN', checks: [{ name: '没有待检查的 Java / SQL 改动', value: null, target: '修改代码后再检查', passed: null }] };
      log('本地规则检查完成。此结果不包含编译、单元测试、覆盖率或 SonarQube 分析。\n');
    }
    const finalSnapshot = await sourceSnapshot(item.path, { signal: scanController.signal });
    const finalHead = scan.scope === 'changed' ? (await changedLines(item.path)).head : undefined;
    const consistency = compareSnapshot(scan.sourceSnapshot, finalSnapshot, initialChanges?.head, finalHead);
    scan.sourceConsistency = { status: consistency.status, checkedAt: consistency.checkedAt };
    if (consistency.status !== 'CURRENT') throw Error('检查期间源码、配置或 Git 基准发生变化，结果未完成；请重新检查');
    scan.gate = applyPolicy(scan, scan.gate);
    scan.status = 'completed'; scan.stage = 'done';
    const baseline = state.scans.find(s => s.id === item.baselineId);
    const previous = baseline || state.scans.find(s => s.id !== scan.id && s.projectId === item.id && s.status === 'completed' && s.mode === scan.mode && (s.scope || 'project') === scan.scope);
    scan.comparison = compareScans(scan, previous ? await loadReport(previous.id) : null);
    const previousReview = state.scans.find(s => s.id !== scan.id && s.projectId === scan.projectId && s.status === 'completed' && s.mode === scan.mode && (s.scope || 'project') === scan.scope);
    carryReviews(scan, previousReview ? await loadReport(previousReview.id) : null);
    log('检查完成。\n');
  } catch (error) {
    scan.status = 'failed'; scan.error = error.message;
    if (scan.gate?.status === 'PASSED') scan.gate = { status: 'UNKNOWN', checks: [{ name: '检查完整性', value: null, target: '完整稳定的源码版本', passed: null }] };
    log(`失败：${error.message}\n`);
  }
  finally { scan.finishedAt = new Date().toISOString(); try {
    applyAutomaticCases(scan, { ...scan.sourceConsistency, digest: scan.sourceConsistency?.status === 'CURRENT' ? scan.sourceSnapshot?.digest : null });
    await persistReport(scan);
  } finally { runningScan = null; scanController = null; active = false; } }
}

/** Inspect executable availability without installing tools or starting containers. */
async function environment() {
  const probe = async (command, args) => {
    let output = '';
    try {
      await run(command, args, text => { output += text; }, {}, 6000);
      return { available: true, detail: output.trim().slice(0, 200) };
    } catch { return { available: false, detail: '未检测到，安装后重新检查' }; }
  };
  const [docker, maven, jdk8, jdk21, sonar] = await Promise.all([
    probe('docker', ['info', '--format', '{{.ServerVersion}}']),
    process.platform === 'win32' ? probe(powershell(), mavenProbeArgs()) : probe('mvn', ['-version']),
    state.settings.java8Home ? probe(path.join(state.settings.java8Home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-version']) : { available: false, detail: '请设置 JAVA8_HOME' },
    state.settings.java21Home ? probe(path.join(state.settings.java21Home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-version']) : { available: false, detail: '请设置 JAVA21_HOME' },
    sonarRequest(state.settings.sonarUrl, '/api/system/status', token).then(s => ({ available: s.status === 'UP', detail: s.status })).catch(() => ({ available: false, detail: '未连接；本地规则检查仍可使用' }))
  ]);
  return { node: { available: true, detail: process.version }, docker, maven, jdk8, jdk21, sonar, token: { available: !!token, detail: token ? '已设置，仅保存在当前进程中' : '未设置' } };
}

async function api(req, res, url) {
  if (url.pathname.startsWith('/api/work/') || url.pathname.startsWith('/api/agent/')) return json(res, await workApi(req, url));
  if (req.headers.authorization) fail('本地 agent 只能调用专用协作接口', 403);
  if (req.method === 'GET' && url.pathname === '/api/iteration-check') {
    const id = state.iterationCheckId;
    if (!id) return json(res, { status: 'NOT_CHECKED', report: null });
    reportStore.file(id);
    const report = JSON.parse(await fs.readFile(path.join(DATA, 'reports', `report-${id}.json`), 'utf8'));
    const view = await iterationCheckView(ROOT, report);
    if (iterationCheckActive) view.status = 'RUNNING';
    return json(res, view);
  }
  if (req.method === 'GET' && url.pathname === '/api/browser-check') {
    if (browserCheckActive) return json(res, { status: 'RUNNING', report: null });
    const id = state.browserCheckId;
    if (!id) return json(res, { status: 'NOT_CHECKED', report: null });
    reportStore.file(id);
    const report = JSON.parse(await fs.readFile(path.join(DATA, 'reports', `report-${id}.json`), 'utf8'));
    return json(res, await browserCheckView(ROOT, report));
  }
  if (req.method === 'GET' && url.pathname === '/api/platform-check') {
    if (platformCheckActive) return json(res, { status: 'RUNNING', report: null });
    const id = state.platformCheckId;
    if (!id) return json(res, { status: 'NOT_CHECKED', report: null });
    reportStore.file(id); // 复用 UUID 验证，拒绝备份或数据编辑造成的路径上跳。
    const report = JSON.parse(await fs.readFile(path.join(DATA, 'reports', `report-${id}.json`), 'utf8'));
    return json(res, await platformCheckView(ROOT, report));
  }
  if (req.method === 'GET' && url.pathname === '/api/fixture') return json(res, { path: path.join(ROOT, 'examples', 'java8-fixture') });
  if (req.method === 'GET' && url.pathname === '/api/export-file') {
    const file = url.searchParams.get('file') || '';
    const backup = /^backup-[a-f0-9-]{36}\.jsonl\.gz$/.test(file);
    const picture = /^browser-[a-f0-9-]{36}-[a-z0-9-]{1,40}\.png$/.test(file);
    if (!backup && !picture && !/^(report|issues|tasks|brief|pipeline)-[a-f0-9-]{36}\.(json|md)$/.test(file)) fail('导出文件不存在', 404);
    const reportPath = path.join(DATA, backup ? 'backups' : 'reports', file), stat = await fs.stat(reportPath);
    res.writeHead(200, { 'Content-Type': backup ? 'application/gzip' : picture ? 'image/png' : file.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': stat.size, 'Content-Disposition': `${picture ? 'inline' : 'attachment'}; filename="${file}"`, 'Cache-Control': 'no-store' });
    return pipeline(createReadStream(reportPath), res);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, { ...queries.compactState(state, visibleRunningScan()), revision, rules: catalog, checklist, briefFields, tokenConfigured: !!token, githubTokenConfigured: !!githubToken, githubActive, active });
  if (req.method === 'GET' && url.pathname === '/api/pipeline/plan') {
    const item = project(url.searchParams.get('projectId'));
    return json(res, { plan: await loadPipeline(item), template: pipelineTemplate(), categories: pipelineCategories });
  }
  if (req.method === 'GET' && url.pathname === '/api/pipeline/report') return json(res, await pipelineView(url.searchParams.get('id')));
  if (req.method === 'GET' && url.pathname === '/api/coding-brief') {
    const item = project(url.searchParams.get('projectId')), brief = await loadBrief(item);
    return json(res, { brief, markdown: brief ? briefMarkdown(item, brief) : null });
  }
  if (req.method === 'GET' && url.pathname === '/api/issues') {
    const snapshotRevision = revision, result = await queries.issuePage(state, loadReport, queryOptions(Object.fromEntries(url.searchParams)));
    if (revision !== snapshotRevision) fail('检查结果已更新，请重新读取', 409);
    return json(res, { ...result, revision });
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const snapshot = revision, filters = queryOptions(Object.fromEntries(url.searchParams));
    const result = url.searchParams.get('kind') === 'archive' ? await archivedPage(state, filters, archiveStore) : queries.historyPage(state, filters, url.searchParams.get('kind') || 'scan', visibleRunningScan());
    if (snapshot !== revision) fail('记录已更新，请重新读取', 409);
    return json(res, { ...result, revision });
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const memory = process.memoryUsage();
    return json(res, { status: 'UP', version: require('./package.json').version, port, node: process.version, uptimeSeconds: Math.floor(process.uptime()),
      memory: { rssMB: Math.round(memory.rss / 1048576 * 10) / 10, heapMB: Math.round(memory.heapUsed / 1048576 * 10) / 10 },
      storage: { path: DATA, scans: state.scans.length, githubReviews: state.githubReviews.length, archivedReports: state.archivedReports.length, strategy: 'details-on-demand' }, active, githubActive, backupActive });
  }
  if (req.method === 'GET' && url.pathname === '/api/report') {
    const report = await loadReport(url.searchParams.get('id'));
    return json(res, { ...report, issues: identify(report), readiness: reviewReadiness(report) });
  }
  if (req.method === 'GET' && url.pathname === '/api/report/view') {
    return json(res, reportView(await loadReport(url.searchParams.get('id'))));
  }
  if (req.method === 'GET' && url.pathname === '/api/scan/view') {
    return json(res, reportView(await scanWithComparison(url.searchParams.get('id'))));
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks/page') {
    const parameters = Object.fromEntries(url.searchParams);
    if (Object.keys(parameters).some(key => !['id', 'offset'].includes(key))) fail('修复清单只支持报告编号和分页位置', 400);
    const { offset } = queries.options({ offset: parameters.offset });
    const scan = await loadReport(parameters.id);
    if (scan.status !== 'completed') fail('请先完成一次扫描', 400);
    return json(res, { scanId: scan.id, scan: summarize(scan), ...repairTaskPage({ ...scan, issues: identify(scan) }, offset) });
  }
  if (req.method === 'GET' && url.pathname === '/api/environment') return json(res, await environment());
  if (req.method === 'GET' && url.pathname === '/api/scan') {
    return json(res, await scanWithComparison(url.searchParams.get('id')));
  }
  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const scan = await loadReport(url.searchParams.get('id'));
    if (scan.status !== 'completed') fail('请先完成一次扫描', 400);
    return json(res, { scanId: scan.id, scan: summarize(scan), tasks: repairTasks(scan) });
  }
  if (req.method === 'GET' && url.pathname === '/api/source') {
    const item = project(url.searchParams.get('project'));
    const root = await fs.realpath(item.path);
    const file = await fs.realpath(path.resolve(root, url.searchParams.get('file') || ''));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.(java|sql)$/i.test(file)) fail('不能读取项目外的文件', 403);
    if ((await fs.stat(file)).size > 5 * 1024 * 1024) fail('文件过大');
    return json(res, { source: await fs.readFile(file, 'utf8') });
  }
  if (req.method !== 'POST') fail('接口不存在', 404);
  const data = await body(req);
  if (url.pathname === '/api/iteration-check/run') {
    if (iterationCheckActive || browserCheckActive || platformCheckActive || active || githubActive || reviewMutationActive) fail('正在检查或保存，请稍后执行本轮验收', 409);
    if (Object.keys(data).length) fail('本轮验收不接受外部命令、地址或项目参数');
    iterationCheckActive = true;
    try {
      const id = crypto.randomUUID(), output = path.join(DATA, 'reports', `report-${id}.json`);
      const { report } = await runIterationCheck(ROOT, { id, output, onStart: async () => { state.iterationCheckId = id; await save(); } });
      return json(res, await iterationCheckView(ROOT, report));
    } finally { iterationCheckActive = false; }
  }
  if (url.pathname === '/api/browser-check/run') {
    if (iterationCheckActive || browserCheckActive || platformCheckActive || active || githubActive || reviewMutationActive) fail('正在检查或保存，请稍后执行页面回归', 409);
    if (Object.keys(data).length) fail('页面回归不接受外部地址、脚本或项目参数');
    browserCheckActive = true;
    try {
      const id = crypto.randomUUID(), output = path.join(DATA, 'reports', `report-${id}.json`);
      const { report } = await runBrowserRegression({ id, output, onStart: async () => { state.browserCheckId = id; await save(); } });
      return json(res, await browserCheckView(ROOT, report));
    } finally { browserCheckActive = false; }
  }
  if (url.pathname === '/api/platform-check/run') {
    if (iterationCheckActive || platformCheckActive || browserCheckActive || active || githubActive || reviewMutationActive) fail('正在检查或保存，请稍后执行平台自身检查', 409);
    if (Object.keys(data).length) fail('平台自身检查不接受外部命令或项目参数');
    platformCheckActive = true;
    try {
      const report = await runPlatformCheck(ROOT), directory = path.join(DATA, 'reports');
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, `report-${report.id}.json`);
      await fs.writeFile(file + '.tmp', JSON.stringify(report)); await fs.rename(file + '.tmp', file);
      state.platformCheckId = report.id; await save();
      return json(res, await platformCheckView(ROOT, report));
    } finally { platformCheckActive = false; }
  }
  if (url.pathname === '/api/pipeline/plan') {
    if (reviewMutationActive || active) fail('正在检查或保存，请稍后修改方案', 409);
    reviewMutationActive = true;
    try {
      const item = project(data.projectId);
      if (item.archivedAt) fail('项目已归档，请先恢复');
      if ((data.expectedId || null) !== (item.pipelinePlan?.id || null)) fail('方案已被更新，请重新打开编辑', 409);
      const plan = await pipelineStore.put(data.plan);
      item.pipelinePlan = { id: plan.id, updatedAt: plan.updatedAt, name: plan.name, caseCount: plan.cases.length, confirmed: plan.confirmed, requireFull: plan.requireFull, minTests: plan.minTests };
      await save(); return json(res, plan);
    } finally { reviewMutationActive = false; }
  }
  if (url.pathname === '/api/pipeline/run') return json(res, await startScan({ projectId: data.projectId, pipelineRun: true }), 202);
  if (url.pathname === '/api/pipeline/check') return json(res, await pipelineView(data.id, true));
  if (url.pathname === '/api/pipeline/result') {
    if (reviewMutationActive || active || githubActive) fail('正在检查或保存，请稍后记录场景', 409);
    reviewMutationActive = true;
    try {
      const report = await loadReport(data.id);
      const previous = report.acceptancePipeline?.results?.[data.caseId];
      if ((data.expectedRecordedAt || null) !== (previous?.recordedAt || null)) fail('场景记录已更新，请重新打开', 409);
      const freshness = await checkFreshness(report);
      const result = setCaseResult(report, data.caseId, data.result, freshness);
      await persistReport(report);
      return json(res, { result, summary: evaluatePipeline(report, freshness, state.scans.find(s => s.projectId === report.projectId)?.id, project(report.projectId).pipelinePlan?.id) });
    } finally { reviewMutationActive = false; }
  }
  if (url.pathname === '/api/pipeline/export') {
    let report, summary, plan, item;
    if (data.id) { const view = await pipelineView(data.id, true); ({ report, summary } = view); plan = report.acceptancePipeline.plan; item = project(report.projectId); }
    else { item = project(data.projectId); plan = await loadPipeline(item); if (!plan) fail('请先保存验收方案'); }
    const file = `pipeline-${crypto.randomUUID()}.md`, destination = path.join(DATA, 'reports', file);
    await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, planMarkdown(item, plan, report, summary));
    return json(res, { path: destination, file, url: `/api/export-file?file=${file}` });
  }
  if (url.pathname === '/api/readiness') {
    const snapshotRevision = revision;
    const selected = data.id ? await loadReport(data.id) : null;
    const collection = selected?.scope === 'github' ? state.githubReviews : state.scans;
    const latest = collection.find(s => selected?.scope === 'github' ? s.repository === selected.repository && s.number === selected.number : s.projectId === (selected?.projectId || project(data.projectId).id));
    const report = selected || (latest ? await loadReport(latest.id) : null);
    const sourceCheck = report ? await checkFreshness(report) : null;
    if (snapshotRevision !== revision) fail('检查或证据已更新，请重新核对验收条件', 409);
    // A scan may start while hashing the files. Re-read the latest attempt before declaring readiness.
    const now = collection.find(s => report?.scope === 'github' ? s.repository === report.repository && s.number === report.number : s.projectId === (report?.projectId || data.projectId));
    const result = readiness(report, sourceCheck, now?.id);
    if (report && report.scope !== 'github') {
      const currentPlanId = project(report.projectId).pipelinePlan?.id;
      if (currentPlanId && report.acceptancePipeline?.plan.id !== currentPlanId) { result.status = 'BLOCKED'; result.blockers.unshift('项目验收方案已更新或未绑定本报告，请重新运行验收流水线'); result.next = '按当前项目方案重新检查'; }
    }
    return json(res, result);
  }
  if (url.pathname === '/api/issues/review') {
    if (reviewMutationActive || active || githubActive) fail('正在检查或保存审查记录，请稍后再试', 409);
    reviewMutationActive = true;
    try {
      const report = await loadReport(data.id);
      const issue = setReview(report, data.trackingId, data.status, data.reason);
      await persistReport(report, report.scope === 'github' ? state.githubReviews : state.scans);
      return json(res, issue);
    } finally { reviewMutationActive = false; }
  }
  if (url.pathname === '/api/reports/archive') { const result = await archiveReports(state, data.ids || [data.id], archiveStore); await save(); return json(res, result); }
  if (url.pathname === '/api/reports/restore') { const result = await restoreReport(state, data.id, archiveStore); await save(); return json(res, result); }
  if (url.pathname === '/api/projects/archive' || url.pathname === '/api/projects/restore') {
    const item = project(data.id);
    if (url.pathname.endsWith('/archive')) item.archivedAt = new Date().toISOString(); else delete item.archivedAt;
    await save(); return json(res, item);
  }
  if (url.pathname === '/api/projects/policy') {
    const item = project(data.projectId);
    item.policy = { ...validatePolicy(data.policy), id: crypto.randomUUID(), updatedAt: new Date().toISOString() };
    await save(); return json(res, item.policy);
  }
  if (url.pathname === '/api/backup') return json(res, await createBackup(DATA, state), 201);
  if (url.pathname === '/api/scans/stop') {
    if (!runningScan || runningScan.id !== data.id || runningScan.stage !== 'local' || scanController?.signal.aborted) fail('只能停止当前正在执行的本地规则检查', 409);
    runningScan.stopRequested = true; scanController.abort();
    return json(res, { requested: true });
  }
  if (url.pathname === '/api/coding-brief') {
    const item = project(data.projectId), brief = { ...validateBrief(data.brief), id: crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const directory = path.join(DATA, 'briefs');
    await fs.mkdir(directory, { recursive: true });
    const destination = path.join(directory, brief.id + '.json');
    await fs.writeFile(destination + '.tmp', JSON.stringify(brief)); await fs.rename(destination + '.tmp', destination);
    item.codingBrief = { id: brief.id, updatedAt: brief.updatedAt, ...briefStatus(brief) };
    await save(); return json(res, { brief, ...briefStatus(brief) });
  }
  if (url.pathname === '/api/coding-brief/export') {
    const item = project(data.projectId), brief = await loadBrief(item);
    if (!brief) fail('请先保存任务约定');
    const file = `brief-${crypto.randomUUID()}.md`, destination = path.join(DATA, 'reports', file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, briefMarkdown(item, brief));
    return json(res, { file, url: `/api/export-file?file=${file}`, path: destination });
  }
  if (url.pathname === '/api/github/token') {
    if (data.clear === true) githubToken = '';
    else {
      if (typeof data.token !== 'string' || !data.token.trim() || data.token.length > 500 || /\s/.test(data.token.trim())) fail('GitHub Token 格式不正确');
      githubToken = data.token.trim();
    }
    return json(res, { configured: !!githubToken });
  }
  if (url.pathname === '/api/github/pulls') return json(res, await listPulls(data.repository, githubToken));
  if (url.pathname === '/api/github/review') {
    if (githubActive || reviewMutationActive) fail('已有检查或审查保存运行中，请等待完成', 409);
    githubActive = true;
    const reviewToken = githubToken;
    try {
      const report = await reviewPull(data.repository, data.number, reviewToken, [...state.settings.enabledRules]);
      const previous = state.githubReviews.find(r => r.repository === report.repository && r.number === report.number && r.status === 'completed');
      carryReviews(report, previous ? await loadReport(previous.id) : null);
      await persistReport(report, state.githubReviews); return json(res, report, 201);
    } finally { githubActive = false; }
  }
  if (url.pathname === '/api/freshness') return json(res, await checkFreshness(await loadReport(data.id)));
  if (url.pathname === '/api/acceptance') {
    if (reviewMutationActive) fail('正在保存审查记录，请稍后再试', 409);
    reviewMutationActive = true;
    try {
      const report = await loadReport(data.id);
      if (report.status !== 'completed') fail('请先完成检查');
      report.acceptance = validateAcceptance(data.acceptance);
      if (report.scope !== 'github') report.acceptanceSourceCheck = await checkFreshness(report);
      report.acceptanceAt = new Date().toISOString(); await persistReport(report, report.scope === 'github' ? state.githubReviews : state.scans);
      return json(res, { status: acceptanceStatus(report) });
    } finally { reviewMutationActive = false; }
  }
  if (url.pathname === '/api/preflight') {
    if (!['local', 'full'].includes(data.mode) || !['project', 'changed'].includes(data.scope || 'project') || (data.mode === 'full' && data.scope === 'changed')) fail('检查方式或范围不正确');
    return json(res, await preflight(project(data.projectId), state.settings, token, data.mode, data.scope || 'project'));
  }
  if (url.pathname === '/api/export') {
    let payload, kind;
    if (data.scanId) {
      payload = await loadReport(data.scanId);
      kind = data.kind === 'tasks' ? 'tasks' : 'report';
      if (kind === 'tasks') {
        if (payload.status !== 'completed') fail('请等待扫描完成后导出修复任务');
        payload = tasksMarkdown(payload, payload.scope === 'github' ? { name: `${payload.repository} PR #${payload.number}` } : project(payload.projectId));
      }
    } else {
      return json(res, await exportIssues(queryOptions(data)));
    }
    const file = `${kind}-${crypto.randomUUID()}.${kind === 'tasks' ? 'md' : 'json'}`;
    await fs.mkdir(path.join(DATA, 'reports'), { recursive: true });
    const reportPath = path.join(DATA, 'reports', file);
    await fs.writeFile(reportPath, kind === 'tasks' ? payload : JSON.stringify(payload, null, 2));
    return json(res, { path: reportPath, url: `/api/export-file?file=${file}`, file });
  }
  if (url.pathname === '/api/projects' || url.pathname === '/api/projects/update') {
    const existing = url.pathname.endsWith('/update') ? project(data.id) : null;
    if (existing && active) fail('扫描运行中，请稍后编辑项目', 409);
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80) fail('请输入项目名称（最多 80 字）');
    if (typeof data.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(data.key)) fail('项目 Key 仅支持字母、数字、点、冒号、下划线和连字符');
    if (state.projects.some(p => p.key === data.key && p.id !== existing?.id)) fail('项目 Key 已存在');
    if (existing && data.key !== existing.key) fail('已有项目的 Key 保持不变，新的 Key 请添加新项目');
    if (typeof data.path !== 'string' || !path.isAbsolute(data.path)) fail('请填写项目的绝对路径');
    const root = await fs.realpath(data.path).catch(() => fail('项目目录不存在'));
    if (!(await fs.stat(root)).isDirectory()) fail('项目路径必须是目录');
    await fs.access(path.join(root, 'pom.xml')).catch(() => fail('项目根目录必须包含 pom.xml'));
    if (existing) {
      Object.assign(existing, { name: data.name.trim(), path: root });
      await save(); return json(res, existing);
    }
    const item = { id: crypto.randomUUID(), name: data.name.trim(), key: data.key, path: root, createdAt: new Date().toISOString() };
    state.projects.push(item); await save(); return json(res, item, 201);
  }
  if (url.pathname === '/api/settings') {
    const settings = data.settings;
    if (!settings || typeof settings !== 'object') fail('设置格式不正确');
    let sonarUrl;
    try { sonarUrl = new URL(settings.sonarUrl); } catch { fail('SonarQube 地址格式不正确'); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(sonarUrl.hostname) || sonarUrl.protocol !== 'http:' || sonarUrl.username || sonarUrl.password || sonarUrl.pathname !== '/' || sonarUrl.search || sonarUrl.hash) fail('SonarQube 必须使用本机 HTTP 地址');
    for (const field of ['java8Home', 'java21Home']) if (typeof settings[field] !== 'string') fail('JDK 路径格式不正确');
    for (const field of ['coverage', 'duplication']) if (!Number.isFinite(settings.gate?.[field]) || settings.gate[field] < 0 || settings.gate[field] > 100) fail('门禁阈值必须介于 0 和 100');
    if (!Array.isArray(settings.enabledRules) || settings.enabledRules.some(id => !catalog.some(r => r.id === id))) fail('未知规则');
    state.settings = { sonarUrl: sonarUrl.origin, java8Home: settings.java8Home, java21Home: settings.java21Home, gate: settings.gate, enabledRules: settings.enabledRules };
    if (typeof data.token === 'string' && data.token) token = data.token.trim();
    if (data.clearToken === true) token = '';
    await save(); return json(res, { ok: true });
  }
  if (url.pathname === '/api/scans') {
    return json(res, await startScan(data), 202);
  }
  if (url.pathname === '/api/baseline') {
    const item = project(data.projectId);
    const scan = state.scans.find(s => s.id === data.scanId && s.projectId === item.id && s.status === 'completed' && s.scope !== 'changed');
    if (!scan) fail('请选择已完成的扫描');
    item.baselineId = scan.id; await save(); return json(res, { ok: true });
  }
  if (url.pathname === '/api/sonar-control') {
    if (!['start', 'stop'].includes(data.action)) fail('不支持该操作');
    if (active) fail('扫描运行中，请稍后操作', 409);
    let logs = '';
    await run(powershell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', `sonar-${data.action}.ps1`)], value => { logs += value; });
    return json(res, { ok: true, logs });
  }
  fail('接口不存在', 404);
}

async function start() {
  let dataLock;
  const server = http.createServer(async (req, res) => {
    try {
      if (!initialized) fail('平台初始化中，请稍后重试', 503);
      const host = req.headers.host || '';
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) fail('只允许本机访问', 403);
      if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) fail('跨站请求被拒绝', 403);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'POST' && ['/api/backup', '/api/reports/archive', '/api/reports/restore', '/api/projects/archive', '/api/projects/restore'].includes(url.pathname)) {
          if (backupActive || maintenanceActive || pendingMutations || active || githubActive) fail('请等待检查、保存、备份或归档操作完成后再试', 409);
          const backup = url.pathname === '/api/backup'; if (backup) backupActive = true; else maintenanceActive = true;
          try { await writeQueue; return await api(req, res, url); } finally { if (backup) backupActive = false; else maintenanceActive = false; }
        }
        if (req.method === 'POST') {
          if (backupActive || maintenanceActive) fail('正在备份或整理归档，请稍后保存或启动检查', 409);
          pendingMutations++;
          try { return await api(req, res, url); } finally { pendingMutations--; }
        }
        return await api(req, res, url);
      }
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'application/javascript'], '/work.js': ['work.js', 'application/javascript'], '/ui.js': ['ui.js', 'application/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method !== 'GET' || !assets[url.pathname]) fail('页面不存在', 404);
      const [file, mime] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(await fs.readFile(path.join(ROOT, 'public', file)));
    } catch (error) { if (res.headersSent) res.destroy(error); else json(res, { error: error.message }, error.status || 400); }
  });
  try {
    // Reserve the port before touching data: a second launch must not rewrite a running instance's files.
    await new Promise((resolve, reject) => {
      const onError = error => reject(new Error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用。可设置 PORT 或使用 scripts/start.ps1 -Port 其他端口。` : error.message));
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => { server.off('error', onError); resolve(); });
    });
    dataLock = await acquireDataLock(DATA);
    try { state = JSON.parse(await fs.readFile(path.join(DATA, 'state.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; state = { projects: [], scans: [], settings: defaults }; }
    state.githubReviews ||= [];
    state.archivedReports ||= [];
    // Introduce new safeguards once; later rule selections stay under the user's control.
    if (state.featureVersion !== 2) {
      state.settings.enabledRules = [...new Set([...state.settings.enabledRules, 'hardcoded-secret', 'process-execution', 'destructive-sql'])];
      state.featureVersion = 2;
    }
    if (state.storageVersion !== 1) {
      await fs.mkdir(DATA, { recursive: true });
      await fs.copyFile(path.join(DATA, 'state.json'), path.join(DATA, 'state-before-details.json'), require('node:fs').constants.COPYFILE_EXCL).catch(error => { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; });
    }
    await reportStore.migrate(state);
    await save(); initialized = true;
    console.log(`Code Health Center: http://127.0.0.1:${port}`);
    let shuttingDown = false;
    /** Stop accepting writes, drain pending persistence, then release ownership before exiting. */
    const shutdown = async () => {
      if (shuttingDown) return; shuttingDown = true; initialized = false;
      scanController?.abort(); server.close();
      // Only release after active writers stop. Forced termination leaves a recoverable lock instead.
      while (active || githubActive || backupActive || maintenanceActive || pendingMutations) await new Promise(resolve => setTimeout(resolve, 50));
      await writeQueue; await dataLock.release(); process.exit(0);
    };
    process.once('SIGINT', () => shutdown().catch(console.error)); process.once('SIGTERM', () => shutdown().catch(console.error));
  } catch (error) { server.close(); await dataLock?.release(); throw error; }
}
start().catch(error => { console.error(error); process.exitCode = 1; });
