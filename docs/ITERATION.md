## Version 1.20 continuous review and stale detail protection

Finish criteria: saving or cancelling a repair-list review returns to its original scan/PR page; standalone issue-center review remains unchanged; obsolete scan/pipeline/detail reads cannot reopen closed dialogs or replace newer edits; failed reads release their slot for retry; cancelled navigation does not interrupt committed review writes.

Verification: final complete iteration acceptance passed 104 automated tests and all 11 real browser workflows with current source evidence: outputs/iteration-check/report-d58caf3f-259b-4617-a71a-fb3f96908457.json. Controlled delayed responses exercise the actual scan detail functions and cancellation coordinator, including responses that ignore cancellation: closed reports stay closed, editing content survives old refreshes, newer reports win, connection failures permit retry and background refreshes do not cancel foreground work. Existing PR display/page contract testing remains passing.

Real browser verification reviews two different findings on the second page of a 62-finding report, saves their separate reasons, returns to the same page after each save, cancels a third edit using the return button, confirms exactly two retained reviews and unchanged failed gate, and downloads all 62 repairs. The review form screenshot was visually inspected: outputs/iteration-check/browser-dbc212f3-0a89-4d4c-8909-2939fea55ef6-review-return.png. Page context retains only report ID, offset and scan/PR type; close and replacement clear it. The portable source package is updated without runtime data.

Limits: automatic return preserves the page, not the exact scroll position. Delay races are controlled regression tests, not a claim about all network conditions or all dialogs. Review submissions retain their existing write semantics; canceling navigation prevents a late return but does not undo an already saved review. No dependency or configuration was added. Earlier live GitHub and Java/Sonar verification limits remain.

## Version 1.19 lightweight report details and repair pages

Finish criteria: detail pages keep real gate, counts, comparison and source-version evidence without transferring full findings or manifests; scan and PR repair pages contain at most 25 findings in stable risk order with global numbering; review actions and complete exports still work; original report APIs remain compatible.

Verification: the complete iteration check passed 101 automated tests and all 11 browser flows with matching source evidence: outputs/iteration-check/report-9c4b0d39-12bd-425d-abdd-cf33458f67dd.json. Representative large-report checks retain 1,000 finding counts and 2,000 file counts while the display response is less than 1% of that fixture's complete response; the original report stays unchanged. Page checks preserve every occurrence and order, reject invalid offsets and unsupported query options, and handle empty/beyond-end pages. Real HTTP checks cover display evidence, full API compatibility and stable review IDs. The actual PR view is separately exercised with controlled display/page responses.

Real browser verification scans 62 empty-catch findings, displays pages of 25, 25 and 12 entries, navigates back, saves a review from the second page and downloads all 62 numbered repairs. The second-page screenshot was visually inspected: outputs/iteration-check/browser-11226a69-3e8c-4cd4-b92c-056ae7fe0114-task-page.png. The final run also covers existing evidence, rejection, rechecks, settings, view cleanup and narrow-screen flows.

Limits: this reduces transmitted and rendered detail data; the service still reads complete report files and compares findings on demand. Logs remain available in detail views. This is not a measured whole-process memory reduction, a production-size latency benchmark or a live GitHub PR network check. Acceptance editing and full exports deliberately keep complete evidence; local agent permissions remain unchanged. No dependency or new configuration was added.

# Ongoing platform iteration

Objective: continue improving CodeHealth's useful review features, daily usability, low memory usage, and convenient deployment. The overall goal remains active; one verified release does not prove every opportunity has been completed.

## Version 1.18 clear navigation, optional setup and temporary-data release

Finish criteria: retain every existing function with clearer entry points; distinguish local checks, complete builds, review evidence and agent task participation; offer minimal local setup first; optional configuration stays accessible with validation feedback; desktop/short-window navigation remains reachable and mobile users can open and close a named menu; hidden details and inactive list caches are released; real measured memory and current-source acceptance are recorded.

