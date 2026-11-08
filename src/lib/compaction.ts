import { visibleCriteria, type AcceptanceCriterion, type Task } from "./plan.js";
import { checkpointCommitSubject } from "./unfinished-checkpoint.js";

/**
 * SDK compact_boundary metadata (sdk.d.ts 0.3.210; MASTER-PLAN §8B).
 * CamelCase matches WorkerResult; workerLedgerFields exposes it verbatim on the ledger.
 */
export interface CompactionEvent {
  trigger: "manual" | "auto";
  preTokens: number;
  postTokens?: number;
  durationMs?: number;
}

/**
 * Scan compact_boundary messages, skipping other shapes. collectWorkerResult calls
 * this per live message; recorded fixtures need not form a complete SDK stream.
 */
export function detectCompactionEvents(messages: unknown[]): CompactionEvent[] {
  const events: CompactionEvent[] = [];
  for (const raw of messages) {
    const msg = raw as { type?: string; subtype?: string; compact_metadata?: unknown };
    if (msg?.type !== "system" || msg.subtype !== "compact_boundary") continue;
    const meta = (msg.compact_metadata ?? {}) as {
      trigger?: string;
      pre_tokens?: number;
      post_tokens?: number;
      duration_ms?: number;
    };
    const event: CompactionEvent = {
      trigger: meta.trigger === "manual" ? "manual" : "auto",
      preTokens: typeof meta.pre_tokens === "number" ? meta.pre_tokens : 0,
    };
    if (typeof meta.post_tokens === "number") event.postTokens = meta.post_tokens;
    if (typeof meta.duration_ms === "number") event.durationMs = meta.duration_ms;
    events.push(event);
  }
  return events;
}

/**
 * W1-T2245: failed attempts emit status, not boundary (SDKStatusMessage, sdk.d.ts 0.3.233).
 * Without this channel they look like no attempt. Preserve compact_error only when supplied.
 */
export interface CompactionFailure {
  error?: string;
}

/**
 * Scan failed system/status messages, skipping other shapes. collectWorkerResult calls
 * this alongside the boundary detector on the existing stream; no spawn option changes.
 */
export function detectCompactionFailures(messages: unknown[]): CompactionFailure[] {
  const failures: CompactionFailure[] = [];
  for (const raw of messages) {
    const msg = raw as { type?: string; subtype?: string; compact_result?: string; compact_error?: string };
    if (msg?.type !== "system" || msg.subtype !== "status" || msg.compact_result !== "failed") continue;
    const failure: CompactionFailure = {};
    if (typeof msg.compact_error === "string") failure.error = msg.compact_error;
    failures.push(failure);
  }
  return failures;
}

/**
 * One compaction makes a run quality-suspect: re-verify proofs against repo state,
 * never a possibly-lossy REPORT (MASTER-PLAN §8B; W1-T3F).
 */
export function isQualitySuspect(events: CompactionEvent[]): boolean {
  return events.length > 0;
}

/**
 * Shared implement/fix commit contract (W1-T129/W1-T351; test/commit-message.test.ts).
 * Hosted commitlint reads the live PR title; local gates validate the commit range and hooks
 * validate individual messages. Squashing exempts none; final subjects describe finished work.
 * subject-case rejects uppercase acronyms too.
 */
