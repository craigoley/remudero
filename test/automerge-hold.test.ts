import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSweep, type OpenPrView, type SweepDeps } from "../src/lib/sweep.js";
import { automergeHoldFromLedger } from "../src/lib/review.js";
import { armAutoMergeAtOpen, armOutcomeReason, buildSweepEffects, realArmDeps } from "../src/run-task.js";
import { readLedgerLines } from "../src/lib/status.js";
import { captureFeedback } from "../src/lib/feedback.js";
import { LANDING_BRANCH } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

// ── W1-T1000002 ───────────────────────────────────────────────────────────────────────────
//
// THE DEFECT: an operator merge hold expressed as a bare `disarmAutoMerge` call flickers —
// `alreadyDone` for `disposition: "mergeable"` reads ONLY GitHub's live `autoMergeArmed` bit
// and the sweep's own sha-keyed `prior.armed` memory (priorActionsFromLedger), neither of
// which a disarm changes durably. The very next pass re-derives the SAME "checks green,
// review success" disposition, finds nothing recorded against it, and arms it again — the
// EXACT shape W1-T970 already measured live for a risk-judge refusal (PR 2033: disarmed at
// 06:27:03Z, re-armed at 06:30:00Z, three minutes later).
//
// THE FIX (mirrors W1-T970's own remedy, mirrored again from `cappedOverrideFromLedger`):
// a ledgered, operator-written hold (`automerge.hold_engaged`/`automerge.hold_released`,
// review.ts's `automergeHoldFromLedger`) consulted in `alreadyDone` — refused, never armed,
// `acted:false`, no dedup key seeded — PLUS a converging disarm for anything already armed
// when the hold was observed, PLUS a gate at the one shared arm-completion (`attemptArm`,
// run-task.ts) so a PR opened WHILE the hold stands is never armed at open in the first
// place. UNLIKE the risk-judge refusal, this is deliberately NEVER sha-keyed — a hold binds
// the PR (or the fleet), not any one head, so an ordinary push must never silently lift it.
// ─────────────────────────────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-08-21T12:00:00Z");
const RECENT = "2026-08-21T11:00:00Z";
const HEAD = "d00dfeed";
const OTHER_HEAD = "beefcafe";
const PR_NUMBER = 800;
const TASK = "W1-T800";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-automerge-hold-")), "ledger.ndjson");
}

/** The exact shape the `mergeable` row matches: required checks green, review success. */
function greenPr(over: Partial<OpenPrView> = {}): OpenPrView {
  return {
    prNumber: PR_NUMBER,
    prUrl: `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`,
    taskId: TASK,
    reviewState: "success",
    checksState: "green",
    unmetCriteria: [],
    priorStrikes: 0,
    lastActivityAt: RECENT,
    headSha: HEAD,
    autoMergeArmed: false,
    ...over,
  };
}

/** One `automerge.hold_engaged` ledger line, exactly as an operator verb would write it. */
function holdEngagedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-08-21T11:55:00.000Z",
    run_id: "OPERATOR-1",
    task_id: TASK,
    step: "automerge.hold_engaged",
    by: "craig",
    reason: "freezing this PR pending a manual read",
    pr_number: PR_NUMBER,
    ...over,
  };
}

/** One `automerge.hold_released` ledger line. */
function holdReleasedLine(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: "2026-08-21T11:58:00.000Z",
    run_id: "OPERATOR-1",
    task_id: TASK,
    step: "automerge.hold_released",
    by: "craig",
    reason: "read complete — clear to arm",
    pr_number: PR_NUMBER,
    ...over,
  };
}

/** A recording fake for every injected sweep effect. */
function fakeDeps(
  lines: Array<Record<string, unknown>>,
  overrides: Partial<SweepDeps> = {},
): SweepDeps & { armed: OpenPrView[] } {
  const armed: OpenPrView[] = [];
  return {
    armed,
    arm: (p) => {
      armed.push(p);
    },
    close: () => {},
    dispatchFix: () => {},
    escalate: () => {},
    ledgerPath: ledgerPath(),
    runId: "SWEEP-AUTOMERGE-HOLD",
    now: () => NOW,
    readLedger: () => lines,
    ...overrides,
  };
}

// ── review.ts: automergeHoldFromLedger — the pure reader, unit-tested in isolation first ───

test("automergeHoldFromLedger: no rows at all reads as no hold", () => {
  assert.equal(automergeHoldFromLedger([], PR_NUMBER), undefined);
});

