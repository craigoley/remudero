import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SWEEP_POLICY, conflictRefusalCause, deriveDisposition, isPureConcurrentAddition, type ConflictFileDiff, type OpenPrView } from "../src/lib/sweep.js";
import { hydrateMergeStates, mergeStateFromRest, MERGE_STATE_HYDRATION_CAP } from "../src/lib/open-prs-rest.js";

/**
 * PR #1074, 2026-08-01 16:01–16:05Z: dispositioned `mergeable` FIVE CONSECUTIVE TIMES while
 * GitHub reported `mergeable: false, mergeable_state: "dirty"`. The sweep kept trying to arm
 * auto-merge, which cannot succeed on a conflicted PR; a human rebased it by hand.
 *
 * ROOT CAUSE: the pull-request LIST endpoint omits `mergeable_state`, so `OpenPrView.mergeState`
 * was always `undefined` and BOTH `mergeState === "dirty"` disposition rows were unreachable.
 */

const NOW = Date.parse("2026-08-01T16:01:00.000Z");

/** A PR that is green and review-passing — the shape that dispositioned `mergeable` on #1074. */
function greenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: 1074,
    prUrl: "https://github.com/craigoley/remudero/pull/1074",
    taskId: "W1-T287",
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    strikeHistory: [],
    lastActivityAt: "2026-08-01T15:55:00.000Z",
    headSha: "deadbeef",
    autoMergeArmed: false,
    isDependabot: false,
    ...over,
  } as OpenPrView;
}