export function commitMessageContractLines(): string[] {
  return [
    "- COMMIT MESSAGE — HOSTED `commitlint` checks the PR TITLE, read LIVE via `gh pr view`.",
    "  LOCAL preflight/preflight-author check the branch commit range, not only a title:",
    "  commitlint applies its configured ignore rules; emitter-checks validates non-merge commits.",
    "  Commit hooks validate individual messages too. This repo squash-merges every PR, but",
    "  discarding branch history at merge does NOT waive local range checks or make a checkpoint final.",
    "  Use `chore(checkpoint):` for unfinished checkpoints; legacy `wip:` history still resumes",
    "  and can fail local validation. The explicit PR title AND your run's FINAL commit subject",
    "  must name finished work, never a checkpoint (a lone-commit squash can use that subject):",
    "  * Conventional Commits: `type(scope): subject` — type is one of build|chore|ci|docs|",
    "    feat|fix|perf|refactor|revert|style|test, lower-case.",
    "  * The header (that whole first line) must be <= 100 CHARACTERS. Count characters, not",
    "    bytes — an em-dash is 3 bytes but 1 character. Put detail in the body, not the header.",
    "  * Start the subject LOWER-CASE. There is NO acronym exemption — `SSE stream severed`",
    "    and `URL round-trips` are both REJECTED. Lower-case it (`sse …`) or reword. No final `.`.",
    "  * Wrap every BODY line at <= 100 characters, with a blank line after the header.",
    "  * Example: `feat(serve): add fuzzy search to the board (W1-T157)`",
    // W1-T1012: THE TRAILER'S HOME, CORRECTED. Until this line the contract taught a worker
    // ONLY that the `Remudero-Task: <id>` trailer belongs in the PR body — and this repo's
    // `gh pr merge --squash` (no `--subject`/`--body`) composes the squashed commit from the
    // BRANCH'S OWN COMMITS and discards the PR body outright, so a trailer written only there
    // never reaches origin/main (measured: 373 of 538 trailered merges, 69%). The harness now
    // appends the trailer to this commit itself, right before opening the PR
    // (`appendTaskTrailerToCommit`, run-task.ts), idempotently — so the two bullets below are
    // a safety net (a worker that writes it first pays no second amend), not a new obligation.
    "  * The `Remudero-Task: <id>` trailer belongs on THIS COMMIT too, not only the PR body —",
    "    the squash-merge keeps this commit and discards the PR body, so a trailer written only",
    "    into the body never reaches origin/main.",
  ];
}

/**
 * Shared verbatim by implement, fix and anchor prompts (impl-FV; recon-FT).
 * bodyContradictsDiff feeds judgeReview as a required failure (#974, #1025).
 * Its anchored predicates judge a sentence's subject, not a forbidden-word list:
 * claimsChangesetContext looks backward; noClaimIsAboutChangeset looks forward.
 */
export function bodyVsDiffContractLines(): string[] {
  return [
    "- YOUR PR BODY IS CHECKED AGAINST YOUR OWN DIFF: a body that contradicts its changeset FAILS",
    "  remudero-review outright, with no proof or keyword floor to fall back on. The rule is about a",
    "  SENTENCE'S SUBJECT, never a word blacklist — if the subject is YOUR CHANGESET it must be true",
    "  of it, and the identical words about anything else are deliberately ignored. Three shapes:",
    "  (1) `exactly N file(s)` — read only when tied to the changeset by a `:` list after it or a",
    "  changeset word ('changed'/'touches'/'diff'/'this PR') earlier in the SAME sentence; N must",
    "  equal your real file count and every file you name must be in the diff. (2) `no <path>` —",
    "  read when the next word on that line is a changeset word, OR when nothing follows it on that",
    "  line; that path must really be absent ('no bugs' is ignored — not a path). (3) the hyphenated",
    "  shorthands `plan-only`/`data-only` — read as a claim when they are the SUBJECT of the line:",
    "  used as a label (`Plan-only: …`), predicated with a linking verb (`this is plan-only`), or",
    "  beside a changeset word in the same sentence. Naming one inside a path, or describing another",
    "  PR with it, is ignored — but if you predicate it of YOUR diff it must be literally true.",
    "  RE-CHECK AFTER EVERY PUSH — a body written against an earlier diff goes stale silently.",
  ];
}

/**
 * W1-T464 removed W1-T295's worker ciParityContractLines obligation: a 15–17 minute
 * run logged preflight.failed without gating a push. W1-T455 owns fake-spawn ledger pollution.
 * The hand-route CLI remains (W1-T221/W1-T294; lib/ci-parity.ts, docs/cli-reference.md),
 * as do base preflight checks. Workers instead have the non-halting blocked_ci fix rung.
 */

/**
 * W1-T2997: cheap pre-push ratchets, not the removed full preflight. The fix rung failed
 * to close fleet PRs (#4330, #4324, #4343, #4333); workers need the rule in their prompt
 * because spawnWorker uses settingSources: [] rather than loading CLAUDE.md.
 */