test("automergeHoldFromLedger: an engage row with a by/reason is read back verbatim", () => {
  const hold = automergeHoldFromLedger([holdEngagedLine()], PR_NUMBER);
  assert.deepEqual(hold, { by: "craig", reason: "freezing this PR pending a manual read" });
});

test("automergeHoldFromLedger: a hold is PR-scoped by default — a DIFFERENT PR number sees nothing", () => {
  assert.equal(automergeHoldFromLedger([holdEngagedLine()], 999), undefined);
});

test("automergeHoldFromLedger: a FLEET-scoped row (no pr_number) applies to every PR", () => {
  const fleetHold = { ...holdEngagedLine(), pr_number: undefined };
  assert.deepEqual(automergeHoldFromLedger([fleetHold], 1), { by: "craig", reason: "freezing this PR pending a manual read" });
  assert.deepEqual(automergeHoldFromLedger([fleetHold], 999999), { by: "craig", reason: "freezing this PR pending a manual read" });
});

test("automergeHoldFromLedger: an engage row missing `by` or `reason` is never honoured", () => {
  assert.equal(automergeHoldFromLedger([{ ...holdEngagedLine(), by: undefined }], PR_NUMBER), undefined);
  assert.equal(automergeHoldFromLedger([{ ...holdEngagedLine(), reason: "" }], PR_NUMBER), undefined);
});

// ── Acceptance 1: a held PR is not armed, and the pass records the refusal ─────────────────

test("a held pull request is not armed by a later sweep pass, and the pass records the refusal rather than acting", async () => {
  const deps = fakeDeps([holdEngagedLine()]);
  const summary = await runSweep([greenPr()], deps);

  assert.deepEqual(deps.armed, [], "deps.arm must never fire while an operator hold stands");
  assert.equal(summary.byDisposition.mergeable, 1, "the DISPOSITION is untouched — only the ACTION stands down");
  assert.equal(summary.actionsTaken, 0);
  assert.equal(summary.actions[0].acted, false);

  const disposed = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "sweep.disposed");
  assert.equal(disposed.length, 1, "the one-ledger-line-per-PR invariant still holds");
  assert.equal(disposed[0].acted, false, "the pass records the refusal, never a silent skip");
});

// ── Acceptance 2: an already-armed PR has its arm withdrawn on the pass that observes it ───

test("an open pull request already armed when the hold is engaged has that arm withdrawn on the pass that observes it", async () => {
  const withdrawn: Array<{ pr: OpenPrView; holdBy: string }> = [];
  const deps = fakeDeps([holdEngagedLine()], {
    disarmAutoMerge: (pr, hold) => {
      withdrawn.push({ pr, holdBy: hold.by });
    },
  });

  await runSweep([greenPr({ autoMergeArmed: true })], deps);

  assert.equal(withdrawn.length, 1, "the sweep must issue exactly one withdrawal for this PR this pass");
  assert.equal(withdrawn[0].pr.prNumber, PR_NUMBER);
  assert.equal(withdrawn[0].holdBy, "craig", "the withdrawal is attributed to the hold's own author");

  const withdrawalLines = readLedgerLines(deps.ledgerPath).filter((l) => l.step === "automerge.hold_withdrawal");
  assert.equal(withdrawalLines.length, 1);
  assert.equal(withdrawalLines[0].pr_number, PR_NUMBER);
  assert.equal(withdrawalLines[0].hold_by, "craig");
});

test("an ALREADY-unarmed PR under a hold issues NO withdrawal — the converging disarm never probes what is not armed", async () => {
  const withdrawn: OpenPrView[] = [];
  const deps = fakeDeps([holdEngagedLine()], {
    disarmAutoMerge: (pr) => {
      withdrawn.push(pr);
    },
  });

  await runSweep([greenPr({ autoMergeArmed: false })], deps);
  assert.deepEqual(withdrawn, [], "nothing is armed, so nothing needs withdrawing");
});

// ── Acceptance 3: a PR opened while the hold stands is never armed at open (no race) ───────

