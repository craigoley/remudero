/**
 * test/a-gates-own-remedy-is-reachable.test.ts — W1-T2653.
 *
 * THE DEFECT THIS CLOSES. `scripts/source-size-ratchet.mjs`'s `--baseline --check` mode prints the
 * exact `"path": bucket` line to write on a refusal and states recording it is safe in the SAME
 * PR. Before this task, `fixRungScopeStandDownReason` had no notion of "this gate's own declared
 * remedy" at all — a fix rung had no scoped, testable way to let a strike repairing gate X write
 * the ONE file X itself names, without also (accidentally, via a blanket membership table) making
 * that file writable by a strike repairing something else entirely.
 *
 * THE MECHANISM UNDER TEST, IN THREE PIECES (design notes i/ii/iii):
 *   (i)   `FAST_GATE_STEPS` (lib/ci-parity.ts) gains an OPTIONAL per-entry `remedyFiles` — the
 *         `source-size` entry is the one row this task adds, with its own reason stated in its
 *         own `reason` field (acceptance 5, proved by grep).
 *   (ii)  `remedyFilesForFailingChecks` (lib/ci-parity.ts) answers "which remedy files does a
 *         currently-failing set of checks declare", matched purely by `job` — so a remedy file is
 *         reachable ONLY while the gate that names it is the one actually red (acceptance 3).
 *   (iii) `fixRungScopeStandDownReason` takes that answer as a fourth, explicit parameter
 *         (`reachableRemedyFiles`) and exempts exactly those paths from a NEW out-of-scope
 *         finding — never anything else (acceptance 1/2) — and `renderFixPrompt` tells the worker
 *         the same thing, naming the file AND its gate (acceptance 4).
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH: `REGENERABLE_ARTIFACT_GENERATORS` (lib/sweep.ts) and its
 * existing, unconditional membership-based carve-out (W1-T2650/W1-T2651) are untouched — this
 * mechanism is ADDITIVE, a second, narrower and scoped path to reachability that does not widen or
 * replace the first. `test/a-worker-may-not-apply-the-edit-its-gate-printed.test.ts` (W1-T2651)
 * keeps passing unchanged, which is itself the proof this task adds nothing that regime relies on.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixRungScopeStandDownReason, renderFixPrompt, runFixRung } from "../src/run-task.js";
import { FAST_GATE_STEPS, remedyFilesForFailingChecks } from "../src/lib/ci-parity.js";
import type { ReviewVerdict } from "../src/lib/review.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import type { Mount } from "../src/lib/mounts.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

const REMEDY_PATH = "scripts/source-size-baseline.json";
const ROGUE_PATH = "src/lib/rogue.ts";

function ciEvidence(names: string[]): { ciFailures: Array<{ name: string; logTail: string }> } {
  return { ciFailures: names.map((name) => ({ name, logTail: "boom" })) };
}

// ── shared fixtures for the runFixRung INTEGRATION suite below, at the bottom of this file —
// mirrors test/fix-rung-scope-standdown.test.ts's own conventions (the sibling suite this task's
// mechanism sits beside) so the real dispatch loop, not just the pure functions, is exercised.

function workerResult(over: Partial<WorkerResult> = {}): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 0,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
    childEnvKeys: [],
    model: "default",
    effort: "default",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    modelUsage: {},
    compactionEvents: [],
    qualitySuspect: false,
    ...over,
  };
}

function ciLogInitialReview(headSha = "deadbeef"): ReviewVerdict & { headSha: string; reviewerOutcome: string } {
  return {
    state: "failure",
    criteria: [],
    testTheater: false,
    summary: "sweep-reconstructed: required checks red (1 failing check(s)) — ci-log dispatch",
    floorDegraded: false,
    capped: false,
    keywordOnly: false,
    planOnly: false,
    headSha,
    reviewerOutcome: "sweep-reconstructed-ci-log",
  };
}

const FIX_RUNG_MOUNT: Mount = { model: "sonnet", effort: "medium", maxTurns: 400, contextBudget: 120000 };

function fixRungBaseOpts(task: { id: string; title: string; files?: string[] }) {
  return {
    taskId: task.id,
    runId: `${task.id}-1730000000000`,
    task,
    prUrl: "https://github.com/acme/remudero/pull/2653",
    branch: `run-${task.id}-1730000000000`,
    worktreePath: "/tmp/rmd-gate-remedy-wt",
    initialSessionId: "",
    mount: FIX_RUNG_MOUNT,
    settingsFile: "/tmp/rmd-gate-remedy-settings.json",
    config: {} as Config,
    budgetUsd: 10,
    reviewBase: { owner: "acme", repo: "remudero", headCheckoutDir: "/tmp/rmd-gate-remedy-wt", reviewerMount: FIX_RUNG_MOUNT },
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-gate-remedy-")), "ledger.ndjson");
}

function fakeIssueStore(): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }> } {
  let seq = 900;
  const issues: Array<{ number: number; url: string; title: string; body: string; state: string }> = [];
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      const number = seq++;
      const url = `https://github.com/acme/remudero/issues/${number}`;
      issues.push({ number, url, title, body, state: "open" });
      calls.push({ title, body, labels });
      return url;
    },
    listOpen(): OpenIssue[] {
      return issues.filter((i) => i.state === "open").map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body }));
    },
    comment() {
      // not exercised by these tests
    },
  };
}

/** A `deps.fetchPrDiffFiles` fake that replays a fixed SEQUENCE of diff-file snapshots, one per
 *  call — call 0 is the pre-loop baseline snapshot, mirroring fix-rung-scope-standdown.test.ts's
 *  own `diffFileSequence` helper. */