export function ratchetContractLines(): string[] {
  /*
   * Keep baseline-recording gates separate from no-allowlist gates: the latter need repairs,
   * not recorded debt. Name all three; source-text-assertion-census was missed in #4351.
   * Preserve literal guards: W1-T58's test/run-task.test.ts forbids the plan's path even in
   * prohibitions, and test/ci-parity-contract.test.ts forbids spelling the removed command.
   * Describe both indirectly rather than weakening those assertions.
   */
  return [
    "- BEFORE YOUR FIRST PUSH, run the two CHEAP ratchets over your own change — seconds, not",
    "  minutes, and the single most common reason a fleet build lands red:",
    "    npm run --silent comment-load-signal",
    "    npm run --silent source-size-ratchet",
    "  If either BLOCKS it prints the exact JSON line to write into its baseline file, and calls",
    "  recording 'an ordinary, reviewed outcome, not a defeat'. Record it in THIS commit and re-run",
    "  until both print OK. Deliberate growth is expected; leaving it unrecorded is not.",
    "- THREE OTHER RATCHETS EXIST AND MUST NOT BE TREATED THE SAME WAY. If any of",
    "  test/negative-reachability-ratchet.test.ts, test/catch-erasure-ratchet.test.ts or",
    "  test/source-text-assertion-census.test.ts fails, do NOT record a number: the first two say",
    "  in their own text 'no allowlist to add it to', and the third says re-capturing its baseline",
    "  upward 'is NOT a remedy — that is the ratchet this task exists to hold'. A recorded number",
    "  there banks the debt instead of paying it. Each names the repair it wants: a fixture that",
    "  drives the surface's UNHEALTHY arm and asserts an output; a catch that binds its error and",
    "  carries a reason; or, for a new source-text read, asserting on BEHAVIOUR instead — and only",
    "  where the test's SUBJECT genuinely IS the source text, the declared '@source-text-subject'",
    "  marker, which makes that choice reviewable rather than silent. If that repair does not fit",
    "  this task's one concern, say so in your REPORT's '## Follow-ups' rather than silencing it.",
    "- THEN ASK WHICH CENSUS SUITES YOUR DIFF JOINS, and run the ones it names:",
    "    rmd census-membership",
    "  A census suite WALKS a population — every tracked src file, every test file, every COMMANDS",
    "  entry — and asserts a property of the WHOLE SET. So it reddens on a file that references",
    "  nothing it touches, which is why `git grep <symbol>` cannot find it and why these are the",
    "  failures that reach CI. This verb maps your changed paths to exactly those suites; running",
    "  what it names costs about a second each. It is NOT the full preflight and does not bring it",
    "  back: it runs a handful of suites your OWN diff can move, not the whole tree.",
    "  MEASURED 2026-09-07, against the gates that actually refused that day: src/run-task.ts ->",
    "  command-registry-census (the COMMANDS count), src/lib/policy.ts -> config-reader-seams-census,",
    "  src/lib/dep-review.ts -> negative-reachability-census, a new test/ file -> source-text-census.",
    "  Four of the five, each one a CI cycle that need not have been spent. The fifth,",
    "  instrument-surface, is not in this map — so this narrows the gap, it does not close it.",
    "- IF YOUR DIFF TOUCHES `plan/` AT ALL, ask this before pushing — it costs milliseconds:",
    "    npm run --silent rule15-precheck",
    "  Standing rule 15 makes criteria text Architect-only: a diff that ADDS or EDITS a claim/proof",
    "  in the plan's own task file or one of its shards is REFUSED unless the PR is plan-only. Filing a",
    "  shard beside your own implementation trips it every time. MEASURED 2026-09-07: three PRs did",
    "  exactly that, each refused after a FULL CI cycle, each repaired the same mechanical way — lift",
    "  the shard into its own plan-only PR, drop it from this branch. The gate named that remedy in",
    "  its own refusal every time and nothing executed it. The check imports the reviewer's OWN",
    "  predicate, so it cannot tell you to split something the gate would have passed.",
    "- This is NOT the full CI-parity preflight, which stays REMOVED from your contract (W1-T464):",
    "  that one runs ~15-17 minutes and is the hand route's gate, not yours. Do not run it.",
  ];
}