Implementation: navigation is grouped into checks/acceptance, tasks/knowledge and setup/history. The quality page is named "代码审查与证据" to describe its functions. Nonfunctional local-user decoration is removed; navigation scrolls within the sidebar and icon links expose accessible names. The home guide connects existing check, acceptance and task actions. Settings starts with a zero-extra-configuration local check route; complete-check configuration, Sonar service management and GitHub access configuration are folded until needed. Existing settings APIs, token lifetime and validation remain unchanged. Native configuration errors remain in the form and successful saves can be verified from actual state.

Memory changes: navigation aborts inactive list requests, including requirements/knowledge, and drops inactive page data. Closing a modal removes its DOM contents and editing snapshots while preserving stored evidence. A queued close event cannot erase a newly opened modal. Scan polling skips hidden pages and cannot overlap another poll. No new dependency, resident worker or background monitor was added.

Verification: final one-click report outputs/iteration-check/report-e7d28804-fbc7-4317-946b-a60a68f6150e.json passed all 98 Node tests and 10/10 actual browser scenarios against matching source. Added browser checks reject an external Sonar address without replacing settings, save a valid localhost address, confirm closed modal content is empty, confirm inactive list/workspace caches are released, and open/close the mobile text menu. A first cache check ran before hashchange had rendered; the runner now awaits the actual selected page. Direct 390-pixel inspection also found a menu that covered its close control; placing the menu below the topbar fixed it, and button closing is now checked automatically. Optional GitHub configuration was expanded through the real UI and its original form remained present. Desktop and mobile screenshots are in outputs/qa-v1.18.

Measured samples: an independent QA instance with no projects/scans used 45.4–45.8 MB RSS and 6.7–7.3 MB main heap across five readings. After 30 real small-fixture scans, completed workers and five further readings, RSS was 73.4 MB and main heap 10.8 MB. The overview response was 16,385 bytes with 25 compact summaries for 30 records; history pages contained 25 then 5 records, and no full issue lists, logs or source manifests were in overview state. Samples are saved in outputs/qa-v1.18/idle-memory.json and loaded-memory.json. These are representative service-only readings, not a memory ceiling, a before/after reduction claim, browser memory, or full Java/Sonar coverage. Existing production data was not used in the QA instance. See docs/SIMPLE-WORKFLOW.md.

## Version 1.17 requirements, tasks, knowledge and local agents

Finish criteria: people define project requirements and acceptance conditions, create linked tasks, track ownership and review actual submissions; independent local agent processes read permitted context, claim/renew/release, submit evidence and propose knowledge; duplicate/expired/unauthorized operations fail; human approval and publication remain explicit; requirement edits invalidate old task evidence; records survive restart and backup; existing platform/browser regression remains passing.

Implementation: three new pages provide requirements/tasks, reviewed knowledge, and process-local agent connections. Dedicated Bearer endpoints and a Node CLI restrict credential-bearing requests to the selected projects and supported collaboration operations. Agents cannot create/edit requirements or tasks, approve submissions or publish knowledge. Scoped credentials are displayed once, held only in memory, and invalidated by revocation/restart. Thirty-minute leases, version checks and queued atomic disk writes prevent conflicting claims and lost updates. Scan-derived repair tasks resolve actual findings; scan-required approval verifies the latest completed report, current source and existing readiness. Manual documentation tasks explicitly do not claim code quality passed. Histories remain intact after return, release and reopening. Published knowledge is suggested through bounded text matching, not semantic validation.

Verification: final one-click run passed 98 Node tests and all eight existing browser regression flows with matching source evidence: outputs/iteration-check/report-a75fd899-b1bd-4c8e-b615-b90bf11b81cb.json. Five additional automated tests include concurrent claims, expiry/wrong owner, stale versions and requirements, bounds/history limits, cross-project references, real HTTP/independent CLI interactions, rejection of self approval/publication, actual failed scan → return → fix → clean scan → changed-source block → approval, token revocation/restart, and byte-identical backup restoration. These use representative platform fixtures and explicitly distinguish authored acceptance statements from business test coverage.

Additional browser QA used only outputs/qa-v1.17: a requirement and linked documentation task were created through the UI; a real CLI process claimed/renewed, wrote a three-section handling document, verified the content and unchanged Java fixture, and submitted. The UI approved with a reason, showed current requirement completion 1/1, created/published knowledge, and displayed it in task context. Connection revocation and incompatible status filters across pages were checked. Desktop and 390-pixel knowledge layouts were viewed; document width remained 390 pixels and the modal stayed within the viewport. Screenshots: agent-task.jpg, knowledge.jpg and knowledge-mobile.jpg in that QA directory. An actual UI-data backup restored requirements, task, knowledge and history byte-for-byte into an independent directory.

