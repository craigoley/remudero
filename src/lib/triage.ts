import type { Escalation, EscalationOption } from "./escalate.js";
import { join } from "node:path";
import { shapeCommitMessage } from "./commit-message.js";
import { loadPlan } from "./plan.js";
import { ACCEPTANCE_PROOF_GRAMMAR } from "./proof-grammar.js";
import { diffEmptyAgainstScope } from "./review.js";
import { feedbackEntryRepoPath } from "./feedback.js";
import { envelope } from "./untrusted-envelope.js";
import type { FeedbackEntry, FeedbackStatus } from "./feedback.js";

/**
 * `rmd triage` — the Architect intake worker (MASTER-PLAN §7B, W1-T41).
 *
 * "An Architect worker over a feedback entry. Tools: Read/Glob/Grep/WebSearch/WebFetch + Write
 * scoped to plan files ONLY (never src/). Grounds against plan/learnings/ledger/DECISIONS,
 * researches via server-side WebSearch, then (if clear) opens a plan PR naming the §sections
 * changed, tasks added/rewired, rationale, and provenance back to feedback#<id>." [MASTER-PLAN §7B]
 *
 * ★ TRIAGE MUST RUN STRICTLY SERIALLY — WITH ITSELF AND WITH ANY HAND-RUN. READ THIS BEFORE
 * ADDING A CALLER (a daemon rung, a cron, a second lane).
 *
 * The task id is minted by the HARNESS from a snapshot BEFORE the worker starts (see the ID
 * SELECTION block in `triagePrompt` below). Two runs that start before either opens its PR
 * therefore mint the SAME id. Because each writes its own `plan/tasks.d/<id>-<slug>.yaml` and the
 * slugs differ, the two branches touch DIFFERENT FILES — so git merges both cleanly and `loadPlan`
 * (lib/plan.ts) then throws duplicate-task-id ON MAIN, breaking every plan-loading check for
 * everyone.
 *
 * This is WORSE than it was before proposals were sharded. When both runs appended to the
 * `plan/tasks.yaml` monolith they collided textually at EOF: ugly, but LOUD, PRE-MERGE and
 * unmergeable. Sharding traded a conflict you cannot merge for a merge that poisons the plan.
 * That trade is only safe while something serialises triage.
 *
 * What serialises it TODAY — CORRECTED, this paragraph was stale and said "nothing explicit":
 *   (1) The daemon's poll loop is single-threaded and awaits each dispatch, so daemon-initiated
 *       runs cannot overlap each other.
 *   (2) PR #1069 added a SHARED lock across triage's two paths: `triageCommand` (run-task.ts)
 *       acquires it before doing anything and refuses loudly if held, and `decideAutoTriage`
 *       (lib/auto-triage.ts) refuses on `lockHeld`. The hand-run-versus-daemon race the previous
 *       wording described as open has been closed since 2026-08-01.
 *   (3) The minted id is now RESERVED atomically (lib/task-id-reservation.ts's
 *       `reserveTaskIdFrom`, one `O_EXCL` file per id under `<root>/state/task-id-reservations/`)
 *       BEFORE the worker spawns. That is the "atomic claim at mint time" this comment used to ask
 *       for, and it covers a caller the LOCK cannot: the lock is triage-specific, so it never
 *       excluded `rmd plan --mode=create`, a second machine, or a cross-repo instance filing into
 *       this plan. Contention ADVANCES the id rather than refusing, so no caller waits.
 *
 * `assertProposedPlanLoads` remains the pre-push backstop (it re-loads monolith + shards from the
 * worker's own worktree, so a collision against MAIN is refused before anything is pushed).
 *
 * STILL NOT COVERED, and the reason this comment stays long: `rmd plan --mode=create` does not
 * call the mint AT ALL — `planArchitectPrompt` receives no minted id, so its worker picks one by
 * reading the plan files. Nothing reserves what was never minted. Routing that lane through the
 * mint is the remaining work.
 *
 * THE THREE-WAY VERDICT, deterministic (mirroring lib/dep-review.ts's `decideDepReview` — the
 * judge is CODE, the LLM layer is advisory only, Standing rule 2):
 *   - ALREADY_DECIDED — the ground step found the feedback's answer already settled somewhere in
 *     plan/learnings/DECISIONS. No plan files change. NO redundant task is created — the whole
 *     point of grounding (re-deciding a settled question is a failure mode, not a feature).
 *   - AMBIGUOUS        — the item needs a human's judgment call. No plan files change. Status
 *     parks at `grilling`, and the harness (run-task.ts's `triageCommand`) opens a `needs-human`
 *     GitHub issue reusing §4's escalation machinery (W1-T42) — the ONLY viable grill mechanism.
 *     ★ VERIFIED (LEARNINGS.md "AskUserQuestion neither works headlessly nor stalls"):
 *     AskUserQuestion silently auto-resolves EMPTY with no TTY (~37ms, no error, nothing
 *     collected) rather than hanging, and this worker always runs via spawnWorker — a subprocess
 *     with no TTY BY CONSTRUCTION, regardless of the invoking shell — so the interactive branch
 *     MASTER-PLAN §7B names is structurally unreachable here; `.remudero/skills/feedback.yaml`
 *     no longer lists `AskUserQuestion` in its tools. Because the async issue is the only path,
 *     the AMBIGUOUS verdict below must always carry actionable OPTION:/RECOMMENDATION: lines —
 *     `escalate()` refuses a bare-alert issue with no options.
 *   - PROPOSED         — a plan-only PR naming the §sections/tasks changed, with `origin:
 *     feedback#<id>` provenance on every new/rewired task.
 *
 * THE WORKER NEVER RUNS GIT (`.remudero/skills/feedback.yaml`'s `tools:` carries no `Bash`, unlike
 * `retro.yaml`) — it only GROUNDS/RESEARCHES/EDITS plan files via Read/Grep/Glob/WebSearch/Write.
 * The commit/push/PR-open/gate sequence is HARNESS-OWNED (run-task.ts's `triageCommand`),
 * deterministic, and identical in shape for all three verdicts — the same "the harness eats
 * first" discipline `regenerateOrientation` already established for the retro's docs write.
 */

// ── Arg parsing (pure — the `rmd triage` CLI arg shape) ─────────────────────

export interface ParsedTriageArgs {
  feedbackId: string;
}