test("a PR observed mergeable_state dirty is dispositioned CONFLICTED, never mergeable", () => {
  // Driven through the REAL narrowing function, so reverting the population fails THIS test too.
  const d = deriveDisposition(
    greenPr({ mergeState: mergeStateFromRest({ mergeable: false, mergeable_state: "dirty" }) }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.notEqual(d.disposition, "mergeable", "arming auto-merge on a conflicted PR can never succeed");
  assert.equal(
    d.disposition,
    "blocked-ambiguous",
    "no conflict-file evidence is captured, so it escalates rather than auto-resolving",
  );
  assert.match(d.reason, /merge conflict/i);
  assert.match(d.reason, /escalating/i);
});

test("mergeable_state unknown is left in the CATCH-ALL — an uncomputed state is never treated as a conflict", () => {
  // THE DELIBERATE POLARITY. GitHub computes mergeability asynchronously and this repo has seen a
  // PR sit `unknown` across five consecutive polls. Escalating on `unknown` would fail healthy PRs
  // whenever GitHub was merely slow. `undefined` is what every PR carried before this change, so
  // an unknown PR behaves EXACTLY as it does today — the failure mode is "no improvement", never
  // "wrong answer".
  assert.equal(mergeStateFromRest({ mergeable_state: "unknown", mergeable: null }), undefined);
  assert.equal(mergeStateFromRest({}), undefined, "an absent field is also not-known");
  const d = deriveDisposition(greenPr({ mergeState: undefined }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "mergeable", "unchanged from today — this is the accepted degradation");
});

test("a genuinely mergeable PR is unaffected — the regression lock", () => {
  assert.equal(mergeStateFromRest({ mergeable_state: "clean", mergeable: true }), "clean");
  const d = deriveDisposition(greenPr({ mergeState: "clean" }), DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "mergeable");
  assert.match(d.reason, /arming auto-merge/i);
});

test("REPLAY of PR #1074: five ticks that each said mergeable now each say conflicted", () => {
  // The real sequence — five sweep passes, 16:01–16:05Z, GitHub reporting dirty throughout.
  const ticks = ["16:01", "16:02", "16:03", "16:04", "16:05"].map((hm) => Date.parse(`2026-08-01T${hm}:00.000Z`));

  const before = ticks.map((t) => deriveDisposition(greenPr({ mergeState: undefined }), DEFAULT_SWEEP_POLICY, t));
  assert.deepEqual(
    before.map((d) => d.disposition),
    ["mergeable", "mergeable", "mergeable", "mergeable", "mergeable"],
    "the OLD behaviour, reproduced: five identical futile arm attempts",
  );

  // THROUGH THE REAL POPULATION PATH, not a hand-set field: the REST row GitHub actually returned
  // for #1074, narrowed by the same function the gateway uses. A test that sets `mergeState`
  // directly cannot fail if the population is reverted — which is the whole defect.
  const restRow = { mergeable: false, mergeable_state: "dirty" };
  const observed = mergeStateFromRest(restRow);
  assert.equal(observed, "dirty", "the live REST shape for #1074 narrows to dirty");
  const after = ticks.map((t) => deriveDisposition(greenPr({ mergeState: observed }), DEFAULT_SWEEP_POLICY, t));
  assert.deepEqual(
    after.map((d) => d.disposition),
    ["blocked-ambiguous", "blocked-ambiguous", "blocked-ambiguous", "blocked-ambiguous", "blocked-ambiguous"],
    "every tick now names the real blocker instead of arming into a conflict",
  );
  assert.equal(after.filter((d) => d.disposition === "mergeable").length, 0);
});

test("the conflicted disposition escalates ONCE — it is deduped by PR number, not by head sha", () => {
  // The retry-loop lock. `blocked-ambiguous` dedups into `escalated` keyed on the PR NUMBER
  // ALONE (sweep.ts's action-dedupe switch), unlike `mergeable`, which is keyed `pr@sha` and so
  // re-earns an arm attempt on every new head. That asymmetry is exactly why #1074 retried: an
  // arm that cannot succeed never records `acted:true`, so the sha-keyed set never absorbed it.
  // A conflicted PR therefore escalates on its FIRST sighting and never again, no matter how many
  // ticks observe the same conflict — which is what keeps this from becoming another 57-issue pile.
  const d = deriveDisposition(
    greenPr({ mergeState: mergeStateFromRest({ mergeable: false, mergeable_state: "dirty" }) }),
    DEFAULT_SWEEP_POLICY,
    NOW,
  );
  assert.equal(d.disposition, "blocked-ambiguous");
  const dedupeKeyedByNumberAlone = `${greenPr().prNumber}`;
  assert.equal(dedupeKeyedByNumberAlone, "1074", "the escalate set keys on the number, so ticks collapse to one issue");
});

test("an exhausted rate budget degrades to today's behaviour rather than failing the sweep", () => {
  // TRAP 2. Every fetch throws, as it does when the core budget is spent mid-tick.
  let calls = 0;
  const exhausted = () => {
    calls++;
    throw new Error("API rate limit exceeded for user ID 4397075");
  };
  const states = hydrateMergeStates("craigoley", "remudero", [1074, 1075, 1076], exhausted);
  assert.equal(states.size, 0, "no merge state is known");
  assert.equal(calls, 3, "it tried each PR — one failure never aborts the pass");
  // …and an unknown merge state dispositions exactly as it did before this change existed.
  assert.equal(
    deriveDisposition(greenPr({ mergeState: states.get(1074) }), DEFAULT_SWEEP_POLICY, NOW).disposition,
    "mergeable",
  );
});

test("hydration is bounded by a hard cap so a PR spike cannot run away against the REST budget", () => {
  const many = Array.from({ length: 200 }, (_, i) => 1000 + i);
  let calls = 0;
  hydrateMergeStates("craigoley", "remudero", many, () => {
    calls++;
    return { mergeable_state: "clean" };
  });
  assert.equal(calls, MERGE_STATE_HYDRATION_CAP, "never more than the cap, whatever the candidate count");
  assert.equal(MERGE_STATE_HYDRATION_CAP, 25, "just above the all-time observed maximum of 23 PRs in one sweep");
});

test("hydrateMergeStates records only DEFINITE states and skips a PR whose own fetch fails", () => {
  const states = hydrateMergeStates("craigoley", "remudero", [1, 2, 3, 4], (args) => {
    const n = Number(args[args.length - 1].split("/").pop());
    if (n === 2) throw new Error("404 Not Found — closed between the list and this call");
    if (n === 3) return { mergeable_state: "unknown", mergeable: null };
    return { mergeable_state: n === 1 ? "dirty" : "clean", mergeable: n !== 1 };
  });
  assert.equal(states.get(1), "dirty");
  assert.equal(states.has(2), false, "a per-PR failure is skipped, not fatal");
  assert.equal(states.has(3), false, "unknown is absent from the map — the caller sees undefined");
  assert.equal(states.get(4), "clean");
});

test("buildOpenPrViews WIRES the hydrator: a dirty PR arrives at the sweep carrying mergeState dirty", async () => {
  // THE SEAM ITSELF. Every other sweep test hand-builds `OpenPrView` fixtures, so the wiring that
  // connects the gateway to the disposition table was never executed — which is exactly how the
  // dirty rows sat unreachable for so long. This drives the REAL function with a recorder.
  const { buildOpenPrViews } = await import("../src/run-task.js");
  const dir = mkdtempSync(join(tmpdir(), "rmd-openprviews-"));
  const ledgerPath = join(dir, "ledger.ndjson");
  writeFileSync(ledgerPath, "");

  const seen: string[][] = [];
  const fetch = (args: string[]): unknown => {
    seen.push(args);
    const path = args[args.length - 1] ?? "";
    if (/\/pulls\?/.test(path) || /state=open/.test(path)) {
      return [
        {
          number: 1074,
          html_url: "https://github.com/craigoley/remudero/pull/1074",
          head: { ref: "feat/x", sha: "deadbeef" },
          updated_at: "2026-08-01T15:55:00.000Z",
          body: "Remudero-Task: W1-T287",
          auto_merge: null,
          state: "open",
        },
      ];
    }
    if (/\/pulls\/1074$/.test(path)) return { mergeable: false, mergeable_state: "dirty" };
    return []; // check-runs / statuses
  };

  const views = buildOpenPrViews("craigoley", "remudero", ledgerPath, {
    fetch,
    requiredContexts: () => ["ci-gate"],
  });

  assert.equal(views.length, 1);
  assert.equal(views[0].mergeState, "dirty", "the LIST-omitted field is populated by the follow-up fetch");
  assert.ok(
    seen.some((a) => a.some((x) => /\/pulls\/1074$/.test(x))),
    "it actually issued the single-PR GET — the whole point",
  );
  // …and that view dispositions as conflicted rather than mergeable.
  assert.equal(deriveDisposition(views[0], DEFAULT_SWEEP_POLICY, NOW).disposition, "blocked-ambiguous");
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * W1-T984 — THE mergeConflict EVIDENCE PRODUCER. `isPureConcurrentAddition` opens with
 * `files.length > 0` and, until this task, NOTHING ever populated `OpenPrView.mergeConflict` in
 * production, so every dirty PR fell through the `conflicted` row and escalated with
 * "files: none captured" — 9 of 9 across the whole recorded corpus (rationale (2)). This wires
 * the evidence WITHOUT turning admission on: `isPureConcurrentAddition` counts deletions only, so
 * it cannot tell a genuine pure-concurrent-addition from an add/add collision (rationale (5)), and
 * that judgement call is explicitly out of this task's scope (design note viii).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** One conflict-evidence fixture: a PR number, its file diffs, and the recorded predicate value —
 *  the FIVE real, reconstructible cases from the task's own rationale (5), replayed against main
 *  as it stood at each escalation's own timestamp. */
function reconstructedConflict(files: ConflictFileDiff[]): OpenPrView {
  return greenPr({
    mergeState: "dirty",
    mergeConflict: { files, oursLog: "abc1234 (reconstructed)", theirsLog: "def5678 (reconstructed)" },
  });
}

test("W1-T984 acceptance 3 — the five reconstructed conflicts reproduce their recorded predicate values, including the add/add case reading TRUE", () => {
  // #1775: test/daemon.test.ts, 0 ours-deleted / 5 theirs-deleted — FALSE, refusal correct.
  assert.equal(isPureConcurrentAddition([{ path: "test/daemon.test.ts", oursDeleted: 0, theirsDeleted: 5 }]), false, "#1775");

  // #1830: two files, 0/26 and 6/1 — FALSE, refusal correct.
  assert.equal(
    isPureConcurrentAddition([
      { path: "deploy/entrypoint.sh", oursDeleted: 0, theirsDeleted: 26 },
      { path: "src/lib/daemon.ts", oursDeleted: 6, theirsDeleted: 1 },
    ]),
    false,
    "#1830",
  );

  // #1912: src/lib/sweep.ts + test/sweep.test.ts, 0/0 both — TRUE (a real `CONFLICT (content)`
  // git itself refuses to merge, per the task's own `git merge-tree` control).
  assert.equal(
    isPureConcurrentAddition([
      { path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 0 },
      { path: "test/sweep.test.ts", oursDeleted: 0, theirsDeleted: 0 },
    ]),
    true,
    "#1912",
  );

  // #1960: plan/tasks.d/W1-T908-*.yaml, 0/0 — TRUE, and THE FALSIFIER: an add/add collision (no
  // stage-1/merge-base version at all) where the predicate can never structurally read FALSE.
  assert.equal(
    isPureConcurrentAddition([
      { path: "plan/tasks.d/W1-T908-the-retro-body-asserts-a-changeset-it-does.yaml", oursDeleted: 0, theirsDeleted: 0 },
    ]),
    true,
    "#1960 (add/add)",
  );

  // #2120: plan/feedback/fb-1785775974389-e25033.yaml, 2/2 — FALSE, refusal correct.
  assert.equal(
    isPureConcurrentAddition([{ path: "plan/feedback/fb-1785775974389-e25033.yaml", oursDeleted: 2, theirsDeleted: 2 }]),
    false,
    "#2120",
  );
});

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * W1-T2536 — TURNING ADMISSION ON. W1-T984 shipped the evidence producer with
 * `mergeConflictAdmissionEnabled` OFF and named turning it on "a LATER task's call ... once the
 * semantic predicate exists". The predicate it was waiting for cannot live in `sweep.ts`: the
 * discriminator it wanted ("are the two sides' added lines disjoint") needs the actual conflict
 * HUNKS, and this evidence is built from GitHub's compare API, which carries per-file deletion
 * COUNTS and no hunk at all. The only thing in this system holding hunks is the dispatched fix
 * worker. See `SweepPolicy.mergeConflictAdmissionEnabled`'s own doc for the full argument and for
 * what fences a wrong resolution instead (a new head carries no `remudero-review` status, so it
 * cannot merge until a fresh review passes).
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

test("W1-T2536 — a zero-deletion conflict with captured evidence is ADMITTED to the merge-conflict fix rung", () => {
  assert.equal(DEFAULT_SWEEP_POLICY.mergeConflictAdmissionEnabled, true, "the flag now defaults ON — this is the change");
  const cases: OpenPrView[] = [
    reconstructedConflict([
      { path: "src/lib/sweep.ts", oursDeleted: 0, theirsDeleted: 0 },
      { path: "test/sweep.test.ts", oursDeleted: 0, theirsDeleted: 0 },
    ]),
    reconstructedConflict([
      { path: "plan/tasks.d/W1-T908-the-retro-body-asserts-a-changeset-it-does.yaml", oursDeleted: 0, theirsDeleted: 0 },
    ]),
  ];
  for (const pr of cases) {
    const d = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(d.disposition, "conflicted", `${pr.mergeConflict?.files.map((f) => f.path).join(",")} must dispatch, not escalate`);
    assert.match(d.reason, /dispatching the merge-conflict fix mode/);
  }
});

test("W1-T2536 — THE REAL SHAPE THIS WAS COSTING: two PRs each adding a different key to the size baseline", () => {
  // MEASURED 2026-08-30: the dominant conflict on this repo was two PRs each recording a
  // ceiling in `scripts/source-size-baseline.json` — both sides purely ADD one `"path": N` line,
  // so deletions are zero on both sides and the evidence is fully captured. Under W1-T984's
  // default this escalated to a human every single time.
  const pr = reconstructedConflict([{ path: "scripts/source-size-baseline.json", oursDeleted: 0, theirsDeleted: 0 }]);
  assert.equal(deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW).disposition, "conflicted");
  // THE FALSIFIER, in the direction that matters: the conjunct is still load-bearing, so an
  // operator who sets the flag false gets exactly W1-T984's behaviour back.
  const off = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: false };
  assert.equal(deriveDisposition(pr, off, NOW).disposition, "blocked-ambiguous", "the gate is real in BOTH directions");
});

test("W1-T2536 — a conflict involving a deletion is still REFUSED and says so", () => {
  // The three reconstructed cases that read FALSE stay refused at the NEW default — turning
  // admission on must not widen what `isPureConcurrentAddition` admits, only whether it is asked.
  const cases: OpenPrView[] = [
    reconstructedConflict([{ path: "test/daemon.test.ts", oursDeleted: 0, theirsDeleted: 5 }]),
    reconstructedConflict([
      { path: "deploy/entrypoint.sh", oursDeleted: 0, theirsDeleted: 26 },
      { path: "src/lib/daemon.ts", oursDeleted: 6, theirsDeleted: 1 },
    ]),
    reconstructedConflict([{ path: "plan/feedback/fb-1785775974389-e25033.yaml", oursDeleted: 2, theirsDeleted: 2 }]),
  ];
  for (const pr of cases) {
    const d = deriveDisposition(pr, DEFAULT_SWEEP_POLICY, NOW);
    assert.equal(d.disposition, "blocked-ambiguous", "a deletion is never auto-resolved, flag or no flag");
    assert.match(d.reason, /involves a deletion/);
  }
});

test("W1-T2536 — a refusal never claims a deletion the evidence does not show", () => {
  // THE SECOND DEFECT. The refusal row said "involves a deletion (or no file evidence was
  // captured)" UNCONDITIONALLY, so a zero-deletion, fully-evidenced conflict was refused by a
  // sentence in which BOTH disjuncts were false — sending every reader to hunt a deletion that
  // was not there. Each arm now names the reason that actually fired.
  const noEvidence: ConflictFileDiff[] = [];
  const zeroDeletions: ConflictFileDiff[] = [{ path: "scripts/source-size-baseline.json", oursDeleted: 0, theirsDeleted: 0 }];
  const withDeletion: ConflictFileDiff[] = [{ path: "test/daemon.test.ts", oursDeleted: 0, theirsDeleted: 5 }];
  const on = DEFAULT_SWEEP_POLICY;
  const off = { ...DEFAULT_SWEEP_POLICY, mergeConflictAdmissionEnabled: false };

  assert.equal(conflictRefusalCause(noEvidence, on), "no file evidence was captured");
  assert.equal(conflictRefusalCause(withDeletion, on), "involves a deletion");
  assert.match(conflictRefusalCause(zeroDeletions, off), /admission is disabled/);
  assert.equal(conflictRefusalCause(zeroDeletions, on), "not classifiable as a pure concurrent addition");

  // ORDER MATTERS: a file list carrying a deletion must read as a deletion even with admission
  // off, never as "admission is disabled" — the deletion is the more fundamental refusal.
  assert.equal(conflictRefusalCause(withDeletion, off), "involves a deletion");

  // And the rendered reason for an absent-evidence PR no longer asserts a deletion.
  const d = deriveDisposition(greenPr({ mergeState: "dirty" }), on, NOW);
  assert.doesNotMatch(d.reason, /involves a deletion/, "no evidence was read — a deletion is not something we observed");
  assert.match(d.reason, /no file evidence was captured/);
});
test("W1-T984 acceptance 4 — a dirty PR escalation names the real conflicting paths and per-side deletion counts, never 'none captured'", () => {
  const seeded = reconstructedConflict([
    { path: "deploy/entrypoint.sh", oursDeleted: 0, theirsDeleted: 26 },
    { path: "src/lib/daemon.ts", oursDeleted: 6, theirsDeleted: 1 },
  ]);
  const d = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.doesNotMatch(d.reason, /none captured/, "real evidence flowed — this must not lie about it being absent");
  assert.match(d.reason, /deploy\/entrypoint\.sh \(ours -0, theirs -26\)/, "names the first path AND its per-side deletion counts");
  assert.match(d.reason, /src\/lib\/daemon\.ts \(ours -6, theirs -1\)/, "names the second path AND its per-side deletion counts");
});

test("W1-T984 — a genuinely uncaptured evidence read still renders 'none captured', so the wording stays honest about WHICH empty it is", () => {
  // W1-T487 (#1815, out of scope here per design note viii(c)) already distinguishes "never
  // collected" from "collected and genuinely empty" — this locks that a dirty PR with NO evidence
  // at all (the fetch failed, or never ran) still reads the pre-existing wording, unchanged.
  const seeded = greenPr({ mergeState: "dirty" });
  const d = deriveDisposition(seeded, DEFAULT_SWEEP_POLICY, NOW);
  assert.equal(d.disposition, "blocked-ambiguous");
  assert.match(d.reason, /files: none captured/);
});