function diffFileSequence(sequence: string[][]): () => Promise<string[]> {
  let i = 0;
  return async () => sequence[Math.min(i++, sequence.length - 1)];
}

// ── ACCEPTANCE #5 — the pairing is DECLARED in the registry, with its own reason ────────────────

test("acceptance 5: FAST_GATE_STEPS declares remedyFiles for the source-size gate, with the reason stated in that entry", () => {
  const source = fs.readFileSync(new URL("../src/lib/ci-parity.ts", import.meta.url), "utf8");
  assert.match(source, /remedyFiles/, "remedyFiles must be declared in ci-parity.ts");
  const entry = FAST_GATE_STEPS.find((s) => s.job === "source-size");
  assert.ok(entry, "the source-size gate must still be a FAST_GATE_STEPS entry");
  assert.deepEqual(entry?.remedyFiles, [REMEDY_PATH]);
  assert.match(entry?.reason ?? "", /remedy/i, "the entry's OWN reason must state why this file is a declared remedy");
});

test("sanity: no OTHER FAST_GATE_STEPS entry declares remedyFiles — only source-size earns a row in this task", () => {
  const withRemedy = FAST_GATE_STEPS.filter((s) => s.remedyFiles && s.remedyFiles.length > 0);
  assert.deepEqual(
    withRemedy.map((s) => s.job),
    ["source-size"],
  );
});

// ── remedyFilesForFailingChecks — THE SCOPED LOOKUP, matched by job ─────────────────────────────

test("remedyFilesForFailingChecks: the failing check naming the gate returns that gate's declared remedy file(s)", () => {
  assert.deepEqual(remedyFilesForFailingChecks(["source-size"]), [REMEDY_PATH]);
});

test("remedyFilesForFailingChecks: a DIFFERENT failing check returns nothing — the lookup is scoped to which gate is actually red", () => {
  assert.deepEqual(remedyFilesForFailingChecks(["jscpd"]), []);
  assert.deepEqual(remedyFilesForFailingChecks([]), []);
});

test("remedyFilesForFailingChecks: pure over an injected step table — never requires production FAST_GATE_STEPS", () => {
  const steps = [
    { job: "alpha", remedyFiles: ["a.json"] },
    { job: "beta", remedyFiles: undefined },
    { job: "gamma", remedyFiles: ["c1.json", "c2.json"] },
  ];
  assert.deepEqual(remedyFilesForFailingChecks(["alpha", "gamma"], steps), ["a.json", "c1.json", "c2.json"]);
  assert.deepEqual(remedyFilesForFailingChecks(["beta"], steps), []);
});

// ── ACCEPTANCE #1 — a strike may write the DECLARED remedy of a gate it is repairing ────────────

test("acceptance 1: fixRungScopeStandDownReason does not stand the rung down over a path THIS round's reachable remedy names", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, REMEDY_PATH];
  const reachable = remedyFilesForFailingChecks(["source-size"]);
  assert.equal(fixRungScopeStandDownReason(current, baseline, declared, reachable), undefined);
});

// ── ACCEPTANCE #2 — a path that is NOT a declared remedy still stands the rung down ─────────────

test("acceptance 2: a genuinely unrelated out-of-scope path still stands the rung down with today's reason, remedy exemption or not", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, ROGUE_PATH];
  const reachable = remedyFilesForFailingChecks(["source-size"]);
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got, "an unrelated path must still stand the rung down");
  assert.deepEqual(got?.newOutOfScopePaths, [ROGUE_PATH]);
  assert.match(got?.reason ?? "", /outside the declared scope/);
});