/**
 * Parse `rmd triage <feedback-id>`. Pure (no I/O) so it is unit-testable without a filesystem.
 * FAILS LOUD (returns `{ error }`, never a silent best-guess) on a missing id, an unrecognized
 * flag, or extra positional arguments — the control-surface discipline every `rmd` subcommand
 * follows (Standing rule: validate flags BEFORE any spawn/write).
 */
export function parseTriageArgs(rest: string[]): ParsedTriageArgs | { error: string } {
  const positionals: string[] = [];
  for (const tok of rest) {
    if (tok.startsWith("--")) {
      return { error: `rmd triage: unrecognized flag '${tok}' — see \`rmd --help\`` };
    }
    positionals.push(tok);
  }
  if (positionals.length === 0) {
    return { error: "rmd triage: no feedback id given — usage: rmd triage <feedback-id>" };
  }
  if (positionals.length > 1) {
    return { error: `rmd triage: too many arguments — usage: rmd triage <feedback-id>, got ${JSON.stringify(positionals)}` };
  }
  return { feedbackId: positionals[0] };
}

// ── The "no such feedback entry" message (W1-T243) ───────────────────────────

/**
 * Build `rmd triage`'s exit-2 message when `feedbackId` is absent from the fresh
 * `origin/main` worktree it reads from. Before W1-T243 this printed the byte-identical
 * "no such feedback entry: <id>" whether the id was a genuine typo OR simply not yet
 * landed by the durable-inbox commit bridge (feedback-landing.ts) — indistinguishable and
 * misleading, since a captured entry can sit locally for a while before its landing PR
 * merges. Pure (no I/O) so the two branches are unit-testable without spawning `gh`;
 * `triageCommand` (run-task.ts) supplies `existsLocally` (a plain `existsSync` check
 * against `repoRoot`) and `landingPrUrl` (best-effort, via
 * {@link "./feedback-landing.js".findPendingLandingPr}).
 */
export function missingFeedbackMessage(
  feedbackId: string,
  opts: { existsLocally: boolean; landingPrUrl?: string },
): string {
  if (!opts.existsLocally) return `no such feedback entry: ${feedbackId}`;
  const where = opts.landingPrUrl
    ? `pending landing PR ${opts.landingPrUrl}`
    : "a pending landing (the durable-inbox commit bridge has not opened its PR yet)";
  return (
    `feedback#${feedbackId} exists locally but has not landed on origin/main yet — ${where}. ` +
    `Re-run \`rmd triage ${feedbackId}\` once it merges.`
  );
}

// ── The Architect prompt ─────────────────────────────────────────────────────

/**
 * The triage Architect prompt — fed one feedback entry, told to GROUND -> RESEARCH ->
 * GRILL-OR-PROPOSE, and required to end with exactly one of the three verdict markers this
 * module's {@link parseTriageVerdict} anchors on. The worker has NO Bash/git — it only edits
 * files; the caller (run-task.ts) owns commit/push/PR.
 *
 * `mintedId` (W1-T263): the id the HARNESS derived — the worker has no Bash tool, so the
 * old "run this grep and pick the next integer" instruction was an instruction it could not
 * execute, leaving id selection to eyeballing the files it happened to read. When present,
 * the prompt HANDS the id over instead of describing how to compute one.
 *
 * `additionalReservedIds` (W1-T949 design (ii)): the REST of a reserved block, beyond
 * `mintedId` itself — the harness now reserves a block up front (`reserveTaskIdBlock` +
 * `reserveTaskIdBlockRemote`) exactly as `rmd plan` already does, so a multi-task filing has
 * every id it might use ALREADY held on the shared remote, not merely `mintedId`. As long as
 * this prompt told the worker to "number them upward" instead of naming the reserved set, a
 * reserved block and a filed set could diverge by construction — the harness could hold five
 * ids while the worker invented a sixth. Defaults to empty so every existing caller that passes
 * only `mintedId` (a single reservation, or none at all) is BYTE-IDENTICAL to before this
 * parameter existed; only a caller that actually reserved more states the fuller instruction.
 */
/**
 * W1-T2700: the enveloped feedback block, built ONCE per dispatch. The envelope's boundary is
 * drawn fresh PER CALL, so calling this twice yields two different strings — a caller that wants
 * to both render the prompt AND fingerprint what the worker saw must build the block once and pass
 * it to {@link triagePrompt}, or the manifest would attest bytes the worker never received.
 */
export function feedbackEntryBlock(entry: FeedbackEntry): string {
  return envelope(entry.raw, "feedback-entry");
}

