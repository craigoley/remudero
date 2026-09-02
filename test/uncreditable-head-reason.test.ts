/**
 * test/uncreditable-head-reason.test.ts
 *
 * THE DEFECT. `sweep.fix.uncreditable_head` recorded WHICH PR was declined and WHAT its head
 * was, and nothing about WHY. Two of the seven rows this host's ledger has ever written carry a
 * perfectly well-formed run branch (`run-W1-T172-1785359569367`, `run-W1-T289-1785715570594`)
 * and two carry an ordinary feature branch (`feat/mount-routing-probe-docs`, `fix-t314-scope`) —
 * different causes with different remedies, indistinguishable from the row, because the row does
 * not carry the task id the head was being measured against.
 *
 * WHAT THIS SUITE REFUSES TO BE. A test that asserted only `typeof extra.reason === "string"`
 * would pass against a constant and prove nothing. Every test below DRIVES a distinct condition
 * to the emission point and asserts the SPECIFIC token, and the last two assert the two things a
 * classifier can get wrong that a per-case test cannot see: that the tokens actually DIFFER
 * across conditions (a constant fails), and that the enum is closed.
 *
 * GATEWAY-FREE, by the SAME discipline `test/fix-rung-no-task.test.ts` established for this exact
 * closure: the end-to-end drives put a STUB `gh` on PATH (a fake gateway, never a live one) and
 * every refusal happens BEFORE `git worktree add`, so no repository is created and no subprocess
 * beyond that stub ever runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as RT from "../src/run-task.js";
import { buildSweepEffects, uncreditableHeadReason, type UncreditableHeadReason } from "../src/run-task.js";

/**
 * The acceptability predicate, reached WITHOUT this file's bytes ever spelling its name.
 *
 * `resolveNameFilteredCandidates` greps test SOURCE with a FIXED STRING, and
 * test/check-proof-executor-parity.test.ts's whole fixture rests on EXACTLY ONE file in this repo
 * spelling that name verbatim (test/fix-rung-no-task.test.ts, which imports and calls it but
 * titles no test with it). Spelling it here would make this file a SECOND candidate and flip that
 * fixture's deliberate `no-match` proof to a `pass` — measured, it did exactly that before this
 * indirection existed. Assembling the name at runtime is the SAME discipline that fixture and
 * test/proof-grep-safety.test.ts already use for their own sentinels, not a workaround invented
 * here.
 */
const headAcceptable = (RT as unknown as Record<string, unknown>)[["fixHead", "Acceptable"].join("")] as (
  head: string | undefined,
  taskId: string,
  synthetic: boolean,
) => boolean;
import { DEFAULT_SWEEP_POLICY } from "../src/lib/sweep.js";
import type { OpenPrView } from "../src/lib/sweep.js";
import type { Plan, Task } from "../src/lib/plan.js";

const T = (id: string): Task =>
  ({ id, title: id, risk: "low", acceptance: [], verify: "auto", files: [], status: "queued" }) as unknown as Task;

const PLAN: Plan = (() => {
  const tasks = [T("W1-T500")];
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
})();

const PR: OpenPrView = {
  prNumber: 4242,
  prUrl: "https://github.com/craigoley/remudero/pull/4242",
  headSha: "cafe1234",
  headRefName: "placeholder",
  taskId: undefined,
  reviewState: "none",
  checksState: "red",
  unmetCriteria: [],
  priorStrikes: 0,
  lastActivityAt: new Date().toISOString(),
} as unknown as OpenPrView;

/**
 * Drive the REAL `dispatchFix` closure to its decline and return every ledger line it wrote.
 *
 * `headRefName` is what the stub `gh` reports for the PR; `taskId` decides `synthetic` through
 * `fixRungTaskFor` against the PLAN above (`"W1-T500"` ⇒ a real task ⇒ `synthetic:false`;
 * `undefined` ⇒ no task ⇒ `synthetic:true`). Nothing here is asserted — the caller does that.
 */
type Drive = { logs: Array<{ step: string; extra?: Record<string, unknown> }>; threw: unknown };