test("acceptance 2: the remedy exemption is ONE named file, not a widening — a second, non-remedy path alongside it still stands down", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, REMEDY_PATH, ROGUE_PATH];
  const reachable = remedyFilesForFailingChecks(["source-size"]);
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got, "the rogue path must still stand the rung down even though the remedy path is exempt");
  assert.deepEqual(got?.newOutOfScopePaths, [ROGUE_PATH]);
});

test("acceptance 2: omitting reachableRemedyFiles entirely (every pre-existing call site) preserves today's behavior byte-for-byte", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, ROGUE_PATH];
  const withDefault = fixRungScopeStandDownReason(current, baseline, declared);
  const withEmpty = fixRungScopeStandDownReason(current, baseline, declared, []);
  assert.deepEqual(withDefault, withEmpty);
});

test("acceptance 2: a plan-only task's rung still stands down over the remedy path — the remedy exemption is never wired into plan scope", () => {
  const declared = ["plan/tasks.d/foo.yaml"];
  const baseline = [...declared];
  const current = [...declared, REMEDY_PATH];
  const reachable = remedyFilesForFailingChecks(["source-size"]);
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got, "a plan-only task's rung must stand down even for a remedy path — it is not plan-scoped");
  assert.deepEqual(got?.newOutOfScopePaths, [REMEDY_PATH]);
  assert.equal(got?.scopeKind, "plan");
});

// ── ACCEPTANCE #3 — SCOPED TO THE REPAIR: wrong failing check earns no exemption ────────────────
//
// `REMEDY_PATH` (`scripts/source-size-baseline.json`) is ALSO a member of the pre-existing,
// unconditional `REGENERABLE_ARTIFACT_GENERATORS` registry (W1-T2650/W1-T2651, lib/sweep.ts —
// untouched by and out of declared scope for this task), so it is already exempt from
// `outOfDeclaredScopeFiles`/`scopeGuardOutOfScopeFiles` REGARDLESS of `reachableRemedyFiles` —
// that pre-existing grant is deliberately additive-only and never narrowed here (see the file
// header). To observe THIS task's own scoping property in isolation from that other, wider grant,
// these tests use a path that is declared ONLY through a synthetic `FAST_GATE_STEPS`-shaped step
// table (via `remedyFilesForFailingChecks`'s injectable `steps` param) and is NOT a
// `REGENERABLE_ARTIFACT_GENERATORS` member at all.

const SYNTHETIC_REMEDY_PATH = "src/lib/hypothetical-remedy-target.ts";
const SYNTHETIC_STEPS = [{ job: "synthetic-gate", remedyFiles: [SYNTHETIC_REMEDY_PATH] }];

test("sanity: the synthetic remedy path used below carries no pre-existing REGENERABLE_ARTIFACT_GENERATORS grant", async () => {
  const { REGENERABLE_ARTIFACT_GENERATORS } = await import("../src/lib/sweep.js");
  assert.ok(!Object.hasOwn(REGENERABLE_ARTIFACT_GENERATORS, SYNTHETIC_REMEDY_PATH));
});

test("acceptance 3: a strike addressing a DIFFERENT failing check (not the one declaring this remedy file) gets no exemption and stands down", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, SYNTHETIC_REMEDY_PATH];
  // The failing check this strike is addressing is "some-other-gate", not "synthetic-gate" — it
  // declares no remedyFiles, so the lookup returns nothing and the exemption never applies.
  const reachable = remedyFilesForFailingChecks(["some-other-gate"], SYNTHETIC_STEPS);
  assert.deepEqual(reachable, []);
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got, "the remedy file must NOT be exempt when the failing check this strike addresses doesn't declare it");
  assert.deepEqual(got?.newOutOfScopePaths, [SYNTHETIC_REMEDY_PATH]);
});

test("acceptance 3: no failing checks at all (e.g. a non-ci-log round) reaches an empty reachable set, so the remedy path still stands down", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, SYNTHETIC_REMEDY_PATH];
  const reachable = remedyFilesForFailingChecks([], SYNTHETIC_STEPS);
  const got = fixRungScopeStandDownReason(current, baseline, declared, reachable);
  assert.ok(got);
  assert.deepEqual(got?.newOutOfScopePaths, [SYNTHETIC_REMEDY_PATH]);
});