/**
 * Explicit implement role, shared by renderImplementPrompt and renderAnchorBlock, never recon.
 * Five dispatches returned recon reports without it (state/recon-implement-acts-as-recon.md;
 * db4e110). Keep it before # CONTEXT: extractContext/assertProvenance require [src:] inside
 * that region. The role must survive compaction without drifting from the turn-0 prompt.
 */
export const IMPLEMENT_ROLE_LINES: readonly string[] = [
  "You are an IMPLEMENT worker: YOU write the code in this run.",
  "The change described under TASK is yours to MAKE NOW — not to investigate, summarise, or file as",
  "follow-up work for someone else to do. Recon has already run; anything under CONTEXT is its",
  "report TO you, not your assignment. A run that ends in a report with no diff has FAILED, however",
  "accurate the report.",
];

/** Shared PR-authoring authority boundary; the command hook enforces ordinary CLI paths. */
export const WORKER_PR_AUTHORITY_LINES: readonly string[] = [
  "- You may create or update the PR, but NEVER merge it or arm auto-merge. The orchestrator owns",
  "  that decision after CI and semantic review; stop after reporting the PR URL.",
];

/** W1-T4268: both PR-authoring prompts use W1-T2948's prBodyRestArgs fallback for GraphQL
 * transport failures. Never infer whether an edit landed; use -f because -F reads @files
 * and expands placeholders. Splice beside WORKER_PR_AUTHORITY_LINES. */
export const GH_PR_EDIT_FALLBACK_LINES: readonly string[] = [
  "- If `gh pr edit` fails with \"Projects (classic) is being deprecated\" /",
  "  `repository.pullRequest.projectCards`, that is a TRANSPORT failure of gh's GraphQL query, never",
  "  evidence the edit was rejected or already applied. Use the REST substitute instead:",
  "  `gh api -X PATCH repos/{owner}/{repo}/pulls/{number} -f body=<text>` (or `-f title=<text>`),",
  "  with the real owner, repo and PR number. Use `-f`, NEVER `-F`: `-F` reads a value starting",
  "  with `@` as a FILENAME and substitutes `{owner}`/`{repo}`/`{branch}` placeholders.",
];

/**
 * W1-T3696 step (2)/W1-T3572: when the harness owns git, shell-less workers save edits and
 * name a commit subject; the harness commits, pushes and opens the PR. Reporting, follow-ups,
 * learnings and ALREADY_SATISFIED remain required; forge authority stays with the harness.
 */
