const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { sourceSnapshot, compareSnapshot } = require('../lib/source-snapshot');

/** 固定平台流程目录，不接受页面传入的脚本；所有写操作只针对新建的隔离实例。 */
const scenarios = [
  ['project', '添加项目与页面保存'], ['duplicate', '重复项目拒绝与原数据保留'],
  ['scan', '实际扫描与完成状态'], ['acceptance', '五类验收证据保存'],
  ['download', '报告导出与实际下载'], ['pipeline', '场景失败阻断与复验历史'],
  ['stale', '源码变化阻断旧验收'], ['paging', '大量问题翻页、审查与完整导出'], ['setup', '按需配置与错误保存反馈'],
  ['work-sync', '多 agent 实际协作、自动同步与编辑保护'], ['release', '关闭详情与离开列表释放缓存'], ['mobile', '窄屏文字导航与报告显示']
];

/** 启动独立端口，返回子进程；启动失败或超时必须报错，不以等待时间当作就绪。 */
async function startServer(root, data, port) {
  const env = { ...process.env, PORT: String(port), HEALTH_DATA_DIR: data, SONAR_TOKEN: '', GITHUB_TOKEN: '', JAVA8_HOME: '', JAVA21_HOME: '' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const stop = error => { clearTimeout(timer); reject(error); };
      const timer = setTimeout(() => stop(Error('隔离平台启动超时')), 10000);
      child.once('error', stop); child.once('exit', code => stop(Error('隔离平台提前退出：' + code)));
      child.stderr.on('data', s => stop(Error(s.toString().slice(0, 2000))));
      child.stdout.on('data', s => { if (s.toString().includes('Code Health Center:')) { clearTimeout(timer); resolve(); } });
    });
    return child;
  } catch (error) { child.kill(); throw error; }
}

