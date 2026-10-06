const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { mavenProbeArgs } = require('./environment');
const { request } = require('./sonar');
const { changedLines } = require('./git-changes');
const execute = promisify(execFile);

/** Check prerequisites for this project and mode without builds, installations or container startup. */
async function preflight(project, settings, token, mode, scope) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  const root = await fs.stat(project.path).catch(() => null);
  add('项目目录', !!root?.isDirectory(), root?.isDirectory() ? '目录可访问' : '目录不存在，请编辑项目路径');
  add('Maven 项目', await fs.access(path.join(project.path, 'pom.xml')).then(() => true).catch(() => false), '项目根目录需要 pom.xml');
  if (scope === 'changed') {
    try { const changes = await changedLines(project.path); add('Git 改动范围', true, `${changes.files.length} 个 Java / SQL 改动文件`); }
    catch (error) { add('Git 改动范围', false, error.message); }
  }
  if (mode === 'full') {
    await Promise.all([['JDK 8', settings.java8Home, /version "1\.8\./], ['JDK 21', settings.java21Home, /version "21(?:\.|\")/]].map(async ([name, home, pattern]) => {
      try {
        if (!home) throw new Error('请在环境设置中填写安装目录');
        await fs.access(path.join(home, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac'));
        const result = await execute(path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-version'], { encoding: 'utf8', timeout: 6000, windowsHide: true });
        const correct = pattern.test(result.stdout + result.stderr);
        add(name, correct, correct ? '版本匹配，可使用' : '版本不匹配，请选择正确的完整 JDK');
      } catch { add(name, false, '未找到对应版本的完整 JDK，请检查安装目录'); }
    }));
    const wrapper = path.join(project.path, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw');
    if (await fs.access(wrapper).then(() => true).catch(() => false)) add('Maven', true, '使用项目自带的 Maven Wrapper');
    else {
      try {
        const env = { ...process.env, ...(settings.java8Home ? { JAVA_HOME: settings.java8Home, PATH: `${path.join(settings.java8Home, 'bin')}${path.delimiter}${process.env.PATH || ''}` } : {}) };
        await execute(process.platform === 'win32' ? 'powershell.exe' : 'mvn', process.platform === 'win32' ? mavenProbeArgs() : ['-version'], { env, timeout: 6000, windowsHide: true });
        add('Maven', true, 'Maven 可运行');
      } catch { add('Maven', false, '安装 Maven，或使用带 mvnw.cmd 的项目'); }
    }
    add('Analysis Token', !!token, token ? '已设置；不会写入报告' : '请在环境设置中填写 SONAR_TOKEN');
    try {
      const status = await request(settings.sonarUrl, '/api/system/status', token);
      add('SonarQube', status.status === 'UP', status.status === 'UP' ? '服务已就绪' : `服务状态：${status.status}`);
      if (token) { const auth = await request(settings.sonarUrl, '/api/authentication/validate', token); add('Token 验证', auth.valid === true, auth.valid ? '凭据有效' : 'Token 无效，请重新生成'); }
    } catch { add('SonarQube', false, '服务不可访问，检查环境设置中的地址与服务状态'); }
  }
  return { ready: checks.every(c => c.passed), checks, checkedAt: new Date().toISOString(), mode, scope };
}
module.exports = { preflight };