test("a pull request opened while the hold stands is never armed at open, so the withdrawal is not racing the merge", () => {
  const said: string[] = [];
  let armAutoCalled = false;
  const outcome = armAutoMergeAtOpen(`https://github.com/craigoley/remudero/pull/${PR_NUMBER}`, {
    armAuto: () => {
      armAutoCalled = true;
    },
    mergeDirect: () => {},
    say: (m) => {
      said.push(m);
    },
    ledgerLines: () => [holdEngagedLine()],
  });

  assert.equal(outcome, "hold-refused");
  assert.equal(armAutoCalled, false, "GitHub must never be told to auto-merge a held PR, even at open");
  assert.ok(said.some((m) => m.includes("hold_refused") && m.includes("craig")), "the refusal is attributed, not silent");
});

test("armAutoMergeAtOpen still arms normally with NO ledgerLines dep at all — fail-open, unchanged for every pre-existing caller", () => {
  let armedUrl: string | undefined;
  const outcome = armAutoMergeAtOpen(`https://github.com/craigoley/remudero/pull/${PR_NUMBER}`, {
    armAuto: (u) => {
      armedUrl = u;
    },
    mergeDirect: () => {},
    say: () => {},
  });
  assert.equal(outcome, "armed");
  assert.equal(armedUrl, `https://github.com/craigoley/remudero/pull/${PR_NUMBER}`);
});

// ── Acceptance 4: a push does NOT lift the hold — only an explicit release does ────────────

test("a push to a held pull request does not lift the hold, and only an explicit release does", async () => {
  // The SAME PR, pushed to a NEW head — unlike the sha-keyed risk-judge refusal, a hold is
  // never sha-bound (design (ii)), so this must still refuse.
  const deps = fakeDeps([holdEngagedLine()]);
  const summary = await runSweep([greenPr({ headSha: OTHER_HEAD })], deps);

  assert.deepEqual(deps.armed, [], "a push must never silently lift an operator hold");
  assert.equal(summary.actions[0].acted, false);
});

// ── Acceptance 5: after a release, the backlog re-arms next pass — no separate resume path ─

test("after a release the eligible backlog re-arms on the next pass with no separate resume path", async () => {
  const lines: Array<Record<string, unknown>> = [holdEngagedLine()];
  const deps = fakeDeps(lines);

  await runSweep([greenPr()], deps);
  // `[] as OpenPrView[]`, not a bare `[]`: node's `deepStrictEqual<T>(actual, expected): asserts
  // actual is T` NARROWS `deps.armed` to the expected type for the rest of this scope, so a bare
  // literal pins it to `never[]` and the re-arm assertion below fails to compile.
  assert.deepEqual(deps.armed, [] as OpenPrView[], "sanity: the hold refuses the first pass");

  // An explicit release row — nothing else changes about the PR or the caller.
  lines.push(holdReleasedLine());
  await runSweep([greenPr()], deps);

  assert.deepEqual(
    deps.armed.map((p) => p.prNumber),
    [PR_NUMBER],
    "the SAME runSweep call, over the SAME ledger reader, re-derives and arms whole — no " +
      "resume walker, no second mechanism",
  );
});

// ── Acceptance 6: feedback-landing's inline arm honours the same hold reader ───────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

/** A bare "origin" remote, seeded with one commit on `main` — no network involved anywhere. */
function makeBareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "rmd-automerge-hold-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { encoding: "utf8", env: GIT_ENV });

  const seed = mkdtempSync(join(tmpdir(), "rmd-automerge-hold-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A real clone of `bareOrigin` — the "operator checkout" `captureFeedback` writes into. */
function cloneRoot(bareOrigin: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-automerge-hold-root-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, dir], { encoding: "utf8", env: GIT_ENV });
  return dir;
}

/** A fake `gh` — no real GitHub call anywhere; tracks every invocation for assertions. */
function fakeGh(prUrl: string) {
  const calls: string[][] = [];
  let createCount = 0;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return createCount > 0 ? JSON.stringify([{ url: prUrl }]) : JSON.stringify([]);
    }
    if (args[0] === "pr" && args[1] === "create") {
      createCount++;
      return `Creating pull request for ${LANDING_BRANCH} into main in o/r\n${prUrl}\n`;
    }
    if (args[0] === "pr" && args[1] === "merge") {
      return "";
    }
    throw new Error(`unexpected gh call in test fixture: ${JSON.stringify(args)}`);
  };
  return { gh, calls, createCount: () => createCount };
}