/** 实际点击、输入并核对可见结果；step 为顺序场景，失败后剩余场景明确未执行。 */
async function runBrowserRegression(options = {}) {
  const root = path.resolve(__dirname, '..'), id = options.id || process.env.HEALTH_UI_REPORT_ID || crypto.randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('报告编号不正确');
  const output = options.output || process.env.HEALTH_UI_REPORT_FILE || path.join(root, 'outputs', 'browser-check', `report-${id}.json`);
  const report = { id, kind: 'browser', node: process.version, startedAt: new Date().toISOString(), status: 'FAILED', checks: [], scenarios: [], images: [],
    limits: ['真实浏览器操作针对全新的隔离示例，不写入正式项目。', '验证固定平台流程，不代表所有项目业务、浏览器或真实 Java 构建已通过。'] };
  let child, browser, page, temporary;
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report));
  if (options.onStart) await options.onStart(report);
  // 初始化保存失败时不留下长时间定时器，避免进程无故等待。
  const deadline = setTimeout(() => { page?.close().catch(() => {}); browser?.close().catch(() => {}); child?.kill(); }, 150000);
  try {
    report.sourceSnapshot = await sourceSnapshot(root);
    const { chromium } = require('playwright');
    const channel = process.env.HEALTH_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium');
    if (!['msedge', 'chrome', 'chromium'].includes(channel)) throw Error('浏览器渠道不支持');
    report.browser = channel;
    browser = await chromium.launch({ headless: true, ...(channel !== 'chromium' ? { channel } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'health-browser-'));
    const source = path.join(temporary, 'source'); await fs.mkdir(source);
    const sourceFile = path.join(source, 'Flow.java'), original = 'class Flow {}';
    await fs.writeFile(sourceFile, original); await fs.writeFile(path.join(source, 'pom.xml'), '<project/>');
    const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port; await new Promise(r => probe.close(r));
    const base = `http://127.0.0.1:${port}`;
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    child = await startServer(root, path.join(temporary, 'data'), port);
    const read = async route => { const r = await fetch(base + route); assert.equal(r.status, 200); return r.json(); };
    const close = async () => { if (await page.locator('#dialog').isVisible()) await page.getByRole('button', { name: '关闭', exact: true }).click(); };
    const nav = async name => {
      await close(); const link = page.locator('#navigation').getByRole('link', { name: new RegExp(name) });
      const target = (await link.getAttribute('href')).slice(1); await link.click();
      // 点击后等待实际页面渲染，避免在 hashchange 到达前检查上一个页面的数据。
      await page.waitForFunction(id => document.querySelector('#navigation a.active')?.dataset.page === id, target);
    };
    const add = async () => {
      await page.locator('#content .page-heading [data-action="add-project"]').click();
      await page.getByLabel('项目名称', { exact: true }).fill('页面自动回归示例');
      await page.getByLabel('项目 Key', { exact: true }).fill('browser-regression');
      await page.getByLabel('项目根目录', { exact: true }).fill(source);
      await page.locator('#project-form').getByRole('button', { name: '添加项目', exact: true }).click();
    };
    let scanId, projectId;
    const actions = {
      project: async () => { await page.goto(base + '/#projects'); await add(); await page.locator('#project-form').waitFor({ state: 'hidden' }); assert.equal((await read('/api/state')).projects.length, 1); },
      duplicate: async () => { await add(); await page.locator('#project-form .form-error').waitFor(); assert.equal((await read('/api/state')).projects.length, 1); await close(); },
      scan: async () => {
        await page.locator('[data-action="scan-project"]').click();
        await page.locator('#scan-form').getByRole('button', { name: '开始检查', exact: true }).click();
        for (let i = 0; i < 300; i++) {
          const s = await read('/api/state');
          if (s.scans[0]?.status === 'completed' && !s.active) { scanId = s.scans[0].id; projectId = s.projects[0].id; break; }
          await new Promise(r => setTimeout(r, 50));
        }
        assert.ok(scanId, '扫描未实际完成');
        await page.locator('#content table').getByText('已完成', { exact: true }).waitFor();
        await page.getByRole('button', { name: '查看详情', exact: true }).click();
      },
      acceptance: async () => {
        await page.getByRole('button', { name: '查看当前验收条件', exact: true }).click();
        await page.locator('#acceptance-form').waitFor();
        for (const c of (await read('/api/state')).checklist) {
          await page.getByLabel(c.name, { exact: true }).check();
          await page.getByLabel(c.name + '验证证据', { exact: true }).fill('浏览器自动回归实际保存与读取，验证平台流程，不代表项目业务验收。');
        }
        await page.getByRole('button', { name: '保存验收记录', exact: true }).click();
        await page.locator('#acceptance-form').waitFor({ state: 'hidden' });
        await nav('项目管理');
        await page.getByRole('button', { name: '现在可以验收吗？', exact: true }).click();
        await page.getByText('本次范围可验收', { exact: true }).waitFor();
      },
      download: async () => {
        await nav('扫描历史'); await page.getByRole('button', { name: '查看详情', exact: true }).click();
        await page.getByRole('button', { name: '导出报告', exact: true }).click();
        const downloaded = page.waitForEvent('download'); await page.getByRole('link', { name: '下载副本', exact: true }).click();
        const download = await downloaded; const downloadedPath = path.join(temporary, 'download.json'); await download.saveAs(downloadedPath);
        const result = JSON.parse(await fs.readFile(downloadedPath, 'utf8')); assert.equal(result.id, scanId);
      },
      pipeline: async () => {
        await nav('验收流水线'); await page.getByRole('button', { name: '建立验收方案', exact: true }).click();
        await page.getByLabel('要求完整构建、自动测试和质量分析', { exact: true }).uncheck();
        await page.getByLabel('要求扫描时绑定完整任务约定', { exact: true }).uncheck();
        await page.getByLabel('已按实际业务检查和调整这些场景', { exact: true }).check();
        await page.getByRole('button', { name: '保存方案版本', exact: true }).click();
        await page.locator('#pipeline-plan-form').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '按方案执行', exact: true }).click();
        await page.getByRole('button', { name: '填写交付验收证据', exact: true }).waitFor();
        for (let i = 0; i < 300 && (await read('/api/state')).active; i++) await new Promise(r => setTimeout(r, 50));
        await page.getByRole('button', { name: '重新核对流水线', exact: true }).click();
        await page.getByText('正常主流程 · 必测 · 未验证', { exact: true }).click();
        await page.getByRole('button', { name: '记录场景结果', exact: true }).click();
        await page.getByLabel('本次场景结果', { exact: true }).selectOption('failed');
        await page.getByLabel('实际结果或不适用原因', { exact: true }).fill('浏览器自动回归故意登记失败，验证阻断行为。');
        await page.getByLabel('验证方式与结果证据', { exact: true }).fill('在隔离实例提交失败记录，必须显示验收受阻。');
        await page.getByRole('button', { name: '保存场景结果', exact: true }).click();
        await page.getByRole('heading', { name: '验收受阻', exact: true }).waitFor();
        await page.getByText('正常主流程 · 必测 · 失败', { exact: true }).click();
        await page.getByRole('button', { name: '记录场景结果', exact: true }).click();
        await page.getByLabel('本次场景结果', { exact: true }).selectOption('passed');
        await page.getByLabel('实际结果或不适用原因', { exact: true }).fill('浏览器实际复验记录成功，其他未执行场景保持待验。');
        await page.getByRole('button', { name: '保存场景结果', exact: true }).click();
        await page.getByText('正常主流程 · 必测 · 通过', { exact: true }).click();
        await page.getByRole('button', { name: '记录场景结果', exact: true }).click();
        await page.getByText('之前的记录（1）', { exact: true }).waitFor();
      },
      stale: async () => {
        await fs.writeFile(sourceFile, 'class Flow { int changed; }'); await nav('项目管理');
        await page.getByRole('button', { name: '现在可以验收吗？', exact: true }).click();
        await page.getByText('验收受阻', { exact: true }).waitFor();
        await page.getByText('STALE', { exact: true }).waitFor();
        await fs.writeFile(sourceFile, original);
      },
      paging: async () => {
        const existingIds = new Set((await read('/api/state')).scans.map(scan => scan.id));
        await fs.writeFile(sourceFile, 'class Flow {\n' + Array.from({ length: 62 }, (_, n) => `void m${n}() { try { throw new RuntimeException(); } catch (Exception e) {} }`).join('\n') + '\n}');
        await nav('项目管理'); await page.locator('[data-action="scan-project"]').click();
        await page.locator('#scan-form').getByRole('button', { name: '开始检查', exact: true }).click();
        let reportId;
        for (let i = 0; i < 300; i++) {
          const state = await read('/api/state');
          if (!state.active && state.scans[0]?.status === 'completed' && !existingIds.has(state.scans[0].id)) { reportId = state.scans[0].id; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(reportId, '大量问题扫描没有完成');
        const view = await read('/api/scan/view?id=' + reportId);
        assert.equal(view.issueCount, 62); assert.equal(view.issues, undefined); assert.equal(view.sourceSnapshot.files, undefined);
        await nav('扫描历史'); await page.locator(`[data-action="scan-detail"][data-id="${reportId}"]`).click();
        await page.getByRole('button', { name: '修复任务清单', exact: true }).click();
        for (const [count, range] of [[25, '1–25'], [25, '26–50'], [12, '51–62']]) {
          await page.getByText('显示第 ' + range + ' 条，共 62 条', { exact: true }).waitFor();
          assert.equal(await page.locator('#dialog .repair-task').count(), count);
          if (count !== 12) await page.getByRole('button', { name: '下一页', exact: true }).click();
        }
        assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).count(), 0);
        await page.getByRole('button', { name: '上一页', exact: true }).click();
        await page.getByText('显示第 26–50 条，共 62 条', { exact: true }).waitFor();
        const taskImage = `browser-${id}-task-page.png`;
        await page.screenshot({ path: path.join(path.dirname(output), taskImage) }); report.images.push(taskImage);
        await page.locator('#dialog .repair-task').first().getByRole('button', { name: '审查问题', exact: true }).click();
        await page.getByLabel('判断依据（8 到 2000 字）', { exact: true }).fill('自动回归确认第二页问题审查可以保存，保持原门禁不变。');
        await page.getByRole('button', { name: '保存审查', exact: true }).click();
        await page.locator('#issue-review-form').waitFor({ state: 'hidden' });
        await page.getByText('显示第 26–50 条，共 62 条', { exact: true }).waitFor();
        await page.getByText('自动回归确认第二页问题审查可以保存，保持原门禁不变。', { exact: true }).waitFor();
        await page.locator('#dialog .repair-task').nth(1).getByRole('button', { name: '审查问题', exact: true }).click();
        await page.getByLabel('审查状态', { exact: true }).selectOption('confirmed');
        await page.getByLabel('判断依据（8 到 2000 字）', { exact: true }).fill('连续审查第二个问题，确认依据保存并回到同一页。');
        const reviewImage = `browser-${id}-review-return.png`;
        await page.screenshot({ path: path.join(path.dirname(output), reviewImage) }); report.images.push(reviewImage);
        await page.getByRole('button', { name: '保存审查', exact: true }).click();
        await page.getByText('显示第 26–50 条，共 62 条', { exact: true }).waitFor();
        await page.getByText('连续审查第二个问题，确认依据保存并回到同一页。', { exact: true }).waitFor();
        await page.locator('#dialog .repair-task').nth(2).getByRole('button', { name: '审查问题', exact: true }).click();
        await page.getByRole('button', { name: '返回修复清单', exact: true }).click();
        await page.getByText('显示第 26–50 条，共 62 条', { exact: true }).waitFor();
        const full = await read('/api/report?id=' + reportId);
        assert.equal(full.issues.length, 62); assert.ok(full.issues.some(issue => issue.review?.reason.includes('第二页')));
        assert.equal(full.issues.filter(issue => issue.review?.reason).length, 2); assert.equal(full.gate.status, 'FAILED');
        await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
        const downloaded = page.waitForEvent('download'); await page.getByRole('link', { name: '下载副本', exact: true }).click();
        const download = await downloaded, file = path.join(temporary, 'all-tasks.md'); await download.saveAs(file);
        assert.equal((await fs.readFile(file, 'utf8')).match(/^## \d+\. /gm).length, 62);
        await fs.writeFile(sourceFile, original);
      },
        setup: async () => {
          await nav('环境设置');
          assert.equal(await page.locator('#full-setup').getAttribute('open'), null);
          await page.getByText('本地规则检查', { exact: true }).waitFor();
          await page.getByRole('link', { name: '配置完整体检', exact: true }).click();
          await page.getByLabel('SonarQube 地址', { exact: true }).fill('https://example.com');
          await page.getByRole('button', { name: '保存设置', exact: true }).click();
          await page.locator('#settings-form .form-error').waitFor();
          assert.notEqual((await read('/api/state')).settings.sonarUrl, 'https://example.com');
          await page.getByLabel('SonarQube 地址', { exact: true }).fill('http://localhost:9000');
          await page.getByRole('button', { name: '保存设置', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('#full-setup').open);
          assert.equal((await read('/api/state')).settings.sonarUrl, 'http://localhost:9000');
        },
        'work-sync': async () => {
          /** Independent participants use the real API; the page must notice changes on its own timer. */
          const write = async (route, payload, token, expected = 200) => {
            const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(payload) });
            const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
          };
          await nav('需求与任务');
          await page.getByRole('button', { name: '新增需求', exact: true }).click();
          await page.getByLabel('名称', { exact: true }).fill('协作回归需求');
          await page.getByLabel('需求说明', { exact: true }).fill('两个本地 agent 协作完成一份说明');
          await page.getByLabel('验收条件', { exact: true }).fill('页面及时显示真实领取和提交，人工审核');
          await page.getByLabel('允许改动范围与约束', { exact: true }).fill('仅 docs，不改动业务源码');
          await page.getByRole('button', { name: '保存需求', exact: true }).click();
          await page.getByRole('button', { name: '新增关联任务', exact: true }).click();
          await page.getByLabel('名称', { exact: true }).fill('协作回归文档任务');
          await page.getByLabel('任务说明', { exact: true }).fill('编写说明并按真实记录提交证据');
          await page.getByLabel('完成前要求实际扫描验收通过', { exact: true }).uncheck();
          await page.getByRole('button', { name: '保存任务', exact: true }).click();
          await page.getByRole('button', { name: '人工领取任务', exact: true }).waitFor(); await close();
          await page.getByRole('button', { name: '查看任务列表', exact: true }).click();
          await page.locator('#work-records tr').filter({ hasText: '协作回归文档任务' }).waitFor();
          const task = (await read('/api/work/list?kind=tasks')).rows.find(t => t.title === '协作回归文档任务'); assert.ok(task);
          const a = await write('/api/work/agents/register', { name: 'Sync agent A', projectIds: [projectId] });
          const b = await write('/api/work/agents/register', { name: 'Sync agent B', projectIds: [projectId] });
          let pageReads = 0; const count = req => { if (new URL(req.url()).pathname === '/api/work/list') pageReads++; }; page.on('request', count);
          try {
            await page.waitForResponse(r => new URL(r.url()).pathname === '/api/work/sync');
            assert.equal(pageReads, 0, 'Unchanged sync must not reload the list');
            await page.getByLabel('搜索需求任务与知识', { exact: true }).fill('尚未执行的搜索草稿');
            await page.getByRole('button', { name: '新增任务', exact: true }).click();
            await page.getByLabel('名称', { exact: true }).fill('正在编辑的任务草稿');
            const claimed = (await write('/api/agent/task', { id: task.id, expectedVersion: task.version, action: 'claim' }, a.token)).row;
            await write('/api/agent/task', { id: task.id, expectedVersion: claimed.version, action: 'claim' }, b.token, 409);
            await page.waitForFunction(() => document.querySelector('#work-records').textContent.includes('Sync agent A'));
            assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), '正在编辑的任务草稿');
            assert.equal(await page.getByLabel('搜索需求任务与知识', { exact: true }).inputValue(), '尚未执行的搜索草稿');
            await close(); await page.locator('#work-records [data-action="work-detail"]').click();
            const submitted = (await write('/api/agent/task', { id: task.id, expectedVersion: claimed.version, action: 'submit', submission: { summary: '实际完成代表性说明并核对处理流程', tests: '此回归核对协作流程，未声称业务测试已完成', changedFiles: ['docs/example.md'] } }, a.token)).row;
            await page.waitForFunction(() => document.querySelector('#work-records').textContent.includes('待人工审核'));
            assert.equal(await page.locator('#dialog').isVisible(), true); await close();
            await page.locator('#work-records [data-action="work-detail"]').click();
            await page.getByRole('button', { name: '审核通过', exact: true }).click();
            await page.getByLabel('审核或操作理由（至少 8 字）', { exact: true }).fill('实际核对代表性协作证据，人工确认流程');
            await page.getByRole('button', { name: '确认保存', exact: true }).click();
            await page.getByRole('button', { name: '沉淀为知识草稿', exact: true }).waitFor();
            assert.equal((await read('/api/work/detail?kind=tasks&id=' + submitted.id)).row.status, 'done');
            await page.getByRole('button', { name: '沉淀为知识草稿', exact: true }).click();
            await page.getByLabel('问题表现', { exact: true }).fill('协作页面需要及时显示参与者状态');
            await page.getByLabel('原因', { exact: true }).fill('多人分别领取与提交，需要查看最新状态');
            await page.getByRole('button', { name: '保存草稿', exact: true }).click();
            await page.getByRole('button', { name: '审核并发布', exact: true }).waitFor(); await close();
            await nav('问题知识库'); await page.locator('#work-records').getByText('待审核草稿', { exact: true }).waitFor();
            const draft = (await read('/api/work/list?kind=knowledge')).rows[0];
            await write('/api/work/knowledge/publish', { id: draft.id, expectedVersion: draft.version, publish: true, reason: '人工核对来源与代表性处理证据后发布' });
            await page.locator('#work-records').getByText('已发布', { exact: true }).waitFor();
            await page.setViewportSize({ width: 390, height: 844 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
            await page.setViewportSize({ width: 1280, height: 800 });
          } finally { page.off('request', count); }
        },
        release: async () => {
          await nav('扫描历史');
          await page.locator(`[data-action="scan-detail"][data-id="${scanId}"]`).click();
          await page.getByRole('button', { name: '关闭', exact: true }).click();
          await page.waitForFunction(() => document.querySelector('#dialog-content').childElementCount === 0);
          await nav('问题中心'); await page.locator('#content .issue-row, #content .empty').first().waitFor();
          await nav('环境设置');
          assert.equal(await page.evaluate(() => Object.keys(listData).length), 0);
          assert.equal(await page.evaluate(() => Object.keys(listRequests).length), 0);
          await nav('需求与任务'); await page.getByRole('heading', { name: /^(需求|任务)记录$/ }).waitFor();
          await nav('环境设置');
          assert.equal(await page.evaluate(() => workData === null && workController === null && workSyncController === null && workSyncTimer === null), true);
        },
        mobile: async () => {
          await close(); await page.setViewportSize({ width: 390, height: 844 }); await nav('验收流水线');
          await page.getByRole('button', { name: '展开功能导航', exact: true }).click();
          assert.equal(await page.getByRole('button', { name: '收起功能导航', exact: true }).getAttribute('aria-expanded'), 'true');
          assert.equal(await page.locator('#navigation [data-page="settings"]').evaluate(el => parseFloat(getComputedStyle(el).fontSize) > 0), true);
          await page.getByRole('button', { name: '收起功能导航', exact: true }).click();
          assert.equal(await page.getByRole('button', { name: '展开功能导航', exact: true }).getAttribute('aria-expanded'), 'false');
          await page.getByRole('button', { name: '展开功能导航', exact: true }).click();
          await nav('验收流水线');
          assert.equal(await page.getByRole('button', { name: '展开功能导航', exact: true }).getAttribute('aria-expanded'), 'false');
        await page.getByRole('heading', { name: '验收流水线', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        await page.getByRole('button', { name: '查看流水线', exact: true }).first().click();
        await page.getByRole('heading', { name: '验收流水线报告', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.querySelector('#dialog').getBoundingClientRect().width <= document.documentElement.clientWidth), true);
      }
    };
    for (const [key, name] of scenarios) {
      const entry = { id: key, name, status: 'FAILED', startedAt: new Date().toISOString() }; report.scenarios.push(entry);
      try { await actions[key](); assert.equal(pageErrors.length, 0, pageErrors.join('\n')); entry.status = 'PASSED'; }
      catch (error) { entry.error = error.message.slice(0, 3000); throw error; }
      finally {
        entry.finishedAt = new Date().toISOString();
        const image = `browser-${id}-${key}.png`; await page.screenshot({ path: path.join(path.dirname(output), image) }).then(() => { report.images.push(image); }, () => {});
      }
    }
    report.sourceCheck = compareSnapshot(report.sourceSnapshot, await sourceSnapshot(root));
    if (report.sourceCheck.status !== 'CURRENT') throw Error('页面回归期间平台源码变化，请重新执行');
    report.status = 'PASSED';
  } catch (error) { report.error = error.message.slice(0, 3000); }
  finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => {});
    if (child?.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(error => { report.status = 'FAILED'; report.error = '隔离环境清理失败：' + error.message; });
    for (const [key, name] of scenarios) if (!report.scenarios.some(s => s.id === key)) report.scenarios.push({ id: key, name, status: 'NOT_RUN' });
    report.checks = report.scenarios.map(s => ({ name: s.name, passed: s.status === 'PASSED', detail: s.error || (s.status === 'PASSED' ? '真实浏览器流程完成' : '未执行，不能计为通过') }));
    report.finishedAt = new Date().toISOString(); await fs.writeFile(output + '.tmp', JSON.stringify(report, null, 2)); await fs.rename(output + '.tmp', output);
  }
  return { report, file: output };
}
module.exports = { runBrowserRegression, scenarios };
if (require.main === module) runBrowserRegression().then(({ report, file }) => {
  console.log(JSON.stringify({ status: report.status, passed: report.scenarios.filter(s => s.status === 'PASSED').length, total: scenarios.length, file, error: report.error }));
  if (report.status !== 'PASSED') process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
