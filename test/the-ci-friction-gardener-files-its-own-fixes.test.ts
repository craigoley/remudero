/**
 * W1-T4435: the fleet prices its own slowest gate. A ci-friction gardener (a gardener.ts spec)
 * prices every extra-head cause in PR MINUTES — never fire count, the module's own falsifier — and
 * drafts a parked task for the costliest cause nothing already tracks.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { runGarden, type GardenCheckout } from "../src/lib/gardener.js";
import {
  CI_FRICTION_GARDEN_CLASSES,
  CI_FRICTION_GARDEN_LOG,
  CI_FRICTION_REMEDIES_FILE,
  ciFrictionCauseKey,
  ciFrictionGardenSpec,
  ciFrictionOrigin,
  ciFrictionRecordVerdict,
  ciFrictionRoundsFromLedger,
  ciFrictionShardYaml,
  costliestUntrackedCause,
  priceCiFrictionCauses,
  runPrIndex,
  type CiFrictionGardenerDeps,
} from "../src/lib/ci-friction-gardener.js";
import type { GateFireRateReport } from "../src/lib/gate-fire-rate.js";
import type { LedgerRecord } from "../src/lib/retro.js";
import { gitRepo } from "./helpers/git-repo.js";

test("W1-T4435: the gardener prices each cause in PR minutes", () => {
  // A FREQUENT, CHEAP check: ten one-minute rounds against pull request 1's `pr.opened`.
  const cheapRounds: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-cheap", pr_url: "https://github.com/acme/remudero/pull/1", ts: "2026-09-24T00:00:00.000Z" },
  ];
  for (let i = 0; i < 10; i++) {
    const mm = String(i + 1).padStart(2, "0");
    cheapRounds.push({ step: "fix.dispatch", run_id: "run-cheap", mode: "reviewer-unmet", round: i + 1, ts: `2026-09-24T00:${mm}:00.000Z` });
  }
  // A RARE, EXPENSIVE round: one merge conflict costing 25 minutes on pull request 2.
  const expensiveRound: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-rare", pr_url: "https://github.com/acme/remudero/pull/2", ts: "2026-09-24T01:00:00.000Z" },
    { step: "fix.dispatch", run_id: "run-rare", mode: "merge-conflict", round: 1, ts: "2026-09-24T01:25:00.000Z" },
  ];
  const rounds = ciFrictionRoundsFromLedger([...cheapRounds, ...expensiveRound]);
  const priced = priceCiFrictionCauses(rounds);
  // THE FALSIFIER: ranked by fire count, the ten-round cheap check would come first. Ranked by
  // minutes lost, the one rare round that cost 25 minutes must outrank it.
  assert.equal(priced[0]!.cause.kind, "conflict");
  assert.equal(priced[0]!.minutes, 25);
  assert.equal(priced[0]!.rounds, 1);
  const cheap = priced.find((p) => p.cause.kind === "check")!;
  assert.equal(cheap.rounds, 10);
  assert.equal(cheap.minutes, 10);
  assert.ok(priced[0]!.minutes > cheap.minutes, "the rare 25-minute cause outranks the frequent one-minute one");

  // A round whose commit was refused buys no progress: it is priced as `fix_refusal`, not as
  // whatever mode triggered it, and a persisted GateFireRateReport prices `check` causes by name.
  const refused: LedgerRecord[] = [
    { step: "pr.opened", run_id: "run-refused", pr_url: "https://github.com/acme/remudero/pull/3", ts: "2026-09-24T02:00:00.000Z" },
    { step: "fix.dispatch", run_id: "run-refused", mode: "ci-log", round: 1, ts: "2026-09-24T02:03:00.000Z" },
    { step: "fix.commit_refused", run_id: "run-refused", round: 1, reason: "diff exceeds declared scope", ts: "2026-09-24T02:03:00.000Z" },
    // main merged in: a base refresh, named by the shared file it blames.
    { step: "fix.base_refreshed", run_id: "run-refused", matching_base_files: ["src/lib/shared.ts"], ts: "2026-09-24T02:33:00.000Z" },
  ];
  const withRefusal = priceCiFrictionCauses(ciFrictionRoundsFromLedger(refused));
  const refusal = withRefusal.find((p) => p.cause.kind === "fix_refusal");
  assert.equal(refusal?.cause.name, "commit_refused");
  assert.equal(refusal?.minutes, 3);
  const mainMerge = withRefusal.find((p) => p.cause.kind === "main_merge");
  assert.equal(mainMerge?.cause.name, "src/lib/shared.ts");
  assert.equal(mainMerge?.minutes, 30);
  // The `ci-log` dispatch is entirely superseded by the refusal — no double count for one round.
  assert.equal(withRefusal.find((p) => p.cause.kind === "check" && p.cause.name === "ci-log"), undefined);

  // A GateFireRateReport's own measured minutes price `check` causes by real gate name.
  const gateFireRates: GateFireRateReport = {
    status: "measured",
    prsScanned: 5,
    gates: [{ gate: "ci", prs: 3, runs: 6, redRuns: 2, refusals: 2, repaired: 2, overridden: 0, minutes: 40 }],
    neverFired: [],
    alwaysFired: [],
  };
  const priced2 = priceCiFrictionCauses([], gateFireRates);
  assert.deepEqual(priced2, [{ cause: { kind: "check", name: "ci" }, minutes: 40, rounds: 2, prs: 3 }]);

  // A run this cannot attribute to a pull request contributes no round, never a guess.
  assert.equal(runPrIndex([{ step: "pr.opened", run_id: "orphan", ts: "2026-09-24T00:00:00.000Z" }]).size, 0);
});

test("W1-T4435: the costliest untracked cause becomes a drafted task", async () => {
  const tracked = { cause: { kind: "check" as const, name: "ci" }, minutes: 90, rounds: 9, prs: 4 };
  const untracked = { cause: { kind: "main_merge" as const, name: "src/lib/shared.ts" }, minutes: 30, rounds: 1, prs: 1 };
  const priced = [tracked, untracked];

  // Its origin is already on a queued task — the costliest cause is skipped in favour of the next.
  assert.equal(costliestUntrackedCause(priced, [ciFrictionOrigin(tracked.cause)]), untracked);
  assert.equal(costliestUntrackedCause(priced, [ciFrictionOrigin(tracked.cause), ciFrictionOrigin(untracked.cause)]), undefined);

  // The rendered shard is a real, lintable plan record — parked for a person, Law 5's mark riding it.
  const yaml = ciFrictionShardYaml(untracked, "W1-T9001");
  assert.match(yaml, /^- id: W1-T9001$/m);
  assert.match(yaml, /^ {2}verify: human$/m);
  assert.match(yaml, /^ {2}author_class: machine$/m);
  assert.match(yaml, new RegExp(`^ {2}origin: "ci-friction:main_merge:src/lib/shared\\.ts"$`, "m"));
  assert.match(yaml, new RegExp(`proof: "grep: ${ciFrictionOrigin(untracked.cause)} in ${CI_FRICTION_REMEDIES_FILE}"`));
  const verdict = ciFrictionRecordVerdict(yaml, "test");
  assert.equal(verdict.ok, true, verdict.reason);

  // Wired end-to-end through the gardener framework: ONE class, judged by whether its PR merges,
  // and the SAME pass writes the weekly trend row beside the drafted shard.
  const repo = gitRepo({ kind: "w1t4435" });
  const root = repo.dir;
  mkdirSync(join(root, "state"), { recursive: true });

  type Landed = { paths: string[]; title: string; body: string };
  const landed: Landed[] = [];
  let minted = 0;
  const deps: CiFrictionGardenerDeps = {
    stateDir: join(root, "state"),
    repoRoot: root,
    openWorkspace: () => ({ root, land: (opts) => (landed.push(opts), "https://github.com/acme/remudero/pull/99"), dispose: () => {} }),
    log: () => {},
    seed: 1,
    ledgerRecords: () => [
      { step: "pr.opened", run_id: "run-1", pr_url: "https://github.com/acme/remudero/pull/2", ts: "2026-09-24T01:00:00.000Z" },
      { step: "fix.base_refreshed", run_id: "run-1", matching_base_files: ["src/lib/shared.ts"], ts: "2026-09-24T01:30:00.000Z" },
    ],
    gateFireRates: () => ({
      status: "measured",
      prsScanned: 4,
      gates: [{ gate: "ci", prs: 4, runs: 9, redRuns: 9, refusals: 9, repaired: 9, overridden: 0, minutes: 90 }],
      neverFired: [],
      alwaysFired: [],
    }),
    planOrigins: () => [ciFrictionOrigin(tracked.cause)],
    mintTaskId: () => `W1-T900${++minted}`,
  };

  const spec = ciFrictionGardenSpec(deps);
  assert.deepEqual(Object.keys(spec.review ?? {}), ["draft"], "filing a task is a person's call, judged by its PR");
  assert.deepEqual([...CI_FRICTION_GARDEN_CLASSES], ["draft"]);

  const pass = runGarden(spec, deps);
  assert.deepEqual(pass.plan?.acting, ["draft"]);
  assert.equal(pass.plan?.actions[0]?.target, ciFrictionCauseKey(untracked.cause));
  assert.equal(landed.length, 1);
  assert.equal("review" in landed[0]!, false, "never held or drafted — reviewed and auto-merges like every fleet PR");
  assert.match(landed[0]!.body, /^\*\*Judged by its outcome\.\*\* The ci-friction gardener's `draft` changes are judged by whether this PR merges/);

  const relPath = landed[0]!.paths.find((p) => p.startsWith("plan/tasks.d/"))!;
  assert.match(relPath, /^plan\/tasks\.d\/W1-T9001-main-merge/);
  const shard = readFileSync(join(root, relPath), "utf8");
  assert.match(shard, /^- id: W1-T9001$/m);
  assert.match(shard, new RegExp(`^ {2}origin: "${ciFrictionOrigin(untracked.cause).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"));
  assert.match(landed[0]!.body, new RegExp(`proof: grep: ${ciFrictionOrigin(untracked.cause)} in ${relPath}`));

  assert.ok(landed[0]!.paths.includes(CI_FRICTION_GARDEN_LOG));
  const log = readFileSync(join(root, CI_FRICTION_GARDEN_LOG), "utf8");
  assert.match(log, /\| pass \| total PR minutes \| costliest cause \|/);
  // 90 (ci) + 30 (main_merge) = 120 total priced this pass, topped by the check gate-fire-rate priced higher.
  assert.match(log, /\| 2026-.*\| 120 \| check:ci \(90m\) \|/);
});
