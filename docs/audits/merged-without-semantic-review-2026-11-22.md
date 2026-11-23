# Code changes that merged without a semantic review, re-reviewed on 2026-11-22

This audit re-reads the 23 code pull requests that merged on a mechanical-only review pass, and records a verdict for each one against current main.

## Why this audit exists

From 2026-11-20 to 2026-11-21, 23 code pull requests merged on a `remudero-review` success whose reviewer outcome was `not_attempted`. No model reviewer judged the merged head of any of them. Two of them merged over a semantic FAIL on the same head. #20132 fixed the gate on 2026-11-22. This audit checks what got through before that fix.

## Method

- The audit is read-only. It posted no status, changed no code and reverted nothing.
- The operator found the list in the fleet ledger. A pull request is listed when its merged head got a `not_attempted` success, the last `remudero-review` status on that head is success, and no review on that head has a semantic verdict of success.
- For each pull request, the audit read the task record at the merge commit, the squash diff and its tests. It judged each acceptance criterion against the code, not only against the proof text. It also checked the usual review rejects: an export with no production caller, a test that injects around the real path, a swallowed catch, a looser safety check, files outside scope, and stale comments.
- It then checked whether a later change on main fixed or replaced each finding.
- Some task records are in the private ops catalog. For those, this document gives the verdict and keeps the review reasons out.
- Each pull request named here as a fix was checked on GitHub, and each one is merged.

## Verdict key

- **PASS**: every criterion holds on main.
- **gap fixed on main by #n**: a criterion was broken at the merge, and a later merged change fixed it. It holds on main now.
- **by design**: the finding is behaviour that the task design and an earlier operator ruling call intended.
- **gap filed as W1-Tn**: the defect was still on main when the audit ended, so a follow-up task was filed.

## Totals

