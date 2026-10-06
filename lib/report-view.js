const { summarize } = require('./report-store');

/** Build display evidence from a full report without exposing its findings, manifests or review history.
 * report is a persisted or running report; the original object remains unchanged for exports and acceptance.
 */
function reportView(report) {
  const view = summarize(report);
  for (const key of ['archivedAt', 'logs', 'policy', 'buildTests', 'sonarGate', 'acceptanceSourceCheck', 'notes']) {
    if (report[key] !== undefined) view[key] = report[key];
  }
  if (report.changes) view.changes = { description: report.changes.description };
  if (report.sourceSnapshot) {
    const saved = report.sourceSnapshot;
    view.sourceSnapshot = { digest: saved.digest, scope: saved.scope, fileCount: saved.files.length };
  }
  // Detail pages only need to know that a separate pipeline report is available.
  if (report.acceptancePipeline) view.acceptancePipeline = true;
  if (report.comparison) {
    const diff = report.comparison;
    view.comparison = diff.available ? { available: true, baselineId: diff.baselineId,
      addedCount: diff.added.length, removedCount: diff.removed.length, unchanged: diff.unchanged, delta: diff.delta }
      : { available: false, reason: diff.reason };
  }
  return view;
}
module.exports = { reportView };
