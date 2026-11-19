# CLAUDE.md headlines sorted by the stage that needs them

Task: W1-T13725 (recon). Read at `eb79fd765d0ad4505aa2ebf6a29c3b1c1afed49f` (origin/main). Nothing was changed, filed or pushed.

Labels: **OBSERVED** means I read the code or ran the command at that sha. **INFERRED** means a conclusion drawn from what I read but not run end to end.

Stage meanings:
- **CHECK**: a test, census, lint, hook or CI step already refuses the mistake, and its message or test names it.
- **REVIEW**: you can judge it from a diff, so review is the right place to apply it.
- **IMPLEMENT**: only the person or worker doing the work can act on it (operator moves, investigation habits, local tool traps).

Headline finding (OBSERVED): today the reviewer's prompt contains **zero** CLAUDE.md headlines. So no headline is applied at REVIEW from doctrine. The REVIEW column below marks headlines review *could* apply. It does not mean review applies them now.

## Every headline by stage

Numbers follow CLAUDE.md order (`parseRuleHeadlines`, 63 rules, OBSERVED). Short names are the doctrine body slugs. Each CHECK citation was confirmed by grep at this sha (OBSERVED). For IMPLEMENT and REVIEW rows, "no check found" means my grep found no refusing check (INFERRED absence: the grep had a positive control, because the same searches did find the CHECK rows).