Limits: local human endpoints retain the trusted-localhost model without independent human authentication; a malicious local process can omit agent credentials and call human endpoints. This is collaboration with trusted processes, not an OS sandbox or hostile multi-user isolation. Task path constraints and declared changes/tests are data that require review. No automatic agent launcher, external model provider or command-execution endpoint was added. Each collection has 1,000 records, each record 100 history events (including heartbeat), and the workspace is limited to 8 MB. Existing full JDK/Maven/Sonar coverage limits remain. See docs/LOCAL-AGENTS.md for operation and integration details.

## Version 1.12 current readiness and issue review

Finish criteria: latest failed/running attempts cannot inherit an older passing readiness; current-source checks and saved report evidence remain distinct; users can review and filter issues with required reasons; matching scans retain decisions while changed/returned findings reopen; reviews never weaken automatic gates; restart, export and backup preserve provenance.

Implementation: project overview/management exposes on-demand current readiness with completion, source freshness, automatic test evidence, human evidence and next action. The acceptance form uses the same fresh assessment and labels saved historical acceptance separately. Source hashing remains on demand; index summaries retain each project's latest attempt without loading details. Report-resident review ledgers are compatible only across the same project/PR, mode, scope, enabled rules and engine version. Masked evidence uses file fingerprints where available; ambiguous duplicate evidence is conservative after file changes. Reopened decisions retain prior reasons. Review and acceptance writes cannot overwrite each other; scanning waits for pending review writes. Review status filters and exports share the same matcher. New authored evidence is limited by count and byte size without silently deleting history.

Release checks: all 73 automated checks pass. Final browser layout inspection confirms normal-sized action buttons after adding multi-row review evidence. QA servers are stopped; screenshots and isolated demonstration records remain in outputs/qa-v1.12. Existing production data was not used for these checks.

Verification: real HTTP tests cover zero-report readiness, dismissed high risk remaining blocked, line movement, restart, filtered JSON/Markdown export, clean scan plus human evidence, changed-source blocking without rewriting saved acceptance, returning/changed findings, a newer failed scan and backup restoration. Browser QA uses only outputs/qa-v1.12 data: records a dismissal and filters it; verifies high-risk readiness remains blocked; fixes and scans the fixture; fills explicitly labeled UI-test evidence; verifies readiness, then modifies code and observes STALE blocking; reintroduces the issue and observes reopening with the original dismissal reason. Both narrow and desktop layouts are inspected. No real JDK/Maven/Sonar end-to-end verification was added; no GitHub writes or remote-head verification was introduced.

## Version 1.11 bounded text processing

Finish criteria: reproduced long malformed catches, repeated unterminated comments and long credential-like identifiers no longer stall the worker; ordinary findings and locations are preserved; incomplete lexical text fails explicitly rather than silently passing; stopped workers release resources and later scans work; local and PR reports use the upgraded engine version; browser, portable runtime and original data remain verified.

Evidence: before changes, all three representative inputs hit an enforced 1,500 ms worker deadline. After changes, the same local 700 KB catch prefixes and 400 KB credential-like identifier complete in 45/36 ms; 300 KB unclosed comments fail explicitly in 33 ms. These are measurements of those three inputs on this machine, not a claim about all scans or machines. Regression cases also exercise larger 2.1 MB catch prefixes, 1.2 MB identifiers, malformed Java comments and SQL strings, escaped literals, CRLF/Unicode offsets, annotated catches, multi-catch, retained credential masking, worker cancellation and release. Stop verification now uses legitimate large literals across files rather than depending on the old pathological bug. Tests choose both listening ports through the OS to avoid reserved adjacent Windows ports.