export function triagePrompt(
  entry: FeedbackEntry,
  runId: string,
  mintedId?: string,
  additionalReservedIds: string[] = [],
  // APPENDED LAST and defaulted, so every existing positional caller is byte-identical to before
  // this parameter existed; only a caller that must fingerprint the block passes its own.
  feedbackBlock: string = feedbackEntryBlock(entry),
): string {
  return [
    "You are the REMUDERO ARCHITECT running an INTAKE TRIAGE (MASTER-PLAN §7B) over one captured",
    "feedback entry. You ride a HIGHER tier than implement workers (G-17). You do NOT have a Bash",
    "tool — you cannot run git or gh. Your job ends when you have edited the right files (or none)",
    "and printed your verdict; the harness commits/pushes/opens the PR after you finish.",
    "",
    "=== THE FEEDBACK ENTRY (plan/feedback/" + entry.id + ".yaml) ===",
    `id: ${entry.id}`,
    `ts: ${entry.ts}`,
    `origin: ${entry.origin}`,
    // W1-T2700: `raw` is the WIDEST FIRST INGESTION POINT in this harness. On the `rmd issues`
    // path it is a GitHub issue body -- anyone who can open an issue on a managed repo wrote it --
    // and on the `rmd feedback` path it is operator prose that may itself quote outside text. It
    // used to be spliced bare between narrative instruction lines, one `raw:` label away from the
    // STEP 1 heading a worker obeys. `id`/`ts`/`origin` above are harness-derived and stay bare.
    "raw:",
    feedbackBlock,
    entry.attachments.length ? `attachments: ${entry.attachments.join(", ")}` : "attachments: (none)",
    "",
    "=== STEP 1 — GROUND ===",
    "Grep/Read MASTER-PLAN.md, plan/tasks.yaml, plan/tasks.d/*.yaml, LEARNINGS.md, and DECISIONS.md (all in this working",
    "directory) for whatever this feedback is asking about. Re-deciding a settled question is a",
    "failure mode, not a feature — if the answer is ALREADY there, that is your verdict, full stop.",
    "",
    "=== STEP 2 — RESEARCH ===",
    "If (and only if) grounding leaves a genuine platform-facts gap this feedback turns on, use",
    "WebSearch to close it. Skip this step entirely when grounding already answers the question —",
    "research exists to make a proposal GROUNDED, not to pad the transcript.",
    "",
    "=== STEP 3 — GRILL OR PROPOSE ===",
    "Decide exactly ONE of:",
    "",
    "  ALREADY_DECIDED — the plan/learnings/DECISIONS already answer this. Touch NO files. End your",
    "  output with a line starting exactly `ALREADY_DECIDED:` naming the deciding section/PR/entry,",
    "  e.g. `ALREADY_DECIDED: MASTER-PLAN.md §7B / PR #238`.",
    "",
    "  AMBIGUOUS — this needs a human call this triage pass cannot safely make alone. Touch NO",
    "  files. This triage runs HEADLESSLY (no terminal, no live operator) — the grill is an async",
    "  `needs-human` GitHub issue, never an interactive prompt. End your output with:",
    "    OPTION: <short label>|<what choosing it means>",
    "    OPTION: <short label>|<what choosing it means>",
    "  at least TWO `OPTION:` lines (add more only if there are genuinely more than two live",
    "  choices) — these become the issue's actionable choices (MASTER-PLAN §4: an escalation with",
    "  no options is refused as a bare alert) — then:",
    "    RECOMMENDATION: <the exact label of the option you'd pick if forced to guess>",
    "    AMBIGUOUS: <the open question, one line>",
    "  e.g.:",
    "    OPTION: cli-flag|add a --foo flag to the relevant command",
    "    OPTION: config-default|add a config default instead, no new flag",
    "    RECOMMENDATION: cli-flag",
    "    AMBIGUOUS: does this want a CLI flag or a config default?",
    "",
    "  PROPOSED — the ask is CLEAR and NOVEL. Edit ONLY plan files in this working directory",
    "  (NEVER src/ or test/) to add or rewire whatever the feedback calls for.",
    "  A NEW task MUST be created as its OWN SHARD at plan/tasks.d/<id>-<kebab-slug>.yaml — one task",
    "  per file, a single-element YAML list. plan/tasks.d/W1-T278-task-id-from-plan-history.yaml is the",
    "  model for that STRUCTURE (file shape and fields) only; for `proof:` values follow the ACCEPTANCE",
    "  PROOFS rules below, which are what CI actually enforces.",
    "  NEVER append a new task to plan/tasks.yaml: 69 filings appending to one 12.5k-line file all",
    "  collide at EOF, which is the conflict storm W1-T122 sharded the plan to prevent.",
    "  REWIRING an EXISTING task edits wherever that task already lives (the monolith or its shard).",
    "  EVERY new or rewired task MUST declare `files:` — the repo-relative paths it will touch.",
    "  An absent or EMPTY list is fail-closed at dispatch: overlappingPaths reports it as overlapping",
    "  every co-dispatched candidate, so the task can never batch and serialises the lane behind it.",
    "  You have Read/Grep/Glob here — derive the paths, never omit the field and never leave it empty.",
    "  MASTER-PLAN.md remains a legitimate target for a plan amendment. Every new or rewired task MUST carry",
    `  \`origin: feedback#${entry.id}\` so the provenance is traceable.`,
    ...(mintedId
      ? [
          `  ID SELECTION for any NEW task: USE EXACTLY \`${mintedId}\` — the harness already minted it`,
          "  from the max across plan/tasks.yaml, EVERY plan/tasks.d/*.yaml shard, and the ids open plan",
          "  PRs have already minted. Do NOT pick your own id and do NOT 'correct' this one: a colliding",
          "  id is refused pre-push, so a wrong pick means NO proposal opens.",
          ...(additionalReservedIds.length > 0
            ? [
                `  The harness has ALSO RESERVED ${additionalReservedIds.join(", ")} for this run, on the`,
                "  SAME shared remote store — if the feedback needs MORE than one new task, use them IN",
                "  THIS ORDER after the first. Do NOT invent an id yourself and do NOT renumber past this",
                "  reserved set: an id you choose yourself is unreserved, and another lane may be filing",
                "  it at this very moment. Filing fewer than the reserved count is normal and costs",
                `  nothing; you may file AT MOST ${1 + additionalReservedIds.length} new task(s) this run.`,
              ]
            : [
                `  If the feedback needs MORE than one new task, number them upward from ${mintedId}`,
                `  (${mintedId}, then the next integers).`,
              ]),
        ]
      : [
          "  ID SELECTION for any NEW task: ids live in BOTH plan/tasks.yaml AND plan/tasks.d/*.yaml",
          "  (the shards own ids the monolith does not — a colliding id is refused pre-push, so a wrong",
          "  pick means NO proposal opens). Mint the next integer above the highest id across the",
          "  monolith AND every shard — read both, never the monolith alone.",
        ]),
    ...ACCEPTANCE_PROOF_GRAMMAR,
    "  End your output with a line",
    "  starting exactly `PROPOSED:` with a one-line summary of what changed and why, e.g.",
    "  `PROPOSED: add W1-T200 (origin: feedback#" + entry.id + ") to cover the requested CLI flag`.",
    "",
    "Exactly one of ALREADY_DECIDED / AMBIGUOUS / PROPOSED must be the LAST line of your output.",
    "Do NOT edit plan/feedback/" + entry.id + ".yaml yourself (the harness records the resulting",
    "status/proposal_pr deterministically). Do NOT touch docs/ORIENTATION.md.",
    "",
    `(run: ${runId})`,
  ].join("\n");
}

// ── Verdict parsing (pure) ───────────────────────────────────────────────────

export type TriageVerdict =
  | { kind: "already_decided"; citation: string }
  | { kind: "ambiguous"; question: string; options: EscalationOption[]; recommendation: string }
  | { kind: "proposed"; summary: string };

