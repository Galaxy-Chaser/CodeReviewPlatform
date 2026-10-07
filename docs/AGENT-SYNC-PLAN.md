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

1. Better task handoff context: show current requirement changes and ownership before acting; retain human review and stale evidence checks.
2. Optional standard report interchange for established analyzers, with strict input size/path validation and honest tool provenance.
3. Small review summaries and explicit scope choices; preserve complete exports and original gates.
4. Measure idle and representative large-workspace polling costs before selecting further memory improvements.

Each increment needs its own finish criteria, boundary tests and verified outcome. This is an ongoing objective; this iteration does not claim all future improvements are complete.

## GitHub reference research (2026-10-07)

- [reviewdog](https://github.com/reviewdog/reviewdog): integrates existing analyzers, supports standard machine-readable reports, and filters results by added lines, context or changed files. Relevant to optional analyzer interchange and explicit review scope.
- [PR-Agent](https://github.com/The-PR-Agent/pr-agent): the original qodo-ai URL now redirects here. Its README documents separate review/improve/ask tools, CLI usage and optional provider integrations. Relevant to clear operations and opt-in integrations.

These are design references, not installed dependencies or proof that model suggestions passed tests. This iteration implements local coordination using the existing platform.