Scope: forward lexical masking and token recognition are bounded for the reproduced paths; the whole heuristic rule set is not claimed to be a full compiler, complete dialect parser, or proven linear algorithm. Local rule version 3 prevents comparisons against version 2 findings from pretending the recognition change fixed code. No npm dependencies, installed tools, Docker, persistent source watchers or report deletion were added. Broader goal remains active, including full Java/Maven/Sonar integration and clearer latest-attempt readiness.

Release checks: all 67 automated checks pass. Browser QA shows a 300 KB malformed comment failing promptly with `Broken.java` in the explanation, then the same project completing with zero local findings after correction. The extracted portable release preserves the standard five-finding fixture, rejects malformed text within the short worker deadline, and records an actual failed HTTP scan with engine version 3 while health remains UP. Original production reports and baseline links are audited unchanged.

## Version 1.10 report-to-source verification

Finish criteria: new local reports capture content fingerprints; changed files/configuration or changed Git HEAD cannot reuse old acceptance; changes during scanning fail rather than appear passed; original gate and authored evidence remain traceable; manifests never enter the resident history index; bounded read-only verification is visible in the browser and survives export/restart/backup.

Evidence: representative unit checks cover modified content, renamed/added/deleted paths, timestamp-only changes, excluded build outputs, bounded 25-path differences, missing fingerprints, changed Git base, oversize/canceled/timed-out inputs and absence of source/secret text. Real HTTP tests verify current acceptance, stale-source blockers despite filled evidence, rescanning, original gate retention, export/restart, and a real 500-file scan whose configuration changes during execution fails with no passed gate. Browser QA independently confirms unchanged content, a modified Java file, and saved acceptance blocked despite all five completed declarations. These declarations explicitly identify themselves as QA workflow evidence, not business tests.

Limits: scope is documented in README and the UI; no continuous watching or atomic filesystem snapshot is claimed. File changes outside tracked formats, external dependencies/environment and source changes after the check are outside this evidence. Existing legacy reports remain readable, but cannot newly confirm current local source until rescanned. PR reports remain tied to fixed remote commit evidence; this local feature does not check their latest remote state. Full JDK/Maven/Sonar execution still remains unverified here.

## Version 1.9 reversible history management

Finish criteria: old reports and retired projects can be archived and restored; latest attempts, latest completed whole-project results, baselines and latest PR snapshots remain protected; archived reports retain original findings and authored evidence; restoration preserves chronology; backups retain archive metadata and details; concurrent writes are excluded during maintenance; browser flows and portable startup work.

Evidence: all 60 automated checks pass, including actual HTTP archive/evidence-edit/restore/restart flows and archive backup restoration. A 35-report representative fixture confirms removing 33 old summaries reduces serialized resident index size by more than half while retaining exact report bytes. This measures index data, not total process RSS. Browser checks on isolated QA data confirm checkbox batch archiving, readable failed report/logs, report restoration, project retirement and restoration with issue counts returning from 0 to 5. Production report preservation is audited separately. Archived summaries are read one at a time for pagination and backup validation. No report/source deletion or Docker installation is involved.

Limits: archived IDs and registered project metadata still remain resident; filtering archive pages scans their summaries from disk. Restored metadata files remain on disk for safe recovery but are excluded from backups unless referenced. Full JDK/Maven/Sonar execution remains unverified in this environment.

## Version 1.3 verification criteria

- Historic findings, logs, settings, acceptance evidence, project links, and baselines survive migration and restart.
- Only compact history summaries remain in the server's resident index; full details are read on demand.
- Latest whole-project issue counts stay accurate; partial Git/PR checks remain separate.
- History and acceptance lists show at most 25 entries per page and can still open older reports.
- Runtime information reports real process memory and explicitly excludes other programs.
- Windows startup handles spaces and Chinese paths, supports a custom port and data directory, checks Node version, and requires no npm dependencies or Docker.
- A second launch on an occupied port exits with clear feedback before modifying state.
- The portable package contains source, scripts, examples, tests and documentation; it excludes runtime credentials and local reports.

## Evidence gathered this iteration