export function outputContractLines(taskId: string, harnessCommits = false): string[] {
  return [
    "# OUTPUT CONTRACT",
    // Check scope before editing, including in the shell-less variant (IMPLEMENT_CASH_TOOLS).
    "- BEFORE EDITING, open your task record and, using Read and Grep at this HEAD: (a) re-verify",
    "  every file:line it cites — cited lines drift, and a record that names a symbol that no longer",
    "  exists is premise-rotted (REFUSED, class `premise-rotted`); (b) check whether each acceptance",
    "  proof already passes on origin/main — if every one does, the exit is ALREADY_SATISFIED (below).",
    "  Then act on what you found.",
    "- Make ONLY the change described in TASK; one concern.",
    ...ratchetContractLines(),
    // W1-T502: checkpoint objects/refs survive reapStaleWorktrees in the parent clone;
    // dirty files do not. Conventional checkpoint subjects still pass local message gates.
    "- CHECKPOINT AS YOU GO: after each meaningful unit of work — a test newly green, a decision",
    "  taken, an approach abandoned — commit everything on THIS run's branch with subject",
    `  \`${checkpointCommitSubject("<what>")}\` and a body carrying a \`[remudero-context]\` block: one line each for decided /`,
    "  remaining / failed. This worktree is reapable and its dirty files are your ONLY copy of the",
    "  work until you commit it — checkpoints land in the parent clone's shared object store and",
    "  survive a worktree wipe; nothing else does. Checkpoints are ADDITIONAL commits, never a",
    "  substitute for the terminal commit below.",
    // W1-T105: retro.ts harvests out-of-scope follow-ups as plan proposal candidates.
    "- FOLLOW-UPS (optional): anything you discover that is OUT OF SCOPE for this",
    "  one concern — a research question, a follow-up task, or an action someone",
    "  should take — goes in a '## Follow-ups' section of your REPORT, NEVER into",
    "  the diff. One typed entry per line, its own one-line why included inline:",
    "  `research: <what, and why>` | `task: <what, and why>` | `action: <what, and why>`.",
    "- If a filename/approach choice is needed, FIRST emit a DECISION_REQUEST",
    "  (exactly two options, one marked RECOMMENDED, a reversibility note, and a line",
    "  `FALSIFIER: <what you would observe if RECOMMENDED is the wrong choice>`) and STOP.",
    // W1-T272: resolveAlreadySatisfied requires a named merged PR; unverifiable claims
    // still fall through to no_pr. This avoids manufacturing no-op closure PRs.
    "- If the task's acceptance is ALREADY SATISFIED on origin/main — nothing left to change —",
    "  say so and STOP without opening a PR: end your REPORT with a line",
    "  `ALREADY_SATISFIED: <the PR number or url that already merged and satisfies this task>`.",
    `  That PR must actually be MERGED and its body must carry \`Remudero-Task: ${taskId}\` for`,
    "  THIS task, or the claim is refused and treated as if you had opened no PR at all.",
    // The QUESTION contract parseQuestion (worker.ts) reads and run-task.ts logs without blocking.
    "- A fact you cannot settle from the repo, and that is not worth a DECISION_REQUEST: look it up",
    "  first; if it is still unknown, state it as three lines and proceed on the assumption —",
    "  `QUESTION: <what you do not know>` `CURRENT_ASSUMPTION: <what you proceed on>` `IMPACT_IF_WRONG: low|med`.",
    ...(harnessCommits
      ? [
        "- Otherwise: just SAVE YOUR EDITS TO THE FILES. Do NOT run git or gh — you have no shell,",
        "  and attempting one wastes a turn. The harness commits your edits, pushes the branch and",
        "  opens the pull request for you.",
        "- Name the commit subject on its own line, anchored exactly like PR_URL:",
        "  `COMMIT_MESSAGE: <type>(<scope>): <subject>`. Conventional Commits, lower-case subject,",
        "  at most 100 CHARACTERS total — a longer or missing line is refused and your edits are",
        "  NOT committed, so the run produces nothing.",
      ]
      : ["- Otherwise: stage the changed file(s) and commit."]),
    // W1-T465: headless runs have no background wake-up; eight runs ended with no_pr.
    // Explain the mechanism and polling shape so interactive affordances do not mislead.
    "- NEVER background a long job and then end your turn to wait for it. THERE IS NO NOTIFICATION",
    "  CHANNEL in this run: nothing will wake you when a background task finishes, and the run ENDS",
    "  the moment you stop issuing tool calls — your work is discarded with it, however far you got.",
    "  If you background anything, POLL it yourself and keep issuing tool calls until it is done,",
    "  e.g. `until [ -f /tmp/done ]; do sleep 20; done` — or simply run the command in the",
    "  foreground and wait for it to return.",
    "  Then: `git push origin HEAD` (NOT `-u` — the shared .git/config is",
    "  outside the sandbox write scope, WS-0 FF10f), and open a PR with an EXPLICIT, conventional",
    "  `--title` rather than deriving one: checkpointing (above) means a multi-commit run branch",
    "  is normal, and `gh pr create --fill` derives a multi-commit PR's title from the BRANCH",
    "  NAME, which is not a conventional subject. Pass it yourself, e.g. `gh pr create --title",
    "  \"type(scope): subject\" --fill --base main`.",
    ...WORKER_PR_AUTHORITY_LINES,
    ...GH_PR_EDIT_FALLBACK_LINES,
    ...commitMessageContractLines(),
    `- Include this exact trailer as the LAST line of the PR body: Remudero-Task: ${taskId}`,
    // W1-T81/T82 (#677/#683): review requires the body to engage every acceptance proof.
    // Keep turn-0 guidance in sync with renderFixPrompt, including prose-proof handling.
    "- Your PR body MUST substantiate EVERY task acceptance criterion: for each, say how the",
    "  diff satisfies it and NAME the test or grep that proves it. remudero-review executes each",
    "  proof and, when a proof is not executable, judges your body against that proof's own text —",
    "  a body that does not engage each proof is scored UNMET even when the work is correct.",
    ...bodyVsDiffContractLines(),
    // W1-T2760: report use, not just injection, for mineGitLogCitations/retro ranking.
    // parseLearningsUsed rejects IDs absent from the injected context.
    "- Your REPORT must ALSO include a line naming the learnings you actually ACTED ON this run —",
    "  anchored to its own line start, exactly like PR_URL: `LEARNINGS_USED: learnings#<id>,",
    "  learnings#<id>` for one or more, or `LEARNINGS_USED: none` if you used none. REQUIRED: a",
    "  silent report must be distinguishable from one that explicitly claims none. Only cite an id",
    "  that was actually injected into your CONTEXT above — an id you were never shown is refused",
    "  by name and never counted as used.",
    // W1-T4114: parseSkillsUsed mirrors parseLearningsUsed; skills.selection records offers,
    // while this records actual use for the knowledge gardener's SKILL-LIFECYCLE class.
    "- Your REPORT must ALSO name the skills you actually USED this run — anchored to its own line",
    "  start, exactly like PR_URL: `SKILLS_USED: skill#<name>, skill#<name>` for one or more, or",
    "  `SKILLS_USED: none` if you used none. REQUIRED: a silent report must be distinguishable from",
    "  one that explicitly claims none. Only cite a name that was actually shown to you as a",
    "  `## skill: <name>` section above — a name you were never shown is refused by name and never",
    "  counted as used.",
    ...(harnessCommits
      ? ["- End with a REPORT. Do NOT write a PR_URL line: you opened no pull request, and the",
         "  harness reads the url back from the one it creates."]
      : ["- End with a REPORT whose LAST line is exactly: PR_URL: <the pull request url>"]),
  ];
}