/**
 * `OPTION: <label>|<detail>` lines anywhere in the worker's output — the grill's actionable
 * choices (escalate.ts's `EscalationOption[]` shape), mirroring `rmd escalate --option`'s CLI
 * parsing (run-task.ts's `parseOptionFlags`). Only meaningful when the verdict resolves to
 * AMBIGUOUS (decideTriage validates count/shape there); harmless if unused otherwise.
 *
 * W1-T2205: IDEMPOTENT on the `(label, detail)` pair — belt AND braces alongside
 * {@link "./worker.js".workerTranscript}'s join fix, because not every duplicate-OPTION source
 * is transcript-shaped (a model restating its own choices, or quoting the prompt's own OPTION
 * examples back, doubles a line with no join involved). Order is preserved and the FIRST
 * occurrence of a pair wins; a genuinely single choice repeated verbatim still collapses to one
 * option, so {@link decideTriage}'s `< 2` guard still fires for it exactly as it must.
 */
function parseGrillOptions(text: string): EscalationOption[] {
  const seen = new Set<string>();
  const options: EscalationOption[] = [];
  for (const m of text.matchAll(/^[ \t]*OPTION[ \t]*:[ \t]*(.+)$/gim)) {
    const raw = m[1].trim();
    const sep = raw.indexOf("|");
    const option = sep >= 0 ? { label: raw.slice(0, sep).trim(), detail: raw.slice(sep + 1).trim() } : { label: raw, detail: "" };
    const key = JSON.stringify([option.label, option.detail]);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

/** The LAST `RECOMMENDATION: <label>` line — {@link decideTriage} fails loud unless it matches
 * one of the parsed OPTION labels exactly. `""` when no such line appears. */
function parseGrillRecommendation(text: string): string {
  const hits = [...text.matchAll(/^[ \t]*RECOMMENDATION[ \t]*:[ \t]*(.+)$/gim)];
  return hits.length ? hits[hits.length - 1][1].trim() : "";
}

/**
 * Extract the worker's terminal verdict off its concatenated output text. Anchored to a line
 * start (like {@link "./worker.js".parseReport}'s `PR_URL:` anchoring) so a marker mentioned in
 * passing prose (e.g. quoting this very prompt back) never counts — only a line that STARTS with
 * one of the three keywords does. When more than one marker line appears, the LAST one wins
 * (mirrors the "last line of the REPORT" convention).
 */
export function parseTriageVerdict(text: string): TriageVerdict | null {
  const already = [...text.matchAll(/^[ \t]*ALREADY_DECIDED[ \t]*:[ \t]*(.+)$/gim)];
  const ambiguous = [...text.matchAll(/^[ \t]*AMBIGUOUS[ \t]*:[ \t]*(.+)$/gim)];
  const proposed = [...text.matchAll(/^[ \t]*PROPOSED[ \t]*:[ \t]*(.+)$/gim)];
  type Hit = { at: number; verdict: TriageVerdict };
  const hits: Hit[] = [];
  if (already.length) {
    const m = already[already.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "already_decided", citation: m[1].trim() } });
  }
  if (ambiguous.length) {
    const m = ambiguous[ambiguous.length - 1];
    hits.push({
      at: m.index ?? 0,
      verdict: {
        kind: "ambiguous",
        question: m[1].trim(),
        options: parseGrillOptions(text),
        recommendation: parseGrillRecommendation(text),
      },
    });
  }
  if (proposed.length) {
    const m = proposed[proposed.length - 1];
    hits.push({ at: m.index ?? 0, verdict: { kind: "proposed", summary: m[1].trim() } });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at);
  return hits[hits.length - 1].verdict;
}

// ── THE THIRD STATE (W1-T2212), AS A TYPE ────────────────────────────────────
//
// `parseTriageVerdict` already refused to fabricate a verdict on unparseable output (`null`,
// never a fake `TriageVerdict`) — the defect this task removes was one layer down, in
// `decideTriage`, which folded that `null` into `action: "error"`, the SAME action a worker that
// physically misbehaved (touched a non-plan file) also produces. `TriageOutcome` below is the
// discriminated union that makes "unparseable" a state distinct from "produced a verdict" BEFORE
// either ever reaches `decideTriage` — {@link runTriageWithRetry}'s retry branch (design (i)) is
// reachable ONLY from `kind: "unparseable"`, never from `kind: "verdict"` (adverse or not).

export type TriageOutcome = { kind: "verdict"; verdict: TriageVerdict } | { kind: "unparseable" };

/** Classify one worker attempt's raw output text — the third-state boundary {@link
 *  runTriageWithRetry} narrows its retry decision on. Pure wrapper over {@link
 *  parseTriageVerdict}. */
export function classifyTriageOutcome(text: string): TriageOutcome {
  const verdict = parseTriageVerdict(text);
  return verdict === null ? { kind: "unparseable" } : { kind: "verdict", verdict };
}

// ── Deterministic decision (pure) ────────────────────────────────────────────

export interface DecideTriageInput {
  verdict: TriageVerdict | null;
  /** Repo-relative paths the worker itself touched (`git diff --name-only` before the harness's
   * own status write), e.g. from `git -C <worktree> diff --name-only origin/main`. */
  changedFiles: string[];
  /** How many attempts {@link runTriageWithRetry} spent before reaching this call, when driven
   *  through the retry loop (W1-T2212). OPTIONAL and undefined by default — `decideTriage`'s
   *  existing direct caller (run-task.ts's `triageCommand`, still a single call with no retry
   *  loop wired in) passes none, so its `no ALREADY_DECIDED:/...` message stays byte-identical
   *  to before this field existed. When present alongside a null `verdict`, it is folded into
   *  the message so the operator sees HOW MANY attempts the malformed response survived. */
  attempts?: number;
}

