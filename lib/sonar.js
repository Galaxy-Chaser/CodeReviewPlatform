/** Fetch only the configured loopback SonarQube server, keeping tokens out of URLs and disk. */
async function request(base, endpoint, token, params = {}) {
  const url = new URL(endpoint, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error(`SonarQube 请求失败 (${response.status})：${endpoint}`);
  return response.json();
}

/** Import all issue pages; reject truncated responses rather than report misleading totals. */
async function issues(base, token, projectKey, newCode = false) {
  let result = [];
  for (let page = 1; page <= 20; page++) {
    const payload = await request(base, '/api/issues/search', token, {
      componentKeys: projectKey, resolved: 'false', ps: 500, p: page, ...(newCode ? { inNewCodePeriod: 'true' } : {})
    });
    result.push(...payload.issues);
    if (result.length >= payload.paging.total) return result;
  }
  throw new Error('SonarQube 问题超过 10,000 条，请在 SonarQube 中查看并缩小分析范围。');
}

/** Apply local thresholds to NEW code metrics; missing measures always produce an unknown result. */
function evaluateGate(metrics, newIssues, gate) {
  const severe = newIssues.filter(i => ['BLOCKER', 'CRITICAL'].includes(i.severity)).length;
  const security = newIssues.filter(i => i.type === 'VULNERABILITY').length;
  const checks = [
    { name: '新增严重问题', value: severe, target: '= 0', passed: severe === 0 },
    { name: '新增安全漏洞', value: security, target: '= 0', passed: security === 0 },
    { name: '新代码覆盖率', value: metrics.new_coverage ?? null, target: `≥ ${gate.coverage}%`, passed: metrics.new_coverage == null ? null : metrics.new_coverage >= gate.coverage },
    { name: '新代码重复率', value: metrics.new_duplicated_lines_density ?? null, target: `≤ ${gate.duplication}%`, passed: metrics.new_duplicated_lines_density == null ? null : metrics.new_duplicated_lines_density <= gate.duplication }
  ];
  return { status: checks.some(c => c.passed === false) ? 'FAILED' : checks.some(c => c.passed === null) ? 'UNKNOWN' : 'PASSED', checks };
}

/** Collect the completed analysis, including the server's own gate and separate hotspot counts. */
async function importAnalysis(settings, key, token) {
  const metricKeys = 'bugs,vulnerabilities,code_smells,security_hotspots,coverage,duplicated_lines_density,ncloc,complexity,new_coverage,new_duplicated_lines_density';
  const [measureData, allIssues, newIssues, sonarGate] = await Promise.all([
    request(settings.sonarUrl, '/api/measures/component', token, { component: key, metricKeys }),
    issues(settings.sonarUrl, token, key), issues(settings.sonarUrl, token, key, true),
    request(settings.sonarUrl, '/api/qualitygates/project_status', token, { projectKey: key })
  ]);
  const metrics = {};
  for (const m of measureData.component.measures) {
    const value = m.value ?? m.period?.value ?? m.periods?.[0]?.value;
    if (value !== undefined) metrics[m.metric] = Number(value);
  }
  return { metrics, sonarGate: sonarGate.projectStatus, gate: evaluateGate(metrics, newIssues, settings.gate),
    issues: allIssues.map(i => ({ id: i.key, rule: i.rule, file: i.component.split(':').slice(1).join(':'),
      line: i.line || 1, message: i.message, severity: i.severity, type: i.type, status: i.status })) };
}
module.exports = { request, importAnalysis, evaluateGate };
