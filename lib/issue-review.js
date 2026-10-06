const crypto = require('node:crypto');
const states = ['open', 'confirmed', 'fixing', 'dismissed'];

/** report is a completed scan; return stable per-occurrence IDs without keeping source text. */
function identify(report) {
  const counts = new Map(), hashes = new Map((report.sourceSnapshot?.files || []).map(f => [f.file, f.sha256]));
  const bases = (report.issues || []).map(issue => {
    // Masked evidence cannot distinguish changed secrets. Require the entire file fingerprint in that case.
    const sensitive = issue.rule === 'hardcoded-secret' || /REDACTED|已脱敏/i.test(issue.excerpt || '');
    const content = issue.type === 'LOCAL' ? [issue.rule, issue.file, issue.severity, issue.excerpt || issue.message, sensitive ? hashes.get(issue.file) || report.id : ''] : [issue.id, issue.rule, issue.file, issue.severity, issue.message, issue.excerpt];
    return crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
  });
  const totals = new Map();
  for (const base of bases) totals.set(base, (totals.get(base) || 0) + 1);
  return (report.issues || []).map((issue, index) => {
    // Identical duplicates have no unique semantic identity; changed files must not inherit another occurrence's dismissal.
    const base = totals.get(bases[index]) > 1 ? crypto.createHash('sha256').update(bases[index] + (hashes.get(issue.file) || report.id)).digest('hex') : bases[index];
    const occurrence = counts.get(base) || 0; counts.set(base, occurrence + 1);
    return { ...issue, trackingId: `${base}-${occurrence}` };
  });
}

/** Carry decisions only within the same project/repository, scope, mode and rule configuration. */
function compatible(a, b) {
  return b && a.status === 'completed' && b.status === 'completed' &&
    a.projectId === b.projectId && a.repository === b.repository && a.number === b.number &&
    (a.scope || 'project') === (b.scope || 'project') && a.mode === b.mode &&
    (a.settings?.localRuleVersion || 1) === (b.settings?.localRuleVersion || 1) &&
    JSON.stringify([...(a.settings?.enabledRules || [])].sort()) === JSON.stringify([...(b.settings?.enabledRules || [])].sort());
}

/** Attach previous decisions to identical findings; disappearing or changed findings reopen, with prior reasons retained. */
function carryReviews(report, previous) {
  report.issues = identify(report);
  const ledger = compatible(report, previous) ? structuredClone(previous.issueReviewLedger || []) : [];
  const old = new Map(ledger.map(row => [row.trackingId, row]));
  const current = new Set(report.issues.map(i => i.trackingId));
  const present = new Set(compatible(report, previous) ? identify(previous).map(i => i.trackingId) : []);
  for (const issue of report.issues) {
    const exact = old.get(issue.trackingId);
    if (exact && present.has(issue.trackingId)) issue.review = structuredClone(exact.review);
    else {
      const prior = exact || ledger.find(row => !current.has(row.trackingId) && row.rule === issue.rule && row.file === issue.file);
      if (prior) {
        const decision = prior.review.status === 'open' && prior.review.prior ? prior.review.prior : prior.review;
        issue.review = { status: 'open', reason: '', event: exact ? 'returned' : 'changed', prior: { status: decision.status, reason: decision.reason, updatedAt: decision.updatedAt } };
      }
    }
    if (exact && issue.review) exact.review = structuredClone(issue.review);
  }
  report.issueReviewLedger = ledger;
  return report;
}

/** Validate one decision for an identified finding. Reasons are required and never alter automatic gates. */
function setReview(report, trackingId, status, reason) {
  if (report.status !== 'completed') throw Error('检查未完成，不能审查问题');
  if (!states.includes(status) || typeof reason !== 'string' || reason.trim().length < 8 || reason.length > 2000) throw Error('请选择有效状态，并填写 8 到 2000 字的审查理由');
  report.issues = identify(report);
  const issue = report.issues.find(i => i.trackingId === trackingId);
  if (!issue) throw Error('问题不存在或已变化，请重新读取');
  const ledger = structuredClone(report.issueReviewLedger || []);
  let row = ledger.find(r => r.trackingId === trackingId);
  if (!row && ledger.length >= 10000) throw Error('审查记录达到 10,000 条上限；请使用新的检查范围');
  const history = [...(issue.review?.history || [])];
  if (issue.review?.updatedAt) history.push({ status: issue.review.status, reason: issue.review.reason, updatedAt: issue.review.updatedAt });
  if (history.length >= 50) throw Error('单个问题已达到 50 次审查上限；原记录保留');
  const review = { ...issue.review, status, reason: reason.trim(), updatedAt: new Date().toISOString(), history };
  if (!row) { row = { trackingId, rule: issue.rule, file: issue.file }; ledger.push(row); }
  row.review = structuredClone(review);
  // Bound authored evidence as well as row counts; rejection retains the previous persisted decision.
  if (Buffer.byteLength(JSON.stringify(ledger), 'utf8') > 2 * 1024 * 1024) throw Error('审查证据超过 2 MB 保存上限；原记录保留');
  issue.review = review; report.issueReviewLedger = ledger;
  return issue;
}
module.exports = { identify, compatible, carryReviews, setReview, states };