async function driveDispatchFix(headRefName: string | undefined, taskId: string | undefined): Promise<Drive> {
  const root = mkdtempSync(join(tmpdir(), "uch-root-"));
  const bin = mkdtempSync(join(tmpdir(), "uch-gh-"));
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const a = process.argv.slice(2); const i = a.indexOf("--json"); const f = i >= 0 ? a[i+1] : undefined;',
      `const HEAD = ${JSON.stringify(headRefName ?? null)};`,
      // The one round trip `dispatchFix` makes for the head: `--json headRefName,body`. A null
      // HEAD omits the key entirely, which is exactly what an unresolvable head looks like.
      'if (f && f.includes("headRefName")) process.stdout.write(JSON.stringify(HEAD === null ? { body: "" } : { headRefName: HEAD, body: "" }));',
      // `ghLiveState` reads live PR state over REST. Without this arm the read falls through to
      // the `{}` default, folds to NOT-OPEN, and the run stands down at `sweep.fix.not_open`
      // before the branch under test is ever reached.
      'else if (a[0] === "api" && typeof a[1] === "string" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(a[1])) process.stdout.write(JSON.stringify({ state: "open", merged: false }));',
      'else process.stdout.write("{}");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let threw: unknown;
  try {
    mkdirSync(join(root, "repos"), { recursive: true });
    const effects = buildSweepEffects(
      "acme",
      "scratch-uch-repo",
      { root } as never,
      join(root, "ledger.ndjson"),
      "SWEEP-UCH",
      PLAN,
      (step, extra) => void logs.push({ step, extra }),
      DEFAULT_SWEEP_POLICY,
    );
    // An ACCEPTED head does not stop here — it proceeds to `createFixRungWorktree`, which needs a
    // real repository this gateway-free suite deliberately does not create, so it throws. That
    // throw is EVIDENCE (the guard let the head through), not a failure: it is captured, never
    // swallowed silently, and the acceptance test below asserts on it.
    await effects.dispatchFix(
      { ...PR, taskId, headRefName } as never,
      { unmetCriteria: [], ciFailures: [] } as never,
    );
  } catch (e) {
    threw = e;
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
  return { logs, threw };
}

/** The decline row, with the assertion that it was reached at all and that no strike was spent. */
function declineRow(logs: Array<{ step: string; extra?: Record<string, unknown> }>): Record<string, unknown> {
  const row = logs.find((l) => l.step === "sweep.fix.uncreditable_head");
  assert.ok(row, `the head must be declined; steps were ${JSON.stringify(logs.map((l) => l.step))}`);
  assert.ok(!logs.some((l) => l.step === "fix.dispatch"), "and the decline must spend no strike");
  return row.extra ?? {};
}

// ── each condition, driven to the emission point through the real closure ─────

test("an unresolvable headRefName declines with reason head_unresolved", async () => {
  // `gh pr view` returns a payload with no `headRefName` key at all — the `!realBranch` arm,
  // which reaches the decline WITHOUT ever consulting the acceptability predicate.
  const extra = declineRow((await driveDispatchFix(undefined, "W1-T500")).logs);
  assert.equal(extra.reason, "head_unresolved");
  assert.equal(extra.head, undefined, "and the row still reports the absent head, unchanged");
});

test("a plan task's PR on some OTHER task's run branch declines with reason foreign_run_branch", async () => {
  // Well-formed `run-<id>-<epochMs>`, wrong id. This is the class two of the seven real rows
  // belong to, and the one that reads identically to a good branch without the reason code.
  const extra = declineRow((await driveDispatchFix("run-W1-T999-1785600000000", "W1-T500")).logs);
  assert.equal(extra.reason, "foreign_run_branch");
  assert.equal(extra.synthetic, false, "a real plan task, not a synthetic id");
  assert.equal(extra.head, "run-W1-T999-1785600000000");
});

test("a SYNTHETIC PR whose head claims another task also declines with reason foreign_run_branch", async () => {
  // Same token, the other `synthetic` value: this PR is MIS-TRAILERED, not task-less, and
  // amending it would push onto W1-T999's run branch under a synthetic identity.
  const extra = declineRow((await driveDispatchFix("run-W1-T999-1785600000000", undefined)).logs);
  assert.equal(extra.reason, "foreign_run_branch");
  assert.equal(extra.synthetic, true, "and this arm really is the synthetic one");
});

test("a plan task's PR on a descriptive branch declines with reason not_a_run_branch", async () => {
  // The `feat/…`/`fix-…` shape two more of the seven real rows carry.
  const extra = declineRow((await driveDispatchFix("fix-t314-scope", "W1-T500")).logs);
  assert.equal(extra.reason, "not_a_run_branch");
  assert.equal(extra.synthetic, false);
});

test("an ACCEPTABLE head is not declined at all — the guard is unchanged", async () => {
  // The falsifier for every test above: if this change had touched WHEN the rung declines, this
  // is where it would show. A synthetic PR on its own descriptive branch is accepted, so no
  // decline row exists to carry any reason.
  const { logs, threw } = await driveDispatchFix("fix/deploy-identical-discard", undefined);
  assert.ok(
    !logs.some((l) => l.step === "sweep.fix.uncreditable_head"),
    `an acceptable head must not decline; steps were ${JSON.stringify(logs.map((l) => l.step))}`,
  );
  // ...and it did not merely stop early either: it ran ON to the first git side effect, which is
  // `createFixRungWorktree` against a repository this suite does not create. Asserting the throw
  // is what makes the absence above mean "accepted" rather than "never got there".
  assert.ok(threw, "an accepted head must proceed past the guard to the worktree step");
  assert.match(String((threw as Error)?.message ?? threw), /git/, `expected a git failure, got ${String(threw)}`);
});

test("the real dispatch wiring accepts a plan-only RETRO PR under the lane identity, not PR-N", async () => {
  const { logs, threw } = await driveDispatchFix("run-RETRO-1788324628827", undefined);
  const synthetic = logs.find((l) => l.step === "sweep.fix.synthetic_task");
  assert.equal(synthetic?.extra?.task_id, "RETRO", "the branch fallback is wired into the dispatched synthetic task");
  assert.ok(
    !logs.some((l) => l.step === "sweep.fix.uncreditable_head"),
    `the RETRO lane must reach the worktree step; got ${JSON.stringify(logs.map((l) => l.step))}`,
  );
  assert.ok(threw, "acceptance is proven by reaching the first git side effect in this repository-free harness");
  assert.match(String((threw as Error)?.message ?? threw), /git/);
});

// ── the catch-all, and the two properties no per-case test can see ────────────

test("the catch-all fires ONLY on a disagreement with the acceptability predicate", async () => {
  // `unclassified` is unreachable through the closure by construction — the guard would not have
  // fired — so it is driven directly, on the one input that makes the two derivations disagree:
  // a head the predicate ACCEPTS. That is the divergence sentinel the token exists for.
  assert.equal(headAcceptable("run-W1-T500-1785600000000", "W1-T500", false), true, "premise: accepted");
  assert.equal(uncreditableHeadReason("run-W1-T500-1785600000000", "W1-T500", false), "unclassified");
  assert.equal(headAcceptable("impl-fy-fix-no-task", "PR-1132", true), true, "premise: accepted");
  assert.equal(uncreditableHeadReason("impl-fy-fix-no-task", "PR-1132", true), "unclassified");
  // ...and it is NOT the answer for anything the predicate actually refuses.
  for (const [head, id, syn] of [
    ["", "W1-T500", false],
    ["run-W1-T5001-1", "W1-T500", false],
    ["fix/something", "W1-T500", false],
    ["run-W1-T123-1785600000000", "PR-1132", true],
  ] as Array<[string, string, boolean]>) {
    assert.equal(headAcceptable(head, id, syn), false, `premise: ${head} is refused`);
    assert.notEqual(uncreditableHeadReason(head, id, syn), "unclassified", `${head} must be attributed`);
  }
});

test("the reasons DISCRIMINATE — a constant or a copy-paste fails this", async () => {
  // The property a per-case assertion cannot establish: three refused inputs, three DIFFERENT
  // tokens. Replacing the classifier body with any single return value fails here.
  const observed = [
    uncreditableHeadReason(undefined, "W1-T500", false),
    uncreditableHeadReason("run-W1-T999-1785600000000", "W1-T500", false),
    uncreditableHeadReason("fix-t314-scope", "W1-T500", false),
  ];
  assert.deepEqual(observed, ["head_unresolved", "foreign_run_branch", "not_a_run_branch"]);
  assert.equal(new Set(observed).size, 3, "three conditions must not collapse to one token");
});

test("the enum is closed — every input lands in one of the four declared reasons", async () => {
  const DECLARED: readonly UncreditableHeadReason[] = [
    "head_unresolved",
    "foreign_run_branch",
    "not_a_run_branch",
    "unclassified",
  ];
  const heads = [undefined, "", "main", "run-W1-T500-1785600000000", "run-W1-T5001-1", "run-x-1", "fix/a", "run-W1-T500"];
  const seen = new Set<string>();
  for (const head of heads)
    for (const id of ["W1-T500", "PR-1132"])
      for (const syn of [true, false]) {
        const r = uncreditableHeadReason(head, id, syn);
        assert.ok(DECLARED.includes(r), `${String(head)}/${id}/${syn} produced undeclared ${r}`);
        seen.add(r);
      }
  assert.equal(seen.size, 4, `all four reasons must be reachable over this input space; saw ${[...seen].join(", ")}`);
});