- Automated storage tests retain exact report contents, baseline links, ordered writes and interrupted-scan failure states.
- A representative 60-report migration reduces serialized resident index size to 0.57% of the previous inline state; this is not a claim about total process RSS.
- Existing production data audited report-by-report: 3 local scans, 1 GitHub review, projects and baseline links preserved exactly.
- Browser checks against a separate QA instance: 27 real faulty-fixture scans; history and acceptance pages render 25 then 2 rows; oldest report opens with its 5 findings and real logs; dashboard renders without console errors.
- Runtime health checked through the PowerShell status script.
- Issue pagination verified in browser using 40 real local findings (25 then 15); evidence text now participates in both search and export filters.

## Further work under the original objective

- Completed in v1.4: issue filtering and history paging use server endpoints; overview refreshes no longer read all latest findings or transfer the full archive.
- Completed in v1.6: worker-based local rules, indexed line lookup, bounded evidence/findings, file progress and local-stage stop. Further improvements include eliminating pathological regular-expression work and more detailed partial-scope progress.
- Completed in v1.5: project-specific coding briefs, frozen requirement versions in new scans, Markdown instruction exports, and explicit review evidence gaps. Automated execution of additional test plans and enforceable project policies remain future work.
- Completed in v1.7: consistent compressed backups, verified restore into a new directory, and exclusive directory ownership with explicit dead-owner recovery. Recoverable project/history deletion and retention management remain future work.
- Graceful close drains writes and releases ownership; forced Windows termination leaves an explicit lock that the recovery tool checks before release. Additional interruption fault injection remains useful.
- Verify full JDK 8 / Maven / JaCoCo / SonarQube execution when the required environment is available, preserving the user's instruction not to install Docker on this computer.

No GitHub comments, merges, code pushes, Docker installation, or external deployment have been performed by this iteration.

## Version 1.5 criteria and evidence

- Incomplete requirements save as an explicitly labelled draft; goal, scope, acceptance and test plan are required for a complete plan. Each field is bounded to 3000 characters.
- Requirement text stays on disk; dashboard data includes only version, timestamp and completeness. New local scans retain the exact saved requirement version. Updating the current plan cannot rewrite earlier scans.
- AI instruction exports preserve the saved user requirements and include Java 8, minimal changes, actual testing and honest reporting requirements. Repair exports use the report's frozen plan, not the newest project plan.
- Acceptance gaps retain automatic blockers even with all human evidence filled; local and partial scans explicitly state their missing build/test/scope evidence. Human evidence never claims automatically executed tests.
- Automated checks exercise real HTTP save, invalid input, export download, frozen versions, old report export and process restart. Browser verification uses only independent QA data, covering draft save, complete save and preview, export, new scan and bound plan display.
- This adds useful controls for AI-assisted development; it does not automatically prove arbitrary requirements, execute arbitrary task commands or claim full build/test verification in the current missing-JDK environment.

## Version 1.4 criteria and evidence

- A 601-scan representative archive produces a bounded overview snapshot while retaining an old project's latest report and a far older baseline.
- Issue-page tests load only selected projects' latest whole reports; partial results never replace overall counts. All matching rows are available through pages and the same export iterator.
- Invalid page and filter values are rejected; requests beyond the final page are clamped without losing reports.
- Delay-controlled tests prove superseded searches cannot overwrite current results, even if an aborted old response still resolves. Quality list updates avoid rerendering active GitHub forms.
- Streamed JSON tests preserve Unicode and all rows under partial filesystem writes; zero-byte failures are errors.
- Browser verification uses the existing isolated archive, leaving production scans, baselines and GitHub records untouched.
- Broader iterations remain active: large-source responsiveness, project-specific review policies, recoverable management and backups, concurrent-data ownership, and full JDK/Maven/SonarQube execution still need work.

## Version 1.6 criteria and evidence

- Existing Java/SQL fixtures retain expected rules and locations, including CRLF, Unicode, multiline catches and one TODO finding per line.
- Worker scans match inline engine findings; parent timers stay active during 8,000 dense findings. Workers terminate before result/stop resolution, and a subsequent scan works after stop and timeout.
- Finding overflow and oversized files fail explicitly. Real HTTP workflows verify stop and overflow failure records, responsive health during a busy worker, and refusal to accept or baseline incomplete reports.
- Evidence is capped at 500 characters; credentials cut at the preview boundary stay masked. Source reads are bounded even if a file grows after stat.
- Independent browser workflow registers malformed static Java text, starts a real scan, keeps the page responsive, stops it, and displays the explicit unfinished error and actual 0/1 completed-file progress. No source is executed.
- Local line-lookup benchmark: 6,000 locations in a 132,012-byte source, 376.20 ms using repeated prefix splits versus 4.55 ms including a new line index. Both checksums match. This single local operation measurement does not establish whole-scan speed or general hardware performance.
- Whole objective remains active: recoverable management/backups, same-data-directory ownership, full JDK/Maven/Sonar integration, and enforceable project policies remain outstanding.