- 23 pull requests in the task's list: 13 PASS, 5 gaps fixed on main, 1 by design, 4 gaps filed. One of the four filed gaps (#19672) has since been fixed on main by #20365.
- 1 extra pull request (#19218) that the ledger search also found: PASS.

## Merged over a semantic FAIL on the same head

- W1-T14318 audit: #19914 (W1-T13970, answer a seen ops blob from the state-dir cache; key merge-queue rules by base). **Gap fixed on main by #20125.** The task record is in the ops catalog. The audit checked all five criteria again; one reading of the merge-queue rules could count its time-to-live twice, and #20125 now counts it once, from the rules read.
- W1-T14318 audit: #19673 (no task id, let a byte-verified ops move copy pass the reservation holder check). **Gap filed as W1-T14387.** The FAIL on the merged head was right: a byte-exact move copy is still refused when the code root's `origin/main` tracking ref trails the public commit the mover pinned. It fails closed, so it refuses a good copy and never passes a bad one.

## From operator-lane hand reviews

- W1-T14318 audit: #19727 (W1-T13849, a reviewer FAIL names its class). **PASS.** The task record is in the ops catalog. Every criterion holds through the production review path, and no later change reverts it.
- W1-T14318 audit: #19738 (no task id, three hand-lane skills the operator ratified). **PASS.** The three skills are generated from `settings/macros.yaml` with model invocation turned off, so worker prompts do not change. A drift test guards them.
- W1-T14318 audit: #19772 (W1-T13842, what drives the fix class's learned peak estimate). **PASS.** The report reproduces the learner's estimate from the samples it lists, labels each claim as observed or inferred, and says that its remedy loosens the charge and needs the operator's yes.
- W1-T14318 audit: #19875 (W1-T13949, a hold posted after a delivered verdict never hides it). **PASS.** Both readers use `newestFullVerdictRow`, and the tests drive the real `runSweep`.
- W1-T14318 audit: #19701 (W1-T13829, the gate's hand-off line for a held id whose holder is gone). **Gap fixed on main by #20143 (W1-T14198).** A stand-down at a young reservation used up the head's only hand-off attempt, so the case the task was written for never got a hand-off. #20143 tries the hand-off again after the grace period.
- W1-T14318 audit: #19918 (W1-T13879, admit one fix at its typical beside live fixes whose residents leave room). **PASS.** The task record is in the ops catalog. The new admission rung matches its design, and the run child reaches it through the production residents reader.
- W1-T14318 audit: #19927 (no task id, refresh recorded review inputs). **PASS.** The change is a fixture refresh only, and later gardener refreshes replace it.
- W1-T14318 audit: #19934 (W1-T10557, repair the selector edge into the console login suite). **PASS.** The test calls the production `selectAffectedSuites` for every recorded edge and has a negative control.
- W1-T14318 audit: #19936 (W1-T14052, serve forwards its plan pins to the read-model child process). **PASS.** The test forks a real child, and pins are sent again when the child restarts. Both new exports have production callers.
- W1-T14318 audit: #19948 (W1-T14073, a review input is admitted in the order it became eligible). **By design.** A pull request's first eligible head still ranks on its creation time. The W1-T14203 record rules this "NOT A DEFECT (checked)", because creation time is never later than first eligibility. A change to it needs a new operator ruling, not a build.

## The same shape from other hand callers

- W1-T14318 audit: #19672 (W1-T12271, the sweep effects read the terminal heads from the per-file slice store). **Gap filed as W1-T14386, since fixed on main by #20365.** Every criterion holds, but each warm terminal-head stand-down check read and hashed every rotated ledger file again, which goes against the task's performance purpose.
- W1-T14318 audit: #19766 (W1-T13863, skip a cash draft whose whole run cannot fit the window or allowance). **PASS.** The fit check is wired into the production draft batch, and a skipped draft writes no attempt key, so it stays due.
- W1-T14318 audit: #19767 (W1-T13865, hold a head after a needs_scope or flake round until its input changes). **Gap fixed on main by #20142 (W1-T14201).** A FLAKE hold whose rerun went red before `fix.done` was written never released. #20142 removes the hold for a refuted or repeated flake ruling.
- W1-T14318 audit: #19791 (W1-T13867, the cohort index joins the verified task outcome to each worker call). **PASS.** Cached and fresh passes give the same join, and the test drives `runBenchmarkCohortPass` end to end.
- W1-T14318 audit: #19801 (W1-T13868, Codex and cash worker calls record the model they were served). **Gap filed as W1-T14389.** The behaviour holds. The `cashServedModel` comments still describe the old rule, not the latest-wins rule the code applies.
- W1-T14318 audit: #19830 (W1-T13859, expire skill drafts unanswered past the longest answer wait). **PASS.** Expiry, bound, lock and withdraw are present and wired. The operator checked the ledger for the one open risk (that a busy ledger would stop every expiry), and expiry rows do land on the live daemon.
- W1-T14318 audit: #19873 (W1-T13940, an answer posted through the console releases the held task). **Gap filed as W1-T14390.** Every criterion holds, and every item from the earlier FAIL rounds is fixed. When the answers file cannot be written, the failure is not reported, so the Inbox can hide a task that dispatch still holds.
- W1-T14318 audit: #19888 (W1-T13957, an open PR's escalation counts on its own task row). **PASS.** Both production feeds carry the pull request body, and an unread body gives unknown ownership.
- W1-T14318 audit: #19919 (W1-T13951, keep a reviewer's final message complete past the output cap). **Gap fixed on main by #20164 (W1-T14207).** When earlier messages were reclaimed, the run was marked incomplete and the kept verdict was withheld. #20164 keeps the verdict.
- W1-T14318 audit: #19924 (W1-T12058, a hand-run command waits for its GitHub read turn instead of being refused). **Gap fixed on main by #20157 (W1-T14197).** The wait line printed only after the wait ended, so the person saw nothing during the pause. #20157 prints a start line before the first sleep.
- W1-T14318 audit: #19939 (W1-T10581, the CI friction gardener's costliest open cause). **PASS.** The test drives the real `runFixRung`, and the amendment base is the freshly fetched main. The task is `verify: human` with an `escalate` risk ruling and merged on the hand pass; the operator has ratified the merge.

## Extra: found by the ledger search, not in the task's list

- W1-T14318 audit: #19218 (W1-T13469, preserve the author donor in scratch base worktrees). **PASS.** It merged on 2026-11-17, before the task's window. No task record exists for this id, so the audit judged it against the criteria in its pull request body. The tests use real git and a real hook.

## Follow-up tasks filed from this audit

- W1-T14386: a warm terminal-head stand-down check reads no unchanged rotated ledger file (from #19672).
- W1-T14387: the move janitor advances the code root's `origin/main` to the public head the mover pins (from #19673).
- W1-T14389: the cash served-model comments describe the latest-wins rule (from #19801).
- W1-T14390: a failed answer publish marks the held-task list partial (from #19873).

## Duplicate follow-ups withdrawn

#20350 withdrew six duplicate held follow-ups of W1-T12271 criterion 3: W1-T14075, W1-T14076, W1-T14081, W1-T14082, W1-T14086 and W1-T14088. The merged head of #19672 already covers the checkout case they named, and the custom ledger path they named is reached only by tests.