export type TriageDecision =
  | { action: "no_task"; status: Extract<FeedbackStatus, "rejected">; detail: string }
  | {
      action: "grill";
      status: Extract<FeedbackStatus, "grilling">;
      detail: string;
      /** The grill's actionable choices — always >= 2, {@link decideTriage} enforces it (the
       * async needs-human issue is the ONLY grill mechanism, W1-T42, and escalate() refuses a
       * bare alert with no options). */
      options: EscalationOption[];
      /** Must exactly match one of `options[].label` — {@link decideTriage} enforces it. */
      recommendation: string;
    }
  | { action: "propose"; status: Extract<FeedbackStatus, "proposed">; detail: string; files: string[] }
  | {
      action: "error";
      reason: string;
      /**
       * THE CAUSE AS DATA, NOT PROSE ALONE (W1-T2212 acceptance criterion 7): three shapes share
       * `action: "error"` for the sole reason that none may ever produce a plan PR, but they are
       * NOT the same failure. `non_plan_files` is a worker that physically misbehaved.
       * `unparseable_verdict` is a worker whose output {@link runTriageWithRetry} could not read
       * after exhausting its bounded retries (never retried further past that bound — the SAME
       * escalation fires as before, design (iii)). `inconsistent_verdict` is a worker that DID
       * answer parseably but contradicted itself against the files it touched (or, for AMBIGUOUS,
       * against its own OPTION/RECOMMENDATION contract). A reader (or a future caller) can now
       * branch on this field instead of pattern-matching `reason`'s prose.
       *
       * OPTIONAL, not required on every `error`: the AMBIGUOUS-with-fewer-than-2-OPTION-lines
       * branch below deliberately omits it — main's pre-existing
       * `decideTriage: a verdict genuinely offering ONE choice twice ... still fails the < 2
       * guard` test (test/triage.test.ts, outside this task's declared scope) asserts that
       * exact shape with `assert.deepEqual`, which fails closed on any extra key. Widening
       * `cause` to that branch too is a genuine follow-up, not a regression — see this PR's
       * Follow-ups.
       */
      cause?: "non_plan_files" | "unparseable_verdict" | "inconsistent_verdict";
    };

/**
 * The three-way verdict as a PURE function (mirrors {@link "./dep-review.js".decideDepReview}):
 * ground truth is what FILES the worker actually touched, cross-checked against its declared
 * verdict — an inconsistency (e.g. claiming ALREADY_DECIDED while also editing plan/tasks.yaml)
 * fails loud rather than silently trusting either signal alone.
 */
export function decideTriage(input: DecideTriageInput): TriageDecision {
  // MASTER-PLAN.md is a plan file BY THE PROMPT'S OWN CONTRACT (the PROPOSED
  // instruction above names "plan/tasks.yaml and/or MASTER-PLAN.md") but lives
  // at the repo root, so a bare `plan/`-prefix filter classified it non-plan
  // and fail-closed every proposal that touched it — first reachable 2026-07-22
  // once #550 let the worker actually edit (feedback 728bc1: "triage worker
  // touched non-plan file(s): MASTER-PLAN.md; leaving no PR"). The guard and
  // the prompt must agree on what "plan file" means.
  const nonPlan = input.changedFiles.filter((f) => !f.startsWith("plan/") && f !== "MASTER-PLAN.md");
  if (nonPlan.length > 0) {
    return {
      action: "error",
      reason: `triage worker touched non-plan file(s): ${nonPlan.join(", ")}`,
      cause: "non_plan_files",
    };
  }
  if (!input.verdict) {
    // THE THIRD STATE'S TERMINAL SHAPE (W1-T2212): reached either directly (a caller with no
    // retry loop, `attempts` undefined — the message stays BYTE-IDENTICAL to before this field
    // existed) or via runTriageWithRetry once its bound is exhausted (`attempts` present) — "at
    // the bound the SAME escalation fires as today, with the same class and the same blocking
    // effect" (design iii). `cause: "unparseable_verdict"` distinguishes this from a worker that
    // physically misbehaved (`non_plan_files`, above) as DATA (acceptance criterion 7), never
    // only as prose a reader has to pattern-match.
    return {
      action: "error",
      reason:
        input.attempts === undefined
          ? "no ALREADY_DECIDED:/AMBIGUOUS:/PROPOSED: verdict line found in the worker's output"
          : `no ALREADY_DECIDED:/AMBIGUOUS:/PROPOSED: verdict line found after ${input.attempts} attempt(s) — ` +
            "the worker's output was unparseable (a MALFORMED RESPONSE), not an adverse verdict",
      cause: "unparseable_verdict",
    };
  }
  if (input.verdict.kind === "already_decided") {
    if (input.changedFiles.length > 0) {
      return {
        action: "error",
        reason: `ALREADY_DECIDED but files were changed: ${input.changedFiles.join(", ")}`,
        cause: "inconsistent_verdict",
      };
    }
    return { action: "no_task", status: "rejected", detail: input.verdict.citation };
  }
  if (input.verdict.kind === "ambiguous") {
    const verdict = input.verdict; // narrowed local — property-access narrowing doesn't survive into a closure below
    if (input.changedFiles.length > 0) {
      return {
        action: "error",
        reason: `AMBIGUOUS but files were changed: ${input.changedFiles.join(", ")}`,
        cause: "inconsistent_verdict",
      };
    }
    // The async needs-human issue is the ONLY grill mechanism (W1-T42, LEARNINGS.md
    // "AskUserQuestion neither works headlessly nor stalls") — an AMBIGUOUS verdict with fewer
    // than 2 OPTION: lines, or a RECOMMENDATION: that doesn't name one of them, is not an
    // actionable escalation; fail loud rather than let escalate() throw deeper in the pipeline
    // (or worse, silently drop the recommendation).
    if (verdict.options.length < 2) {
      // `cause` deliberately omitted here — see the DecideTriageInput.cause doc comment above.
      return {
        action: "error",
        reason: `AMBIGUOUS verdict carries ${verdict.options.length} OPTION: line(s) — a grill needs at least 2 actionable choices`,
      };
    }
    if (!verdict.options.some((o) => o.label === verdict.recommendation)) {
      return {
        action: "error",
        reason: `AMBIGUOUS verdict's RECOMMENDATION (${JSON.stringify(verdict.recommendation)}) does not match any OPTION label (${verdict.options.map((o) => o.label).join(", ")})`,
        cause: "inconsistent_verdict",
      };
    }
    return {
      action: "grill",
      status: "grilling",
      detail: verdict.question,
      options: verdict.options,
      recommendation: verdict.recommendation,
    };
  }
  // proposed
  if (input.changedFiles.length === 0) {
    return { action: "error", reason: "PROPOSED but no plan files were changed", cause: "inconsistent_verdict" };
  }
  return { action: "propose", status: "proposed", detail: input.verdict.summary, files: input.changedFiles };
}

