/** 功能路线只提供已有入口，明确各项结果的范围，不新增后台任务。 */
function workflowGuide() {
  return `<div class="info-grid workflow-guide">${[
    ['01 / 检查', '发现代码问题', '登记项目 → 本地规则检查 → 查看问题。无需配置 JDK 或 SonarQube。', 'projects', '管理项目'],
    ['02 / 验收', '确认本次交付', '设置场景 → 实际测试 → 保存证据。门禁通过与业务验收分别确认。', 'pipeline', '进入验收'],
    ['03 / 协作', '跟踪任务与经验', '定义需求 → 人或 agent 处理 → 你审核 → 沉淀知识。', 'work', '管理任务']
  ].map(([step, title, text, route, link]) => `<article class="info-tile"><div class="number">${step}</div><h3>${title}</h3><p>${text}</p><a class="text-link" href="#${route}">${link} →</a></article>`).join('')}</div>`;
}

/** 可选配置保持原表单与操作，只收起不常用内容，避免抢占主流程。 */
function optionalPanel(title, body) {
  return `<details class="setup-section"><summary>${title} · 可选</summary>${body}</details>`;
}

/** 本地检查零额外配置；完整体检与服务管理按需展开，原配置接口和凭据规则保持一致。 */
function setupPage() {
  const names = { node: 'Node.js', docker: 'Docker（可选）', maven: 'Maven', jdk8: 'JDK 8', jdk21: 'JDK 21', sonar: 'SonarQube', token: 'Analysis Token' };
  return heading('环境设置', '先用本地检查；需要构建、测试和质量分析时，再配置完整体检。', button('运行状态', 'runtime') + button('检查环境', 'environment')) +
    panel('按需配置', `<div class="panel-body"><div class="setup-options"><article><span class="badge good">现在可用</span><h3>本地规则检查</h3><p>添加项目即可检查 Java / SQL 规则与本次 Git 改动。无需额外配置；不执行编译、测试或覆盖率分析。</p><a class="button primary" href="#projects">管理项目</a></article><article><span class="badge">可选增强</span><h3>完整体检</h3><p>需要 JDK 8、JDK 21、Maven 与本机 SonarQube，实际构建、运行测试并读取质量分析。</p><a class="button" href="#settings" data-action="setup-full">配置完整体检</a></article></div><p class="subtle">任务、知识库和本地 agent 协作无需 SonarQube。agent 目前支持任务与证据提交，直接扫描和问题审查尚未开放到 agent 接口。</p></div>`) +
    `<details id="full-setup" class="setup-section"><summary>完整体检配置 · 可选</summary><div class="panel-body"><form id="settings-form"><div class="form-grid"><div class="field wide"><label for="sonarUrl">SonarQube 地址</label><input id="sonarUrl" name="sonarUrl" value="${e(state.settings.sonarUrl)}" required><small>仅本机地址，如 http://127.0.0.1:9000。</small></div><div class="field"><label for="java8Home">JDK 8 安装目录</label><input id="java8Home" name="java8Home" value="${e(state.settings.java8Home)}" placeholder="用于编译与测试"><small>也可在启动前设置 JAVA8_HOME。</small></div><div class="field"><label for="java21Home">JDK 21 安装目录</label><input id="java21Home" name="java21Home" value="${e(state.settings.java21Home)}" placeholder="用于质量分析"><small>也可在启动前设置 JAVA21_HOME。</small></div><div class="field wide"><label for="token">Analysis Token</label><input id="token" name="token" type="password" autocomplete="off" placeholder="${state.tokenConfigured ? '已设置；留空保留' : '仅在本次运行中保存'}"><small>不写入配置或备份；也可设置 SONAR_TOKEN 环境变量。</small></div></div><div class="form-actions">${button('清除 Token', 'clear-token')}<button class="button primary" type="submit">保存设置</button></div></form></div></details>` +
    panel('运行环境', `<div class="panel-body">${environmentData ? `<div class="environment-grid">${Object.entries(environmentData).map(([id, item]) => `<div class="env-card"><strong>${e(names[id] || id)}<span class="${item.available ? 'green' : 'amber'}">${item.available ? '✓' : '○'}</span></strong><small>${e(item.detail)}</small></div>`).join('')}</div>` : '<p class="subtle">点击“检查环境”读取真实依赖状态，不安装软件或启动服务。只有完整体检需要这些依赖。</p>'}</div>`) +
    panel('备份与迁移', `<div class="panel-body"><p>保存项目、报告、需求任务、知识与验收证据。凭据和项目源码不包含在备份中。</p>${button('创建数据备份', 'backup', '', 'primary')}<details><summary>恢复与迁移说明</summary><p class="subtle">检查完成后创建备份。恢复到不存在的新目录，原数据不覆盖；迁移后核对项目路径并重新授权 agent。恢复命令见使用说明。</p></details></div>`) +
    `<details class="setup-section"><summary>SonarQube 服务管理 · 可选</summary><div class="panel-body"><p class="subtle">已有本机 SonarQube 可直接配置，不需要 Docker。下面的启动操作仅适用于已安装 Docker Desktop 的电脑；平台不会安装 Docker。停止服务保留数据。</p><div class="buttons">${button('启动 SonarQube', 'sonar-start')}${button('停止服务', 'sonar-stop')}<a class="button" href="${e(state.settings.sonarUrl)}" target="_blank" rel="noreferrer">打开 SonarQube ↗</a></div></div></details>`;
}