## Version 1.7 criteria and evidence

- Backups stream source data in 64 KB chunks through gzip; a complete file is exposed only after successful creation. Prior backups, runtime credentials, project sources and Sonar databases are excluded.
- Backup creation reserves mutations, rejects active scans/reviews, and rejects competing saves/scans/backups while the reservation is held; reads remain available.
- Restore checks checksums, bounded record/file/total sizes, paths and index references before publishing under a data lock into a nonexistent destination. Existing destinations are refused. Failed validation retains staging and never publishes a target.
- Round-trip tests preserve exact bytes of state, full reports, manual evidence, baseline links, briefs and exports. Corrupt, incomplete, duplicate and traversal archives fail; missing source details cannot produce a completed backup.
- Two different ports with the same data directory cannot start concurrently or change the owner's index. Live owners cannot be recovered; confirmed-dead owners recover once even with competing attempts. Ownership release cannot remove a newer owner's lock.
- Overall objective remains active: recoverable history/project management, policy enforcement, integration with the missing Java/Maven/Sonar environment, and further resource improvements remain to be addressed.

## Version 1.8 criteria and evidence

- Per-project controls require a complete coding brief, full analysis, minimum executed tests, zero medium risks and optional project metric thresholds. Inheritance remains the default. Requirements and effective thresholds freeze into new reports.
- Combined gates retain known HIGH/CRITICAL/BLOCKER findings even if imported Sonar checks pass. Missing full-analysis/test evidence is UNKNOWN; skipped tests do not meet test minima and failing reports block.
- Maven evidence collection reads bounded single-suite XML reports in Surefire/Failsafe target directories. Only files updated after build start count; invalid, inconsistent, unsupported or changing evidence invalidates totals. XML/log contents are not persisted or evaluated.
- Report comparison refuses changed effective policies/thresholds but permits unchanged re-saves. API tests verify snapshot retention and that human acceptance cannot override missing automated evidence.
- Browser checks use independent starter sources: preset fills without saving, readiness checks keep the form open, cancellation starts no scan, and a real zero-finding local scan remains UNKNOWN under full-analysis/minimum-test controls.
- Browser verification exposed implicit submissions in helper action buttons; all action buttons now explicitly use type=button, and saves/starts remain explicit submit controls. This also protects preview/cancel/readiness actions.
- No JDK, Python, Docker or additional npm dependencies were installed. Real JDK/Maven/Sonar execution still needs separate environment verification; these controls do not claim it has run here.
- Remaining goal work includes recoverable project/history management, GitHub policy association, further large-source improvements and full environment verification.
## Version 1.13 acceptance pipeline

Finish criteria: an editable project plan defines concrete inputs, steps and expected outcomes; each new scan freezes that version; eight stages combine real automatic evidence and human scenario records; failed, untested, stale-source and superseded-plan results cannot pass; exports and backups preserve the evidence; original workflows remain operational.

Verification: all 80 automated checks pass. Real HTTP workflows cover draft refusal, conflicting edits, required-case waiver refusal, scenario failure blocking, successful completion with explicitly labeled fixture evidence, current-source changes and reversion, new-plan invalidation, restart, archive and backup restoration. A test wait was corrected to wait for final scan persistence before starting source verification. Browser QA uses only outputs/qa-v1.13: saves a 30-case local plan, adds/removes a custom case, executes an actual fixture scan, records a deliberate failure, checks blocking, records a revision, and views retained failed evidence. The remaining 29 unexecuted cases stay pending. Desktop report layout was visually inspected; screenshot is saved in outputs/qa-v1.13/pipeline-report.jpg.