// ── W1-T2212: THE BOUNDED, BYTE-IDENTICAL RETRY (design ii/iii) ──────────────────────────────
//
// "The retry RE-REQUESTS, it never RE-ASKS." `runTriageWithRetry` calls `deps.spawnAttempt` with
// the SAME `prompt` value on every attempt — nothing about the request may vary between them.
// This is deliberately NOT the relint loop (run-task.ts's `runRelintLoop`, which re-prompts the
// worker WITH the prior round's violations folded in — a genuine RE-ASK): that loop exists to
// correct a worker's PLAN LINT violations, a completely different failure mode from "the worker's
// output could not be parsed at all". Reusing it here would smuggle a re-ask in under a retry's
// name — exactly the laundering hazard design (v) warns splitting this task in two would risk.

/** BACKSTOP (W1-T1266): the healthy path — a PARSED verdict, adverse or not — returns on attempt
 *  1, always; this bound fires only once something else has already failed (the worker
 *  repeatedly producing unparseable output), never as the thing that normally stops the loop.
 *  The small, hard bound on unparseable-response retries — mirrors risk-judge.ts's
 *  `RISK_JUDGE_MAX_ATTEMPTS` exactly (design v: the retry contract must be IDENTICAL in both
 *  rungs). Never applies to a PARSED verdict, adverse or not. */
export const TRIAGE_VERDICT_MAX_ATTEMPTS = 3;

/** One triage worker attempt's raw result — the caller's own spawn, never this module's
 *  concern (mirrors risk-judge.ts's injected `spawn`). */
export interface TriageAttemptResult {
  /** The worker's raw concatenated output text, fed to {@link classifyTriageOutcome}. */
  text: string;
  /** Ground truth: what the worker actually touched THIS attempt (fresh per attempt — a retried
   *  worker starts from the same worktree state, so this is re-read, never carried over). */
  changedFiles: string[];
}

export interface TriageRetryDeps {
  /** Spawn ONE triage attempt with the given prompt and return its raw result. Called with the
   *  IDENTICAL `prompt` value on every attempt — see this section's own doc above. */
  spawnAttempt: (prompt: string) => Promise<TriageAttemptResult>;
  /** One ledger-shaped line per attempt (design iii: "each attempt writes its own ledger row so
   *  the count is auditable after the fact rather than inferred"). No-op default. */
  log?: (step: string, extra?: Record<string, unknown>) => void;
}

export interface TriageRetryResult {
  decision: TriageDecision;
  changedFiles: string[];
  /** How many attempts were actually spent — 1 when the first attempt parsed, up to
   *  `maxAttempts` when every attempt was unparseable. */
  attempts: number;
}

/**
 * Spawn up to `maxAttempts` triage attempts with the SAME `prompt`, retrying ONLY while
 * {@link classifyTriageOutcome} reports `unparseable` (design i: the retry branch is reachable
 * ONLY from that arm — never from a parsed verdict, adverse or not, which returns on its very
 * first attempt). At the bound, falls through to {@link decideTriage} with `verdict: null` —
 * the SAME `action: "error"`/`cause: "unparseable_verdict"` outcome a single unparseable
 * response has always produced (design iii: "the SAME escalation fires as today"). An unreadable
 * verdict therefore still blocks and nothing proceeds on it at any point in this loop.
 */
export async function runTriageWithRetry(
  prompt: string,
  deps: TriageRetryDeps,
  maxAttempts: number = TRIAGE_VERDICT_MAX_ATTEMPTS,
): Promise<TriageRetryResult> {
  if (maxAttempts < 1) throw new Error("runTriageWithRetry: maxAttempts must be >= 1");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text, changedFiles } = await deps.spawnAttempt(prompt);
    const outcome = classifyTriageOutcome(text);
    deps.log?.("triage.verdict_attempt", { attempt, max_attempts: maxAttempts, kind: outcome.kind });
    if (outcome.kind === "verdict") {
      return { decision: decideTriage({ verdict: outcome.verdict, changedFiles }), changedFiles, attempts: attempt };
    }
    if (attempt === maxAttempts) {
      return {
        decision: decideTriage({ verdict: null, changedFiles, attempts: attempt }),
        changedFiles,
        attempts: attempt,
      };
    }
  }
  /* c8 ignore next */
  throw new Error("runTriageWithRetry: unreachable — the loop above always returns by its last iteration");
}

// ── Post-hoc deterministic guards (pure, mirroring lib/retro.ts's codeFilesInDiff) ─────────────

/**
 * ID-COLLISION GUARD (the 2026-07-22 W1-T236 triple-mint): the triage worker picks new task ids
 * by reading plan/tasks.yaml, which misses the plan/tasks.d/ shards (W1-T122) — three PRs in one
 * batch each minted W1-T236 while plan/tasks.d/W1-T236-*.yaml already owned it on main, and every
 * plan-loading CI check went red AFTER the PR opened. Load the FULL merged plan (monolith +
 * shards) from the worker's own worktree BEFORE anything is pushed: `loadPlan` throws PlanError
 * naming the duplicate, so a doomed proposal is refused pre-push with the collision named instead
 * of opening a PR that every plan-loading check rejects. (A collision between two OPEN PRs'
 * fragments is still possible — that needs id reservation, tracked separately in feedback.)
 */
export function assertProposedPlanLoads(worktreeRoot: string): void {
  loadPlan(join(worktreeRoot, "plan", "tasks.yaml"));
}



/**
 * Files OUTSIDE `plan/` touched by a unified diff. A triage PR is PLAN-ONLY by construction
 * (`.remudero/skills/feedback.yaml`'s Write-scoped-to-plan design) — this is the same deterministic
 * fail-closed guard `lib/retro.ts`'s `codeFilesInDiff` gives the retro, generalized from
 * "never src/test/" to "never outside plan/" (a triage may legitimately touch MASTER-PLAN.md,
 * which a retro's narrower guard already covers, plus plan/tasks.yaml and plan/feedback/*).
 */
export function nonPlanFilesInDiff(diff: string): string[] {
  // Same "plan file" definition as decideTriage's guard above: this function's
  // own doc already said "a triage may legitimately touch MASTER-PLAN.md" while
  // the filter contradicted it (the 728bc1 fail-close, 2026-07-22).
  return [...diff.matchAll(/^\+\+\+ b\/(\S+)/gm)]
    .map((m) => m[1])
    .filter((f) => !f.startsWith("plan/") && f !== "MASTER-PLAN.md");
}

