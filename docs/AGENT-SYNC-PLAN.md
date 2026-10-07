# Agent collaboration improvement plan

## Iteration 1.21: lightweight collaboration sync

Done means the task and knowledge pages see committed changes from other participants within the next visible-page poll, without manual refresh, overlapping reads, or replacing unsaved input. Agents can query the same scoped change token from the API and CLI. Expiring leases trigger a changed token even without a write. Version conflicts, authorization, human review and existing quality gates remain enforced.

Implementation boundaries:

- No new runtime dependency, external model call, automatic agent launcher or source watcher.
- Poll visible collaboration pages every five seconds. Read full paginated records only after their scoped token changes; stop on navigation and pause while hidden.
- Keep only bounded record metadata for sync, never task text, evidence, credentials or full history. Maximum existing workspace remains 3,000 records / 8 MB.
- Tokens cover authorized projects and visible knowledge only. Requirement progress includes linked task changes. Search/status/page changes retain the existing pagination rules.
- Updating a list must preserve filters, search drafts, dialogs and saved editing versions. Failed sync preserves the last visible list and reports a retry state.
- These are trusted localhost participants. Task leases coordinate ownership; they do not isolate concurrent edits to the same source files. Changes to overlapping files still need separate checkouts or an agreed owner.

Test conditions:

1. Real HTTP and independent CLI: unchanged token, claim/submit/approve changes, cross-project exclusion, published-knowledge visibility, invalid kind/project, revocation and restart.
2. Controlled time: exact lease expiry changes the token; human claims do not expire. Requirement completion changes are included.
3. Controlled delayed page reads: one outstanding sync, stale filters/navigation cannot publish results, background/hidden-page pause, retry after failure.
4. Real browser: two authorized agents, duplicate claim rejection, live claim and submission updates, search and dialog drafts preserved, manual approval, knowledge publication, navigation cleanup and narrow layout.
5. Final full platform and browser acceptance must use matching current source evidence. Inspect the collaboration screenshot. Existing Java/Maven/Sonar limitations must remain explicit.

## Next verified increments

1. Better task handoff context: iteration 1.22 below; retain human review and stale evidence checks.
2. Optional standard report interchange: iteration 1.23 exports below; external analyzer import remains a separate increment with strict input validation and honest provenance.
3. Small review summaries and explicit scope choices; preserve complete exports and original gates.
4. Measure idle and representative large-workspace polling costs before selecting further memory improvements: iteration 1.24 below.

Each increment needs its own finish criteria, boundary tests and verified outcome. This is an ongoing objective; this iteration does not claim all future improvements are complete.

## Iteration 1.22: clear, consistent task handoff

Finish criteria: a single context response supplies the displayed task, current requirement and state-based next actions. Human and agent callers see current ownership, lease expiry, changed requirement versions, archival/history blockers and the next useful step. The task list marks changed requirements and its sync token includes linked requirement versions. Renewing an outdated task is rejected without changing its lease/history; release, return and rework remain possible. Old detail responses cannot reopen a closed dialog or replace a newer editor.

Boundaries: context describes a read-time snapshot and possible actions, not proof of code quality or a promise that a later write will succeed. Every write still checks versions, permissions, requirements and existing report gates. No source execution, new dependency, resident body cache or remote write is added. The current requirement's allowed scope and acceptance conditions are shown; these remain authored constraints, not a filesystem sandbox. Submissions record their original requirement identity/version, retain historical evidence and stay explicitly labeled when tied to older requirements even after task rebinding. Legacy submissions without a recorded version remain readable and are marked as unknown, requiring verification.

Verification: action availability is checked against actual task operations for human, owner agent and other agent across task states, exact expiry and changed requirements. HTTP/CLI checks cover changed-requirement context, scoped sync, rejected renew/submit, release and updated rework. Delayed reads test closing/replacing/retrying actual detail and editor functions. Evidence tests cover requirement updates, rebinding, independent/linked task changes, legacy records and invalid/foreign backup references. A real browser scenario edits a requirement during agent ownership, sees the warning automatically, opens current scope, releases/rebinds the task, preserves a newer unsaved editor during a delayed read, confirms the old-evidence warning after rebinding, and checks a narrow layout. Final full acceptance, independent review and portable-package checks remain required.

Verified outcome (2026-10-07): 128 automated tests and all 13 real Edge browser flows passed together, with matching source evidence in `outputs/iteration-check/report-e3756d8a-1e8f-44a6-8986-b2f6e1f55960.json`. Desktop and 390px handoff screenshots were inspected. Independent Standards and Spec reviews found no remaining issues after the evidence-version and delayed-editor fixes. Runtime dependencies are unchanged. This proves the recorded platform checks, not a real Java/Maven/Sonar build or every project requirement.

## Iteration 1.23: portable SARIF exports

Finish criteria: a completed local, changed-scope or fixed-commit PR report can be downloaded as SARIF 2.1.0 from its detail page and the existing export API. Every finding remains present, in its original tool's run, with its original rule, severity, message and safely encoded relative file location. Empty completed reports remain valid exports. Saved review states, original quality gate and recorded scope/version remain explicit; excluded findings are not suppressed or downgraded. Downloads survive backup and restore.