Limits: business steps are human-executed evidence, not automatic commands. Real JDK/Maven/Sonar execution has not been performed here. The platform's own Node.js code is not fully covered by its Java rules or the current source-fingerprint extension list; self-acceptance requires a Node-specific runner and complete JavaScript/HTML/CSS source tracking before claiming automatic iteration approval.
## Version 1.14 platform self-check and false-pass prevention

Finish criteria: platform web/service edits invalidate source evidence; zero supported source files cannot pass local gates; a fixed Node self-check executes real syntax checks and the complete test suite, rejects incomplete/failed/skipped summaries, checks source stability, and stores a downloadable report; original scenarios remain verified.

Verification: 51 JavaScript files pass syntax checks; all 85 automatic tests pass through the actual browser-started platform self-check. Real fixture checks distinguish a passing test, failing test, syntax error and test-driven source mutation. The runner clears Node's internal parent-test marker so independent tests cannot be silently skipped. Source regression tests reproduce the original missed server.js edit, cover web-language types and generated-directory exclusions, and require v1 snapshots to rescan. HTTP pipeline verification rejects an empty local scan. Self-report backup restoration preserves the current reference and exact report bytes. Browser confirms running/disabled state, complete result, download endpoint, stale verdict after adding a temporary source file, and restored consistency after removing it. Narrow viewport has matching document/client widths (375 px), with no horizontal overflow; desktop screenshot is outputs/qa-v1.14/platform-check.jpg.

Limits: this is automatic acceptance for the platform's declared syntax/test/source scope. Business and visual acceptance, external dependencies and actual Java/Maven/Sonar execution remain distinct. Reports are retained as exports; the UI points to the latest persisted check.

## Version 1.15 automatic scenario evidence and browser regression

Finish criteria: exact scenario bindings use fresh Maven case evidence, cannot be manually overridden and remain pending without verified execution; a fixed isolated browser runner exercises eight real flows, records screenshots, rejects incomplete results, checks current platform code, and preserves evidence through backup and restore.

Verification: all 90 automated tests passed. Real browser regression from the platform entry completed all eight flows using its own temporary data and source. UI checks saved and reopened demo.FlowTest#normal in the acceptance plan. Screenshot downloads returned image/png; the platform result displayed all eight completed scenarios. A real API backup restored 11 files including the plan, current report and eight screenshots; every restored file matched its original SHA-256. Results are under outputs/qa-v1.15. The browser runner persists an initial failed/incomplete report before updating the latest reference so an interrupted latest attempt cannot fall back to an earlier success.

Limits: business-case parsing and decisions were verified with representative XML, not a real Java/Maven/Sonar build. Browser coverage is the fixed eight flows, not all product features or full visual review. Node platform checks and browser regression must both be run for platform iteration acceptance.

## Version 1.16 one-click iteration acceptance and GitHub checks

Finish criteria: one invocation runs full platform checks followed by fixed browser regression; complete evidence matches one source version; failed or interrupted latest runs cannot inherit past success; combined reports and linked evidence survive backup; GitHub runs the same command on submissions.

Verification: the actual browser-started one-click run passed all 93 Node tests and all eight browser flows with matching source evidence. UI running state disabled duplicate starts, then displayed the combined verdict and downloadable evidence. A real API backup restored 12 files to an independent directory; every restored file matched SHA-256. Screenshot: outputs/qa-v1.16/iteration-acceptance.jpg. Unit regressions cover incomplete, mismatched, skipped/missing-summary evidence, failure stopping the browser phase, thrown runner errors, edits between phases, stale reads and missing backup children. HTTP checks reject external run parameters.

The first full run exposed a previous timing defect: an active report could show completed while review inheritance was still loading. Public scan/detail/history views now remain running until final persistence completes; the readiness and service workflows were reverified, then the entire one-click suite passed. Browser initialization failures no longer leave a 150-second timer running.

GitHub workflow uses Windows / Node 24 and a separately installed Chromium, with locked dependencies, read-only repository permissions, a 15-minute job bound and 14-day result artifacts. Local success does not claim remote success until the actual workflow result is checked. Real Java/Maven/Sonar builds remain outside this round's verified scope.