| # | headline short name | stage (primary; secondary) | evidence file:symbol |
|---|---|---|---|
| 1 | preflight-before-first-push | IMPLEMENT; CHECK on the fleet lane | src/lib/preopen-gate.ts gates a fleet build before its PR opens (test/a-build-is-gated-on-the-fast-preflight-before-its-pr-opens.test.ts). Nothing gates an interactive push. |
| 2 | no-summary-no-result | CHECK; IMPLEMENT for ad-hoc runs | scripts/census-precheck.mjs `runCensusSuitesViaChild`; test/a-preflight-or-push-gate-test-run-passes-only-when-every-file-reports.test.ts; test/a-pool-run-that-ends-without-a-summary-fails-by-name.test.ts |
| 3 | check-the-stored-body | CHECK | scripts/acceptance-author-gate.mjs reads the stored PR body from the event payload (acceptance-author-gate.yml); src/lib/review.ts `parseAcceptanceBlock`; `checkAcceptanceCommand` (test/check-acceptance-refuses-what-the-gate-refuses-before-the-pr-opens.test.ts) |
| 4 | dialect-prefix | CHECK | scripts/acceptance-author-gate.mjs message "no runnable dialect prefix"; src/lib/task-linter.ts check `proof-dialect` |
| 5 | title-is-literal | CHECK | src/lib/task-linter.ts `proof-unit-test-unresolvable` (block, uses the reviewer's own `resolveNameFilteredCandidates`); scripts/proof-resolve-precheck.mjs (pre-push) |
| 6 | require-a-verbatim-hit | CHECK | scripts/proof-resolve-precheck.mjs `certainHeadRefusals` blocks a title miss in hooks/pre-push; the review floor refuses it again |
| 7 | executor-invocation | CHECK | the review floor runs the real grep: src/lib/review.ts, src/lib/grep-zero-cause.ts `classifyGrepZeroHit`; task-linter `proof-grep-*` checks |
| 8 | one-physical-line | CHECK (warn only) | src/lib/task-linter.ts `proof-grep-unmatchable` ("line-seam", `wrappedLineSpan`), severity warn; the review floor fails the zero hit |
| 9 | type-only-lines-exempt | CHECK | scripts/diff-coverage.mjs `computeTypeOnlyRanges` exempts doc-comment and interface lines |
| 10 | cover-the-real-default | IMPLEMENT; CHECK by line | scripts/diff-coverage.mjs refuses the uncovered lines but never names the seam. The remedy is the author's. |
| 11 | lcov-instruments-the-diff | CHECK | scripts/diff-coverage.mjs "BLOCKED -- changed source file(s) have no SF record" |
| 12 | same-tree-name-the-sha | IMPLEMENT | report discipline; no check found |
| 13 | added-lines-inherit-debt | IMPLEMENT | diagnosis habit; no check found |
| 14 | partial-fakes-fire-defaults | REVIEW; IMPLEMENT | judgeable from a diff's deps object; no check found |
| 15 | delete-the-fix | CHECK; IMPLEMENT | scripts/proof-discrimination-gate.mjs (proof-discrimination-gate.yml) runs the proof at the merge base (`executed_stale`); task-linter `proof-base-discrimination` |
| 16 | zero-inside-own-sf-block | IMPLEMENT | hand lcov editing; no check found |
| 17 | host-worktrees-arrive-linked | IMPLEMENT | host operating habit |
| 18 | finish-owned-work | IMPLEMENT; prompt contract | test/every-worker-receives-the-workspace-cleanup-contract.test.ts shows workers get it in the prompt, not from CLAUDE.md |
| 19 | derive-merged-tasks | IMPLEMENT | operator investigation |
| 20 | run-both-scope-checks | IMPLEMENT; CHECK on the fleet lane | src/lib/dispatch-claim.ts `dispatchClaimRef` claims for dispatched runs. An interactive builder must check by hand. |
| 21 | sweep-open-pr-heads | IMPLEMENT | task-linter `duplicate-surface` (warn) compares filed tasks, not open PR heads |
| 22 | name-the-session-branch | CHECK | scripts/head-identity-gate.mjs (hooks/pre-push and head-identity-gate.yml); `BRANCH_NAME_CONTRACT_PART` in src/run-task.ts goes into every worker prompt |
| 23 | new-tests-go-in-their-computed-folder | IMPLEMENT | the harness admits the computed path (`observeComputedPlacement`, src/lib/test-path-resolver.ts); no refusal of a new top-level test/ file found |
| 24 | new-test-imports-use-package-aliases | CHECK | test/a-test-imports-through-the-subpath-alias.test.ts "location-relative test files never rise above the merge base" |
| 25 | new-tests-use-the-shared-root-helper | CHECK | scripts/census-precheck.mjs (test/every-test-finds-the-repo-root-through-one-helper.test.ts "census-precheck refuses new own-folder roots") |
| 26 | confirm-the-frontier | IMPLEMENT | operator selection |
| 27 | loser-renumbers | IMPLEMENT | reservation race etiquette |
| 28 | file-from-the-operator-checkout | IMPLEMENT; CHECK partial | task-linter `unminted-task-id` blocks an added unminted id |
| 29 | rule15-plan-record | CHECK (describes it) | task-linter `rule15-filing`; scripts/rule15-precheck.mjs in hooks/pre-push |
| 30 | decode-rule-citations | IMPLEMENT (navigation) | a glossary pointer; keep it |
| 31 | take-the-cheap-candidate | IMPLEMENT | operator scheduling |
| 32 | never-fan-out-update-branch | IMPLEMENT | operator move |
| 33 | leave-red-prs-to-the-fix-lane | IMPLEMENT | operator move |
| 34 | gh-read-cadence | CHECK | hooks/deny-floor.sh rules 7 and 10 (refuses a polling loop, routes GitHub reads through `rmd gh`) |
| 35 | conflicting-pr-zero-checks | IMPLEMENT | diagnosis |
| 36 | close-the-ours-side-block | IMPLEMENT | conflict resolution |
| 37 | title-needs-a-re-run | IMPLEMENT | operator move |
| 38 | no-unapproved-waivers | REVIEW; CHECK partial | scripts/gate-monotonic-check.mjs and scripts/baseline-monotonic-check.mjs refuse a demoted gate or baseline; nothing refuses an advisory ignore line by name |
| 39 | a-baked-path-merge-ships-itself | IMPLEMENT | operator deploy check |
| 40 | ratchet-collision | IMPLEMENT | diagnosis |
| 41 | base-red-full-census | IMPLEMENT | diagnosis |
| 42 | read-the-ledger-union | IMPLEMENT | code reads go through src/lib/ledger-union.ts; the rule governs hand reads |
| 43 | reason-from-the-decision | REVIEW | judgeable in a diff that writes a ledger line; no check found |
| 44 | exclude-the-relative-path | CHECK | src/lib/task-linter.ts `proof-unit-test-base-wrapper` (block) |
| 45 | git-fixture-identity | IMPLEMENT | CI's identity-less runner fails the test but names nothing; no named check found |
| 46 | check-the-write-order | REVIEW | code judgement |
| 47 | drain-dry-run-writes | IMPLEMENT | nothing refuses `rmd drain --dry-run` (src/lib/live-write-guard.ts has no drain match) |
| 48 | healthy-condition-bound | REVIEW | code judgement; src/lib/rule-efficacy.ts tracks its recurrence |
| 49 | a-zero-needs-a-positive-control | IMPLEMENT | investigation habit |
| 50 | posix-drops-escapes | IMPLEMENT; CHECK partial | task-linter `proof-engine-divergence` covers BRE vs ERE only; no `\s`/`\b` check found |
| 51 | ugrep-skips-binary | IMPLEMENT | trap in the local tool |
| 52 | control-on-coverage | IMPLEMENT | investigation habit |
| 53 | count-the-same-units | IMPLEMENT | investigation habit |
| 54 | prove-the-replacement-first | REVIEW | judgeable for a diff that removes an access path |
| 55 | gate-against-origin-main | IMPLEMENT | investigation habit |
| 56 | run-the-census-suites | CHECK | scripts/census-precheck.mjs runs in hooks/pre-push and in scripts/preflight-author.mjs `PUSH_STAGES` |
| 57 | catch-is-a-claim | REVIEW | code judgement |
| 58 | clock-shift-enoent | IMPLEMENT | diagnosis |
| 59 | main-genuine-evidence | IMPLEMENT | operator judgement |
| 60 | recurrence-is-a-class-signal | IMPLEMENT | operator/retro |
| 61 | replay-then-audit | IMPLEMENT | build discipline |
| 62 | reentrancy-from-process-env | REVIEW | code judgement; no check found |
| 63 | fixed-date-time-bomb | CHECK | scripts/expiring-fixture-census.mjs in ci.yml. Its own header says "WHY THIS IS A GATE AND NOT A CLAUDE.md BULLET (W1-T3272)", yet the bullet is still here. |

Tally (OBSERVED counts from the table):

| stage | headlines | bytes in CLAUDE.md (headline + pointer) | bytes in AGENTS.md |
|---|---|---|---|
| CHECK | 18 | 3,825 | 2,667 |
| REVIEW | 8 | 1,711 | 1,217 |
| IMPLEMENT | 37 | 8,355 | 6,090 |

About 21 of the 37 IMPLEMENT headlines are operator-only (host, merge, update-branch, triage, frontier). A dispatched worker cannot act on them (INFERRED from each body's subject).

## What each agent reads

Commands (run from the repo root, Node 24):

```
wc -c CLAUDE.md AGENTS.md                         # 14725, 10475
grep -c '^- \*\*' CLAUDE.md AGENTS.md             # 63, 63
# skill index (name + description frontmatter):
for f in .claude/skills/*/SKILL.md; do awk '/^---$/{n++;next} n==1' $f; done | grep -E '^(name|description):' | wc -c   # 2119
# worker prompt parts (tsx script importing the real functions):
#   buildRuleHeadlinesPart(true, "CLAUDE.md", readFileSync, "CLAUDE.md")  -> 10785
#   renderDoctrinePreamble()                                              -> 433
#   BRANCH_NAME_CONTRACT_PART                                             -> 459
#   CODEX_DOCTRINE_PRELUDE                                                -> 202
#   buildReviewPrompt(minimal input) + reviewerVerdictContract(1)         -> 3874 + 2329; 0 CLAUDE.md headlines matched
```

| agent | doctrine it gets at session start | bytes | label |
|---|---|---|---|
| Interactive Claude session | CLAUDE.md, loaded natively (it has no `@` imports), plus the skill index from 13 `.claude/skills`. The SessionStart hook (`.claude/hooks/session-start.sh`) only sets `core.hooksPath` and prints nothing. | 14,725 + ~2,119 | OBSERVED (files); INFERRED that Claude Code loads the skill index as a name+description list |
| Claude worker (implement) | `settingSources: []` (src/lib/worker.ts `WORKER_SPAWN_ISOLATION`), so CLAUDE.md is **not** auto-loaded. But the prompt carries `rule_headlines` (src/cli/commands/run-task-verb.ts `buildRuleHeadlinesPart`), which is on by default (plan/policy.yaml `workerRuleHeadlines.enabled: true`). That is every headline plus a pointer line. It also carries the doctrine preamble and the branch contract. src/lib/compaction.ts re-injects the headlines after compaction. Matched learnings (up to 8,148 chars, `DEFAULT_KNOWLEDGE_BUDGET_CHARS`) are separate. | 10,785 + 433 + 459 | OBSERVED |
| Claude worker body lookup | `mcp__knowledge__rule` (`createWorkerRuleTool`) reads CLAUDE.md and the doctrine bodies on demand | per call | OBSERVED |
| Codex worker (implement) | AGENTS.md as the project doc (`project_doc_fallback_filenames=["AGENTS.md","CLAUDE.md"]`, cap 65,536), plus `CODEX_DOCTRINE_PRELUDE`, plus the same implement prompt, `rule_headlines` included. `buildRuleHeadlinesPart` runs before provider routing and has no provider condition. So the 63 headlines arrive **twice**. The prelude also tells it to read CLAUDE.md first. | 10,475 + 202 + 10,785 (+14,725 if it follows the prelude) | OBSERVED for the parts; INFERRED that it reads CLAUDE.md |
| Reviewer (`remudero-review`) | `buildReviewPrompt` + `reviewerVerdictContract` (src/lib/review.ts) contain no CLAUDE.md headline, no `doctrine/` path and no rule index. A Claude reviewer has `settingSources: []`, so it gets **0 bytes** of CLAUDE.md doctrine. A Codex-routed reviewer runs in a PR-head checkout and would auto-load AGENTS.md + prelude through the same spawn args. The reviewer's provider is host mount config, not in this repo. | Claude: 0; Codex: 10,677 | OBSERVED (prompt); INFERRED (Codex route) |

So the claim that "CLAUDE.md reaches only the interactive lane", stated in the budget baseline's W1-T2759 correction and in `BRANCH_NAME_CONTRACT_PART`'s comment, is now only half true. The bodies don't reach workers, but every headline does, through the prompt (OBSERVED).

## Recommendation

Do not move anything yet. These moves are ranked by value over risk. Each one is its own filed task. W1-T3323's frozen bodies (test/fixtures/doctrine-pre-migration-W1-T3323.json) stay as they are, because every move below edits only headline lines or prompt assembly, never a `doctrine/` body.

1. **Drop the duplicate headline index for Codex.** Skip `rule_headlines` when the routed provider is Codex, or drop the AGENTS.md project doc, but not both. Saves about 10.5 KB per Codex turn 0.
   - Falsifier: a test that renders a Codex implement prompt and finds each headline exactly once across AGENTS.md + prompt.
   - Risk: `rule_headlines` is the wipe-test "rules" factor (`maskRules`). Dropping it on Codex breaks the A/B arm there. Routing happens after the prompt is rendered, so this may need the provider earlier.

2. **Give the reviewer the 8 REVIEW headlines** (#14, 38, 43, 46, 48, 54, 57, 62), as a short "house review standards" block in `buildReviewPrompt`. About 1.2 KB. This is the Pocock move: review has the most spare context.
   - Falsifier: `buildReviewPrompt` output contains each of the 8 headlines. A seeded diff that breaks one (for example a `catch` returning `[]`) gets a REVIEW_FINDING.
   - Risk: the reviewer may FAIL on standards that are not acceptance criteria. Its prompt says "do not invent criteria". Keep them advisory (findings only, never a verdict downgrade), or they will stall merges.

3. **Shrink CHECK headlines to a short pointer that names the check.** Example: "#63 `expiring-fixture-census` refuses fixed dates → doctrine/...". This applies to the 18 CHECK rows, and could cut about 1.5–2 KB from CLAUDE.md, AGENTS.md and `rule_headlines` each.
   - Falsifier: for each shortened headline, the named script or test exists and its refusal still fires. Delete the check and see the suite go red (doctrine/coverage-traps/delete-the-fix.md).
   - Risk: authors lose the *why* before the push and pay a CI round instead. #2, #8 and #50 are only partial or warn-level, so keep their full headline. Headline edits touch `doctrine/merged-rules.json` aliases and the tests that walk CLAUDE.md (test/the-doctrine-index-points-at-every-body.test.ts, test/a-retired-index-line-keeps-its-frozen-bullet.test.ts). Keep the old ids as aliases.

4. **Move the ~21 operator-only IMPLEMENT headlines** (#17, 19, 26, 27, 31–33, 35, 37, 39–41, 59, 60 and similar) out of the worker-facing index and into an operator-only section. They stay in CLAUDE.md for interactive sessions.
   - Falsifier: a worker-prompt census showing these headlines are absent from `rule_headlines` and AGENTS.md, and that no recent worker run looked them up with `mcp__knowledge__rule`. Check the lookup ledger rows before moving.
   - Risk: an interactive session that is really doing operator work through a worker lane loses the reminder. The headline parser has no notion of "audience" yet, so this needs a marker in CLAUDE.md that `parseRuleHeadlines` honours, which is a new instrument (Standing rule 25: land it on its own).

5. **Keep #30 (decode-rule-citations) and the index preamble as they are.** They are navigation, which is what Pocock says CLAUDE.md is for.

6. **Fix the stale statements** (W1-T2759 note in scripts/claude-md-budget-baseline.json; the `BRANCH_NAME_CONTRACT_PART` comment) so they say workers get the headlines through the prompt.
   - Falsifier: grep for "never loads CLAUDE.md" returns only accurate sentences.
   - Risk: none to behaviour. It is comment churn on an instrument file, so it is a separate PR.

What could get worse overall (INFERRED): CHECK and REVIEW headlines only stop mistakes at the cost of a CI or review round. The author-time headline is the cheap path. Measure fix-round counts per headline class before and after any move, using rule-efficacy (src/lib/rule-efficacy.ts). Then roll back any class whose rounds rise.