Boundaries: export only, no external report import, source execution, automatic GitHub upload, new runtime dependency or resident report cache. A maximum of 20,000 findings and 16 MiB UTF-8 output applies; exceeding either rejects the whole export instead of truncating. Reject absolute/traversal paths, malformed rows and unrecognized tool origin. Keep CodeHealth local rules separate from imported SonarQube issues, without inventing Sonar versions, security scores, line hashes or current-code proof. Only completed reports are accepted; a completed analysis with a failed/unknown quality gate can still be shared and keeps that gate. Missing line positions stay absent. Omit source excerpts, review prose, logs, configuration and absolute local source roots. Use a described, remappable source-root symbol as allowed by SARIF §3.14.14. Write results incrementally to a temporary file and publish atomically; failures leave no downloadable partial export.

Verification: unit checks cover mixed tools, all severity mappings, rule deduplication, duplicates, Unicode/reserved file characters, unknown lines, fixed PR commits, unchanged reports/platform and Sonar gates, empty and large outputs, invalid inputs and partial/failed writes. A controlled local Sonar response verifies the actual importer-to-export path preserves missing/null/zero line positions as unknown while retaining valid lines; page and Markdown rendering label unknown positions. Real HTTP tests verify download content/type, rejected incomplete requests, state preservation and backup/restore. A browser downloads empty and 62-finding SARIF reports and checks content beyond the visible page. Validate representative outputs against the official OASIS schema using isolated development tooling, then run full platform/browser acceptance, independent review and package checks. An actual GitHub upload is outside this iteration and is not claimed as verified.

References: [OASIS SARIF specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html), [official JSON schema](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json), [GitHub SARIF support](https://docs.github.com/en/code-security/reference/code-scanning/sarif-files/sarif-support), and [reviewdog SARIF input](https://github.com/reviewdog/reviewdog#sarif-format).

Verified outcome (2026-10-07): 137 automated tests and all 13 real Edge browser flows passed together, with matching source evidence in `outputs/iteration-check/report-a63d663c-6c88-461b-ac59-ff44915ec2f7.json`. Eight current exports, including 20,000 findings, passed the official OASIS JSON schema; isolated validation records are in `outputs/sarif-validation/validation-report.json`. Download, paging and 390px screenshots were inspected. Independent Standards and Spec reviews found no remaining issues after fixing missing Sonar positions and the source-dialog label. Runtime dependencies are unchanged. Actual GitHub uploads, reviewdog execution and real Java/Maven/Sonar builds remain outside this verified result.

## Iteration 1.24: measured collaboration polling

Finish criteria: a repeatable, isolated measurement covers 30 and 3,000 valid records, full/one-project/30-project scopes, published knowledge, and 20 authorized agents through the real HTTP service. Record core timing/CPU, response bytes, concurrent HTTP latency and actual service memory snapshots. Capture a baseline before choosing an optimization. If repeated marker generation has meaningful cost, reuse only bounded tokens for a committed metadata snapshot and prove equivalent behavior. Report measured changes without treating accelerated requests, memory snapshots or one machine as a universal limit.

Boundaries: no runtime dependency, source execution, remote write, longer browser polling interval, persistent cache or retained task/knowledge bodies. Any token reuse must cover the exact record kind, authorization scope and publication filter, expire at the next visible agent lease deadline, and recompute if the clock goes backwards. Changed committed metadata invalidates reuse; rejected writes and unauthorized requests cannot publish data. Cap retained scope entries, release old snapshots, and never expose credentials or record contents in measurement output. All fixtures and processes are isolated; user data remains untouched.

Verification: compare cached and uncached tokens for mixed scopes, linked requirements/tasks, unrelated changes, knowledge publication, human claims and exact/multiple lease boundaries, including backward time. Check cache capacity and released snapshots, real API revocation/restart, concurrent scopes and current list-token agreement. Existing delayed-read/edit-preservation/browser flows remain required. Run the measurement before and after on the same runtime, full platform/browser acceptance, independent Standards and Spec review, and portable-package checks.

Verified outcome (2026-10-07): 142 automated tests and all 13 real Edge browser flows passed together with current source evidence in `outputs/iteration-check/report-39131e4c-d478-4e64-a489-a9d55464df86.json`. The corrected, bounded measurement command ran sequentially against committed v1.23 and v1.24 with identical tool/runtime/fixture conditions; raw batch sums, summaries and source evidence were checked in `outputs/collaboration-measurement/comparison-v1.24.json`. In the 3,000-record sample, 30-project marker cost changed from about 0.3415 ms to 0.0047 ms per warm call, and the 20-agent HTTP burst median from 7.62 ms to 2.82 ms. The small HTTP sample did not show overall speedup; idle service memory stayed similar. A controlled GC probe collected an unreferenced old snapshot with all 64 marker entries. Scope, revocation, lease/clock boundaries and measurement deadlines passed focused regressions. Independent Standards and Spec reviews found no remaining issues after correcting measurement totals and the final request deadline. Collaboration, handoff and 390px screenshots were inspected. Runtime dependencies are unchanged. See [measurement conditions and records](COLLABORATION-PERFORMANCE.md); these observations are not universal performance guarantees or real Java/Maven/Sonar build evidence.

## GitHub reference research (2026-10-07)

- [reviewdog](https://github.com/reviewdog/reviewdog): integrates existing analyzers, supports standard machine-readable reports, and filters results by added lines, context or changed files. Relevant to optional analyzer interchange and explicit review scope.
- [PR-Agent](https://github.com/The-PR-Agent/pr-agent): the original qodo-ai URL now redirects here. Its README documents separate review/improve/ask tools, CLI usage and optional provider integrations. Relevant to clear operations and opt-in integrations.

These are design references, not installed dependencies or proof that model suggestions passed tests. This iteration implements local coordination using the existing platform.