test("a landing call that arms auto-merge inline honours the same hold reader as the shared arm path, when a hold stands over that PR", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const prUrl = "https://github.com/o/r/pull/42";
  const { gh, calls } = fakeGh(prUrl);

  withLiveWritesAllowed(() =>
    captureFeedback(root, {
      raw: "an entry landed while a fleet-wide hold stands",
      origin: "cli",
      land: {
        gh,
        // A FLEET-scoped hold (no pr_number) — this call's PR number is not known in
        // advance (gh mints it), so a fleet-wide hold is the shape a real operator freeze
        // would take here.
        ledgerLines: () => [{ step: "automerge.hold_engaged", by: "craig", reason: "fleet freeze" }],
      },
    }),
  );

  assert.ok(
    calls.some((c) => c[0] === "pr" && c[1] === "create"),
    "the PR is still opened — a hold refuses ARMING, never the landing itself",
  );
  assert.ok(
    !calls.some((c) => c[0] === "pr" && c[1] === "merge"),
    "the SAME hold that refuses the shared arm path must refuse this inline `gh pr merge --auto` too",
  );
});

test("a landing call with NO ledgerLines dep at all still arms — fail-open, unchanged for every pre-existing caller/fixture", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const prUrl = "https://github.com/o/r/pull/43";
  const { gh, calls } = fakeGh(prUrl);

  withLiveWritesAllowed(() =>
    captureFeedback(root, { raw: "an ordinary entry, no hold in play", origin: "cli", land: { gh } }),
  );

  assert.ok(calls.some((c) => c[0] === "pr" && c[1] === "merge"), "no ledgerLines dep means no hold is ever visible — arms as before this task");
});

// ── The three arms the hold adds that no fixture above reaches ───────────────────────────────
//
// Each is a branch a real hold takes and a test never did: the `[]`-on-failure contract that
// keeps arming alive on a host with no resolvable config, the phrase the refusal reports, and
// the converging withdrawal's own call site. `diff-coverage` named all three.

test("realArmDeps: a config that cannot be resolved yields NO ledger lines rather than throwing", () => {
  const deps = realArmDeps(() => {
    throw new Error("loadConfig: `which claude` found nothing — the CI trap");
  });
  // THE CONTRACT: arming must survive a host that cannot resolve a config. `attemptArm` calls
  // this thunk on EVERY arm, so a throw here would turn arming into a crash — and a host with
  // no config has no hold ledger to honour in the first place, so `[]` is the honest answer.
  assert.deepEqual(deps.ledgerLines(), [], "a failed config read is an empty ledger, never a throw");
  // PAIRED POSITIVE CONTROL: the same seam with a working loader returns an ARRAY from the real
  // reader, so the `[]` above is the catch arm firing and not a thunk that can only ever be empty.
  const real = realArmDeps();
  assert.ok(Array.isArray(real.ledgerLines()), "the default loader still produces a real read");
});

test("armOutcomeReason: a hold refusal names the hold and says only a release lifts it", () => {
  const reason = armOutcomeReason("hold-refused", "verdict is a full PASS");
  assert.match(reason, /operator merge hold/i, "the ledger row names WHAT refused, not just that something did");
  assert.match(reason, /only an explicit release lifts it/i, "and names the ONE thing that lifts it — never a retry, never a push");
  // PAIRED POSITIVE CONTROL: the SAME decision reason under a different outcome reads
  // differently, so the assertions above are not satisfied by a switch returning one string.
  assert.notEqual(armOutcomeReason("armed", "verdict is a full PASS"), reason);
  assert.equal(armOutcomeReason("armed", "verdict is a full PASS"), "verdict is a full PASS");
});

test("the sweep's converging withdrawal calls the disarm leaf with the held PR's own url", () => {
  const disarmed: string[] = [];
  // `disarmImpl` is the 21st parameter — the LAST, per this function's own append-only
  // convention — so every dep between `log` and it is defaulted here rather than restated.
  const effects = buildSweepEffects(
    "craigoley",
    "remudero",
    { root: "/nonexistent-for-this-fixture" } as never,
    "/nonexistent-for-this-fixture/ledger.ndjson",
    "RUN-hold-withdrawal",
    { tasks: [], byId: new Map() },
    () => {},
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (prUrl: string) => void disarmed.push(prUrl),
  );
  effects.disarmAutoMerge?.(
    { prUrl: "https://github.com/craigoley/remudero/pull/2376" } as never,
    { by: "craig", reason: "holding for review" } as never,
  );
  assert.deepEqual(
    disarmed,
    ["https://github.com/craigoley/remudero/pull/2376"],
    "the adapter passes the PR's OWN url through to the leaf — never a rebuilt or defaulted one",
  );
});