test("acceptance 3, positive control: the failing check that DOES declare the synthetic remedy file IS exempt — proves the guard isn't simply always refusing", () => {
  const declared = ["src/lib/worker.ts"];
  const baseline = [...declared];
  const current = [...declared, SYNTHETIC_REMEDY_PATH];
  const reachable = remedyFilesForFailingChecks(["synthetic-gate"], SYNTHETIC_STEPS);
  assert.deepEqual(reachable, [SYNTHETIC_REMEDY_PATH]);
  assert.equal(fixRungScopeStandDownReason(current, baseline, declared, reachable), undefined);
});

// ── ACCEPTANCE #4 — the fix prompt names the reachable remedy file AND its gate ─────────────────

test("acceptance 4: renderFixPrompt names the reachable remedy file and its declaring gate when that gate is currently failing", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["src/lib/worker.ts"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence(["source-size"]) });
  assert.match(prompt, /GATE REMEDY/);
  assert.match(prompt, /source-size/);
  assert.match(prompt, new RegExp(REMEDY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(prompt, /MAY commit it alongside the declared scope/);
  assert.match(prompt, /will NOT stand down/);
});

test("acceptance 4: renderFixPrompt names NO gate remedy when the currently-failing check does not declare one", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["src/lib/worker.ts"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence(["jscpd"]) });
  assert.doesNotMatch(prompt, /GATE REMEDY/);
});

test("acceptance 4: a plan-only task's prompt renders no GATE REMEDY clause — that regime never consults FAST_GATE_STEPS remedies either", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["plan/tasks.d/foo.yaml"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence(["source-size"]) });
  assert.doesNotMatch(prompt, /GATE REMEDY/);
});

test("acceptance 4: instruction and enforcement agree — the SAME reachableRemedyFiles the prompt names is what the pre-strike guard exempts", () => {
  const task = { id: "W1-T2653X", title: "some task", files: ["src/lib/worker.ts"] };
  const prompt = renderFixPrompt({ task, round: 1, branch: "run-W1-T2653X-1", evidence: ciEvidence(["source-size"]) });
  assert.match(prompt, new RegExp(REMEDY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const declared = task.files;
  const baseline = [...declared];
  const current = [...declared, REMEDY_PATH];
  const reachable = remedyFilesForFailingChecks(["source-size"]);
  assert.equal(
    fixRungScopeStandDownReason(current, baseline, declared, reachable),
    undefined,
    "a path the prompt just told the worker it MAY commit must never stand the rung down",
  );
});

// ── INTEGRATION: the real `runFixRung` dispatch loop, at the actual enforcement point ───────────
//
// Everything above proves the pure functions and `renderFixPrompt` in isolation. This section
// proves the SAME property through the real orchestration loop `runFixRung` — the "enforcement
// point" claim 1 names, and the exact seam five real tasks' fix rungs deadlocked at (rationale,
// W1-T2485/W1-T2490/W1-T2497/W1-T2503/W1-T2504): round 1 dispatches a real fix worker whose
// commit adds the source-size gate's own declared remedy file while THAT gate is still the one
// failing; round 2's pre-strike scope gate — the code path at `rung.scope` inside `runFixRung`,
// never a hand-called `fixRungScopeStandDownReason` — must NOT stand down over it, and instead
// spends its own second strike normally, exactly like a repair confined to declared scope would.

// NOTE on the falsifier below: `scripts/source-size-baseline.json` is ALSO a member of the
// pre-existing, unconditional `REGENERABLE_ARTIFACT_GENERATORS` registry (W1-T2650/W1-T2651),
// so it is ALREADY exempt from the real `runFixRung` scope gate regardless of which check this
// round addresses — that grant is deliberately untouched (see the file header). A "wrong check"
// falsifier for THIS file specifically is therefore not observable through the real end-to-end
// loop (it IS observable, and proved, at the pure-function level: `remedyFilesForFailingChecks`
// and `fixRungScopeStandDownReason`'s own "acceptance 3" tests above, using a step table the
// production registry does not already cover). What real `runFixRung` integration CAN prove
// end-to-end — and what the second test below does — is that the exemption is still exactly ONE
// named file: a genuinely unrelated rogue path is still stood down even while the source-size
// gate's own remedy is reachable in the very same round.

test("runFixRung (integration, acceptance 1): a ci-log round-1 commit adding the source-size gate's OWN remedy file does not stand round 2's rung down — the deadlock is gone at the real enforcement point", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];
  let waitCalls = 0;

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2653Y", title: "fix the source-size ceiling", files: ["src/lib/worker.ts"] }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "source-size", logTail: "source-size-ratchet: BLOCKED -- 1 source file(s) grew" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return workerResult({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      // Round 1's push leaves `source-size` red (the worker's first attempt didn't land yet) —
      // `fetchCiFailures` refreshes round 2's evidence to the SAME still-failing check, so
      // `currentCiFailures` still names `source-size` at round 2's own pre-strike gate, exactly
      // the live condition `reachableRemedyFiles` is scoped to. Round 2's push clears CI, ending
      // the loop at exactly two strikes.
      waitForCiGreen: async () => {
        waitCalls++;
        return waitCalls === 1 ? "red" : "green";
      },
      fetchCiFailures: async () => [{ name: "source-size", logTail: "source-size-ratchet: BLOCKED -- 1 source file(s) grew" }],
      runReview: async () => ({
        ...ciLogInitialReview("sha-2"),
        state: "success",
        criteria: [{ claim: "source-size ceiling recorded", met: true, proof: "npm run source-size-signal", reason: "", proof_exec: "executed_pass" }],
      }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      // Call 0: pre-loop baseline (declared file only). Call 1: round 1's own pre-strike check —
      // unchanged, a structural no-op. Call 2: round 2's pre-strike check — observes round 1's
      // OWN commit having added the gate's declared remedy file. Call 3+: unchanged thereafter.
      fetchPrDiffFiles: diffFileSequence([
        ["src/lib/worker.ts"],
        ["src/lib/worker.ts"],
        ["src/lib/worker.ts", REMEDY_PATH],
      ]),
    },
  });

  assert.equal(spawnCalls.length, 2, "BOTH strikes dispatch — round 2 is never stood down over the gate's own remedy file");
  assert.equal(outcome.outcome, "fixed");
  assert.equal(outcome.strikes, 2);
  assert.equal(outcome.standDownReason, undefined, "the scope gate never fires for this repair");

  // Acceptance 4, tied to the SAME real dispatch: round 1's actual prompt — the one really sent
  // to the worker, not a hand-built call — already named the reachable remedy file and its gate
  // alongside the declared scope, so instruction (round 1's prompt) and enforcement (round 2's
  // guard, just proved above) agree on the identical file.
  assert.match(spawnCalls[0].prompt, /GATE REMEDY/);
  assert.match(spawnCalls[0].prompt, /source-size/);
  assert.match(spawnCalls[0].prompt, /scripts\/source-size-baseline\.json/);
  assert.match(spawnCalls[0].prompt, /DECLARED SCOPE/);
  assert.match(spawnCalls[0].prompt, /src\/lib\/worker\.ts/);
});

