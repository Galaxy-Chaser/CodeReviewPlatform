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
  ['stale', '源码变化阻断旧验收'], ['mobile', '窄屏导航与报告显示']
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
    const nav = async name => { await close(); await page.locator('#navigation').getByRole('link', { name: new RegExp(name) }).click(); };
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
      mobile: async () => {
        await close(); await page.setViewportSize({ width: 390, height: 844 }); await nav('验收流水线');
        await page.getByRole('heading', { name: '验收流水线', exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
        await page.getByRole('button', { name: '查看流水线', exact: true }).click();
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