/**
 * MASTER-PLAN §8B: build once per run; re-inject goal, criteria and constraints verbatim.
 * Exclude volatile recon/matched-learnings CONTEXT (§8A). visibleCriteria also excludes
 * holdouts here, exactly as at turn 0 (W1-T166).
 * W1-T2761 (iii): reuse buildRuleHeadlinesPart's stable turn-0 string unchanged;
 * the empty default preserves existing two-argument callers' output.
 */
export function renderAnchorBlock(
  task: Pick<Task, "id" | "title" | "prompt" | "acceptance">,
  runId: string,
  ruleHeadlinesPart = "",
  // W1-T3696: match turn 0 or compaction tells a shell-less worker to commit again.
  harnessCommits = false,
): string {
  const goal = (task.prompt ?? task.title).split("${RUN_ID}").join(runId).split("${TASK_ID}").join(task.id);
  const criteria = visibleCriteria(task.acceptance ?? [])
    .map((c: AcceptanceCriterion) => `- claim: ${c.claim}\n  proof: ${c.proof}`)
    .join("\n");
  return [
    ...IMPLEMENT_ROLE_LINES,
    "",
    "# ANCHOR (re-injected verbatim after compaction — MASTER-PLAN §8B)",
    "",
    // Empty headlines add nothing, matching renderImplementPrompt at turn 0.
    ...(ruleHeadlinesPart ? ["## RULE HEADLINES (CLAUDE.md, re-injected unchanged)", ruleHeadlinesPart, ""] : []),
    "## GOAL",
    goal,
    "",
    "## ACCEPTANCE CRITERIA",
    criteria || "(none declared)",
    "",
    ...outputContractLines(task.id, harnessCommits),
  ].join("\n");
}

/**
 * Return N unchanged anchors for N boundaries. Recorded-stream detection/mapping is
 * verify:auto (W1-T36, Rules 18/20); live duplex wiring is W1-T12e's operator-golden drill.
 */
export function anchorReinjections(messages: unknown[], anchor: string): string[] {
  return detectCompactionEvents(messages).map(() => anchor);
}