/** 离开列表后中止读取并释放页面缓存；记录仍在服务端，返回时按页重新读取。 */
function releaseViewMemory(next) {
  cancelDetailRead();
  for (const key of Object.keys(listData)) if (key !== next) delete listData[key];
  for (const key of Object.keys(listRequests)) if (key !== next) { listRequests[key].controller.abort(); delete listRequests[key]; }
  if (!['work', 'knowledge'].includes(next)) { stopWorkSync(); workData = null; }
  if (next !== 'quality') githubPullData = null;
}

document.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (control?.dataset.action === 'setup-full') {
    event.preventDefault(); const section = document.querySelector('#full-setup');
    section.open = true; section.scrollIntoView({ block: 'start', behavior: 'instant' }); section.querySelector('input').focus();
  }
  if (control?.dataset.action === 'toggle-navigation') setNavigation(!document.body.classList.contains('navigation-open'));
  if (event.target.closest('#navigation a')) setNavigation(false);
});

/** 窄屏允许展开文字菜单；状态只存在当前页面，不保存额外配置。 */
function setNavigation(open) {
  document.body.classList.toggle('navigation-open', open);
  const button = document.querySelector('.nav-toggle');
  button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-label', open ? '收起功能导航' : '展开功能导航');
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') setNavigation(false); });
// 图标菜单仍提供明确名称，供屏幕阅读器、键盘和自动操作定位。
document.querySelectorAll('#navigation a').forEach(link => {
  const text = link.textContent.replace(/^[^\u4e00-\u9fffA-Za-z]+/, '').replace(/\s*0$/, '').trim();
  link.setAttribute('aria-label', text); link.setAttribute('title', text);
});
let detailReadController = null;

/** Cancel an obsolete detail read when its dialog closes or a different view replaces it. */
function cancelDetailRead() {
  detailReadController?.abort(); detailReadController = null;
}

/** Start one detail read. Background reads must still belong to the visible running report.
 * kind identifies scan/pipeline polling; id is the report being loaded. Returns a cancellation signal and validity check.
 */
function beginDetailRead(background = false, kind = '', id = '') {
  const visible = () => $('#dialog').open && (kind === 'scan' ? viewedScanId === id : viewedPipelineId === id);
  if (background && (!visible() || detailReadController)) return null;
  cancelDetailRead();
  if (!background) { viewedScanId = null; viewedPipelineId = null; }
  const controller = new AbortController(); detailReadController = controller;
  return { signal: controller.signal, current: () => detailReadController === controller && !controller.signal.aborted && (!background || visible()) };
}