/** Whether a diff carries the `feedback#<id>` provenance token the PROPOSED contract requires. */
export function diffCitesFeedback(diff: string, feedbackId: string): boolean {
  return diff.includes(`feedback#${feedbackId}`);
}

// ── W1-T963: the empty-diff-triage-merge incident (#2075/#2077/#2078) ───────────────────────────
//
// Three triage PRs for the SAME feedback entry merged and PASSED REVIEW despite changing nothing:
// `gh pr diff`/`nonPlanFilesInDiff` above compare a triage branch against its OWN (frozen,
// fork-point) merge-base, so they stay non-empty even once a SIBLING triage PR for the identical
// entry has already landed the SAME change on `origin/main` — the branch's own history never
// shows that, only a diff against the LIVE default branch tip does. See `diffEmptyAgainstScope`'s
// own doc (lib/review.js) for the structural check; this is the triage-specific SCOPE + DISPOSITION
// wired around it.

/**
 * The declared SCOPE of a `no_task`/`grill` triage decision — the ONE path its entire
 * contribution is: the feedback entry's own status flip. Deliberately NOT used for `propose`
 * (its contribution also includes a NEW plan/tasks.d/ shard, so an empty diff against this
 * narrower scope would never discriminate a genuinely-new proposal from a duplicate one).
 */
export function triageDeclaredScope(feedbackId: string): string[] {
  return [feedbackEntryRepoPath(feedbackId)];
}

/** The terminal outcome a triage merge gate takes once it knows whether the LIVE diff against
 *  {@link triageDeclaredScope} is empty — CLOSE (never merge; design (v): a refusal that leaves
 *  the PR open forever is not the outcome either), or PROCEED to the ordinary review/arm gate. */
export interface TriageEmptyScopeDisposition {
  action: "close" | "proceed";
  /** Present only for `action: "close"` — the `gh pr close --comment` text naming WHY. */
  comment?: string;
}

/**
 * Decide whether to CLOSE this triage PR (its declared scope is empty against the LIVE default
 * branch — a sibling already did the work) or let it PROCEED to the ordinary review/arm gate.
 * Pure: `liveDiffFiles` is the caller's OWN fresh `git diff --name-only origin/main HEAD -- <scope>`
 * read (never this function's concern — a live git read cannot be pure), so this is trivially
 * testable without spawning git at all.
 */
export function triageEmptyScopeDisposition(
  liveDiffFiles: readonly string[],
  scopeFiles: readonly string[],
): TriageEmptyScopeDisposition {
  if (!diffEmptyAgainstScope(liveDiffFiles, scopeFiles)) return { action: "proceed" };
  return {
    action: "close",
    comment:
      `rmd triage: closing, not merging — this PR's diff against the current \`origin/main\` is empty ` +
      `for its declared scope (${scopeFiles.join(", ")}); a sibling triage PR already landed this ` +
      `same change (W1-T963).`,
  };
}

// ── Commit message / PR body authorship (harness-owned, deterministic) ──────────────────────


// ── Commit-BODY line budget (the 2026-07-22 triage-lane commitlint outage) ──────────────────
// `shapeCommitMessage` protects the HEADER (W1-T136), but commitlint also enforces
// body-max-line-length (100) over every body line, and the templates below interpolate LLM
// free text (`decision.detail`) plus 23-char feedback ids — six triage PRs in one batch went
// ci-gate-red on exactly this. Two shapes, two tools: free-standing PROSE lines word-wrap
// across lines; an `Acceptance:` BULLET must stay ONE line (parseAcceptanceBlock ends the
// block at the first non-bullet line, so a wrapped bullet would orphan every later criterion)
// and is therefore truncated with an ellipsis instead. Truncation only trims keyword-floor
// prose — the full detail always appears (wrapped) in the body above the block.

/** commitlint's body-max-line-length bound, mirrored from commitlint.config.mjs. */
export const COMMIT_BODY_MAX_LINE = 100;