test("runFixRung (integration, falsifier): a genuinely unrelated rogue path still stands round 2's rung down even while the source-size remedy is reachable THIS same round", async () => {
  const spawnCalls: SpawnWorkerArgs[] = [];

  const outcome = await runFixRung({
    ...fixRungBaseOpts({ id: "W1-T2653Z", title: "fix the source-size ceiling", files: ["src/lib/worker.ts"] }),
    strikeCap: 3,
    initialReview: ciLogInitialReview(),
    ciFailures: [{ name: "source-size", logTail: "source-size-ratchet: BLOCKED -- 1 source file(s) grew" }],
    deps: {
      spawn: async (args) => {
        spawnCalls.push(args);
        return workerResult({ sessionId: `fix-session-${spawnCalls.length}` });
      },
      waitForCiGreen: async () => "red",
      fetchCiFailures: async () => [{ name: "source-size", logTail: "source-size-ratchet: BLOCKED -- 1 source file(s) grew" }],
      runReview: async () => ({ ...ciLogInitialReview("sha-1") }),
      push: () => {},
      issues: fakeIssueStore(),
      ledgerPath: tmpLedgerPath(),
      log: () => {},
      say: () => {},
      account: (r) => r,
      // Round 1's own commit adds a genuinely unrelated rogue path — NOT the source-size gate's
      // declared remedy — alongside the declared file.
      fetchPrDiffFiles: diffFileSequence([
        ["src/lib/worker.ts"],
        ["src/lib/worker.ts"],
        ["src/lib/worker.ts", ROGUE_PATH],
      ]),
    },
  });

  assert.equal(spawnCalls.length, 1, "round 2 never dispatches — the rung stood down first");
  assert.equal(outcome.outcome, "stood_down");
  assert.match(outcome.standDownReason ?? "", new RegExp(ROGUE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(
    outcome.standDownReason ?? "",
    /source-size-baseline/,
    "the exemption is ONE named file — it must not silently swallow an unrelated path too",
  );
});