/** Word-wrap one prose line to the body budget (never used on Acceptance bullets). */
export function wrapBodyLine(line: string, max: number = COMMIT_BODY_MAX_LINE): string[] {
  if (line.length <= max) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if (cur && (cur + " " + word).length > max) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? cur + " " + word : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Hard-cap an Acceptance bullet to ONE line within the budget (ellipsis, never wrapped). */
export function fitAcceptanceBullet(bullet: string, max: number = COMMIT_BODY_MAX_LINE): string {
  return bullet.length <= max ? bullet : bullet.slice(0, max - 1) + "\u2026";
}

/**
 * The EXECUTABLE proof for a triage outcome: the feedback entry's own status flip, in the house
 * `grep: <pattern> in <path>` dialect {@link "./review.js".parseWhitelistedProof} accepts.
 *
 * WHY THIS EXISTS. Every triage PR used to carry a FIXED ENGLISH PHRASE here \u2014 "feedback yaml flips
 * to rejected", "in-diff provenance; status proposed", "needs-human issue; grilling". They named a
 * true, checkable fact and no parser could read any of them, so EVERY triage PR posted
 * `CAPPED \u2014 0/1 proofs executed`: 25 of the 28 capped verdicts in the two days after the
 * `capped_reason` field was added were this, one per triage fire, now firing every 15 minutes
 * (state/recon-GY-no-dialect-caps.md). It was never an authoring failure \u2014 no model writes this
 * string \u2014 so no prompt could have fixed it.
 *
 * DERIVED FROM `decision.status`, never re-typed: the proof asserts exactly the status
 * `run-task.ts`'s `setFeedbackStatus(worktreePath, feedbackId, decision.status)` writes into the
 * same diff, so the two cannot drift into a proof that greps for a status the harness never wrote.
 *
 * IT DISCRIMINATES. The entry reads `status: new` on the merge base and the flipped value on the
 * head, so the grep MISSES the base \u2014 a pattern matching both is downgraded to `executed_stale`
 * (W1-T273) and would leave the verdict capped exactly as before.
 */
export function triageAcceptanceProof(feedbackId: string, status: FeedbackStatus): string {
  return `grep: status: ${status} in ${feedbackEntryRepoPath(feedbackId)}`;
}

/**
 * One Acceptance criterion as the LABELLED TWO-LINE form (`- claim: \u2026` + an indented `proof: \u2026`),
 * which {@link "./review.js".parseAcceptanceBlock} recognises alongside the single-line
 * `- claim | proof` shape.
 *
 * WHY TWO LINES AND NOT THE ONE-LINER. commitlint's `body-max-line-length` is 100 and is a REQUIRED
 * check ({@link COMMIT_BODY_MAX_LINE}), while a real proof for a long feedback id is already ~90
 * characters on its own \u2014 `grep: status: rejected in plan/feedback/fb-alert-craigoley-remudero-code-scanning-17.yaml`
 * is 89. A single-line bullet carrying both would be ~170 and {@link fitAcceptanceBullet} would
 * elide it \u2014 which is how four of the shipped bodies ended up with a `\u2026` mid-phrase. Splitting the
 * criterion gives the proof a line of its own with room to spare.
 *
 * THE CLAIM IS ELIDED, THE PROOF NEVER IS. Truncating prose costs legibility; truncating a proof
 * costs execution, which is the whole defect this function exists to end. If a feedback id is ever
 * long enough that the PROOF line alone exceeds the budget, that is returned UNTRUNCATED and
 * commitlint will say so loudly \u2014 a caught red beats a silent cap. `test/triage-proof-dialect.test.ts`
 * pins the worst id length that still fits.
 */
export function acceptanceCriterionLines(claim: string, proof: string, max: number = COMMIT_BODY_MAX_LINE): string[] {
  return [fitAcceptanceBullet(`- claim: ${claim}`, max), ` proof: ${proof}`];
}

/**
 * The commit message (and, via `gh pr create --fill`, the PR title+body) the HARNESS authors for
 * a triage outcome — never the LLM, so the `Acceptance:`/`Remudero-Task:` contract can never be
 * skipped or malformed the way a free-text worker report could be. Title line first (conventional
 * commit style, matching this repo's `chore(plan): ...` convention), blank line, then an
 * `Acceptance:` block `rmd review`'s PR-body fallback path parses ({@link
 * "./review.js".parseAcceptanceBlock}) since a synthetic `TRIAGE-<id>` task carries no
 * plan/tasks.yaml entry of its own, then the provenance trailer.
 */
export function triageCommitMessage(opts: {
  decision: Exclude<TriageDecision, { action: "error" }>;
  feedbackId: string;
  taskId: string;
  /** The needs-human issue URL {@link buildGrillEscalation}/`escalate()` opened for a `grill`
   * decision (W1-T42) — undefined only when `decision.action !== "grill"`. */
  grillIssueUrl?: string;
}): string {
  const { decision, feedbackId, taskId, grillIssueUrl } = opts;
  if (decision.action === "no_task") {
    return [
      `chore(triage): feedback#${feedbackId} — already decided, no task`,
      "",
      ...wrapBodyLine(`Grounding found this already answered — adds NO redundant task: ${decision.detail}`),
      "",
      "Acceptance:",
      ...acceptanceCriterionLines(
        `feedback#${feedbackId} already decided, NO task — the entry is closed out, not left open`,
        triageAcceptanceProof(feedbackId, decision.status),
      ),
      "",
      `Remudero-Task: ${taskId}`,
    ].join("\n");
  }
  if (decision.action === "grill") {
    return [
      `chore(triage): feedback#${feedbackId} — ambiguous, parked for the grill`,
      "",
      ...wrapBodyLine(`Open question: ${decision.detail}`),
      "",
      ...wrapBodyLine(
        `Grill (needs-human, ${decision.options.length} options, recommends "${decision.recommendation}"): ${grillIssueUrl ?? "(see run ledger — issue open failed to record here)"}`,
      ),
      "",
      "Acceptance:",
      ...acceptanceCriterionLines(
        `feedback#${feedbackId} grilled: ambiguous, NO task — parked on a needs-human issue`,
        triageAcceptanceProof(feedbackId, decision.status),
      ),
      "",
      `Remudero-Task: ${taskId}`,
    ].join("\n");
  }
  // propose
  // W1-T136 class — see plan-architect.ts: `decision.detail` is LLM free text and can
  // blow commitlint's header-max-length, which reds a REQUIRED check post-push.
  const shapedHeader = shapeCommitMessage(`chore(plan)`, `triage feedback#${feedbackId} — ${decision.detail}`).header;
  return [
    shapedHeader,
    "",
    ...wrapBodyLine(`Proposed by the intake triage (origin: feedback#${feedbackId}): ${decision.detail}`),
    "",
    "Acceptance:",
    ...acceptanceCriterionLines(
      `feedback#${feedbackId} proposal filed — in-diff provenance back to the entry`,
      triageAcceptanceProof(feedbackId, decision.status),
    ),
    "",
    `Remudero-Task: ${taskId}`,
  ].join("\n");
}

// ── THE GRILL: the needs-human escalation payload (W1-T42) ──────────────────────────────────

/**
 * Build the `Escalation` (lib/escalate.ts) for an AMBIGUOUS feedback item — the async
 * needs-human GitHub issue that IS the grill (★ VERIFIED the only viable mechanism: see this
 * module's header doc and LEARNINGS.md "AskUserQuestion neither works headlessly nor stalls").
 * Pure — `run-task.ts`'s `triageCommand` is the only caller that hands this to the real
 * `escalate()`/`ghIssueGateway()` I/O, mirroring how `triageCommitMessage` stays pure while the
 * caller owns git/gh. `class: "GRILL"` reuses escalate.ts's SAME machinery (labels, ledger line,
 * digest-only — no real-time ping) rather than inventing a second one, per this task's directive.
 */
export function buildGrillEscalation(opts: {
  entry: FeedbackEntry;
  decision: Extract<TriageDecision, { action: "grill" }>;
  taskId: string;
  runId: string;
}): Escalation {
  const { entry, decision, taskId, runId } = opts;
  return {
    class: "GRILL",
    taskId,
    runId,
    summary: `feedback#${entry.id} needs a human call: ${decision.detail}`,
    // W1-T2700: this detail becomes a needs-human ISSUE BODY, which later rungs read back into
    // prompts -- so the same outside text makes a round trip and is enveloped on the way out too,
    // not only where it first enters. `decision.detail` is the triage worker's own words.
    detail: [`Feedback:`, envelope(entry.raw, "feedback-entry"), "", `Open question: ${decision.detail}`].join("\n"),
    options: decision.options,
    recommendation: decision.recommendation,
  };
}
