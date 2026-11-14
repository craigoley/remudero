/**
 * W1-T12548: the flow-remedy ladder skips a cause it cannot file and drafts the next one, and an own-red
 * episode qualifies by its open age. Each test drives the production `flowGardenSpec`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fixedClock } from "#src/lib/clock.js";
import { FLOW_OWN_RED_OPEN_AGE_MS, flowGardenSpec, markEligibility, type Episode, type FlowGardenSources } from "#src/lib/flow-remedy-gardener.js";
import { gardenStatePath, runGarden, type GardenCheckout, type GardenerDeps } from "#src/lib/gardener.js";
import type { LedgerRecord } from "#src/lib/retro.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { writeLedger } from "#test/helpers/ledger-fixture.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 13, 12);
const iso = (hours: number) => fixedClock(NOW + hours * HOUR).iso();
const UNOWNED = "plan-proof-unrunnable:plan-only PR is red on ci-shard";
const OWN_RED = "own-red:required checks red";
function row(pr: number, hours: number, blocker: string, reason: string, owner: string): LedgerRecord {
  return { step: "sweep.disposed", pr_number: pr, ts: iso(hours), blocker, reason, blocker_owner: owner };
}
const unowned = (pr: number, hours: number) => row(pr, hours, "plan-proof-unrunnable", "plan-only PR is red on ci-shard", "NONE");
const ownRed = (pr: number, hours: number, reason = "required checks red") => row(pr, hours, "own-red", reason, "fix-lane");
const closed = (...prs: number[]) => () => new Map(prs.map(pr => [pr, { state: "closed" as const, at: iso(0) }]));

/** A git checkout with the declared owner module, a real ledger in `state/`, and a pass that lands into a list. */
function harness(t: TestContext, rows: LedgerRecord[], overrides: Partial<FlowGardenSources> = {}) {
  const repo = gitRepo({ kind: "flow-remedy-skip" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "src", "lib"), { recursive: true });
  writeFileSync(join(repo.dir, "src", "lib", "sweep.ts"), "export const sweep = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-q", "-m", "seed the owner module");
  const stateDir = join(repo.dir, "state");
  // The ladder reads the ledger union, which needs a rotation: the oldest row sits in one.
  writeLedger(rows.slice(1), { dir: stateDir, rotations: [{ at: String(rows[0]!.ts), rows: rows.slice(0, 1) }] });
  const logs: Array<[string, Record<string, unknown>]> = [];
  const landed: string[][] = [];
  const land: GardenCheckout["land"] = opts => (landed.push(opts.paths), "https://github.com/acme/remudero/pull/7");
  const deps: GardenerDeps = {
    repoRoot: repo.dir, stateDir, clock: fixedClock(NOW), seed: 1,
    log: (step, fields) => { logs.push([step, (fields ?? {}) as Record<string, unknown>]); },
    openWorkspace: () => ({ root: repo.dir, branch: "flow-remedy-garden-1", land, dispose: () => {} }),
  };
  const sources: FlowGardenSources = {
    owner: "acme", repo: "remudero", mintTaskId: () => "W1-T99548",
    planState: () => ({ tasks: [] }), prOutcomes: () => new Map(),
    ownerSearch: { filesContaining: () => [], fileExists: file => existsSync(join(repo.dir, file)) },
    ...overrides,
  };
  const spec = flowGardenSpec(deps, sources);
  return { repo, stateDir, logs, landed, spec, pass: () => runGarden(spec, deps) };
}

test("W1-T12548 criterion 1: a cause whose declared owner NONE names no module is skipped with that reason and the next cause is drafted", (t) => {
  const h = harness(t, [unowned(1, -3), unowned(1, -1), unowned(1, 0), ownRed(2, -2), ownRed(2, 0)]);
  const inv = h.spec.inventory();
  assert.equal(inv.candidates[0]!.key, UNOWNED, "the NONE-owned cause is the costliest candidate");
  const skipped = inv.ladder.find(l => l.cause === UNOWNED)!;
  assert.equal(skipped.state, "skipped");
  assert.match(skipped.reason ?? "", /declared owner NONE names no module in PR_BLOCKER_OWNER_MODULES/);
  assert.equal(inv.next!.price.key, OWN_RED, "the walk goes on to the next draftable cause");
  const rows = h.logs.filter(([step]) => step === "flow-remedy.cause_skipped");
  assert.equal(rows.length, 1, "one skipped row per skipped cause and pass");
  assert.equal(rows[0]![1].cause, UNOWNED);
  assert.match(String(rows[0]![1].reason), /declared owner NONE/);
});

test("W1-T12548 criterion 2: a cause whose owner file the scope check refuses is skipped, and a cause due to escalate still escalates", (t) => {
  const refusedKey = "own-red:a red";
  const remedy = { id: "W1-T9001", origin: `flow-blocker:${refusedKey}`, files: ["src/lib/sweep.ts"], status: "queued", retired: false, mergedAt: iso(-24) };
  // The remedy on src/lib/sweep.ts merged 24 h ago and its cause still costs the same share: a debit, so rung 2 would reuse the file.
  const rows = [ownRed(1, -48, "a red"), ownRed(1, -24, "a red"), ownRed(2, -24, "a red"), ownRed(2, 0, "a red"),
    ownRed(3, -26, "b red"), ownRed(3, -24, "b red"), ownRed(4, -2, "b red"), ownRed(4, 0, "b red")];
  const h = harness(t, rows, { prOutcomes: closed(1, 2, 3, 4), planState: () => ({ tasks: [remedy] }) });
  const inv = h.spec.inventory();
  const refused = inv.ladder.find(l => l.cause === refusedKey)!;
  assert.equal(refused.state, "skipped");
  assert.equal(refused.rung, 2);
  assert.match(refused.reason ?? "", /already used and its effect did not fall/);
  assert.equal(inv.next!.price.key, "own-red:b red", "the next cause is drafted");
  assert.equal(inv.next!.escalation, undefined);
  const due = harness(t, rows, { prOutcomes: closed(1, 2, 3, 4), planState: () => ({ tasks: [{ ...remedy, origin: `${remedy.origin}#r2` }] }) });
  const escalating = due.spec.inventory();
  assert.equal(escalating.ladder.find(l => l.cause === refusedKey)!.state, "escalate");
  assert.equal(escalating.next!.price.key, refusedKey, "an escalation is never skipped");
  assert.equal(escalating.next!.rung, 3);
  assert.ok(escalating.next!.escalation);
  assert.equal(due.logs.filter(([step]) => step === "flow-remedy.cause_skipped").length, 0);
});

test("W1-T12548 criterion 3: with no cause it can file the pass files nothing and counts no filing failure", (t) => {
  const h = harness(t, [unowned(1, -3), unowned(1, 0)], { mintTaskId: () => { throw new Error("nothing to file must not mint"); } });
  const result = h.pass();
  assert.equal(result.prUrl, undefined);
  assert.equal(h.landed.length, 0);
  assert.equal(h.logs.filter(([step]) => step === "flow-remedy.garden_filing_failed").length, 0);
  assert.equal(h.logs.filter(([step]) => step === "flow-remedy.cause_skipped").length, 1);
  const state = JSON.parse(readFileSync(gardenStatePath(h.stateDir, "flow-remedy"), "utf8")) as { filingFailures?: unknown };
  assert.equal(state.filingFailures, undefined, "no daily retry wait starts");
  assert.equal(result.scorecard?.next, null);
});

test("W1-T12548 criterion 4: an own-red episode open longer than FLOW_OWN_RED_OPEN_AGE_MS is eligible whatever the p90 is", () => {
  assert.equal(FLOW_OWN_RED_OPEN_AGE_MS, 60 * 60_000);
  const episode = (pr: number, key: string, ageMs: number, outcome: Episode["outcome"] = "open"): Episode =>
    ({ pr, key, owner: "fix-lane", start: NOW - ageMs, end: NOW, outcome, eligible: false, charges: [] });
  // Cleared own-red episodes of 10 h set a p90 far above the open age.
  const cleared = [1, 2, 3].map(pr => episode(pr, OWN_RED, 10 * HOUR, "cleared"));
  const old = episode(10, OWN_RED, FLOW_OWN_RED_OPEN_AGE_MS + 60_000);
  const young = episode(11, OWN_RED, FLOW_OWN_RED_OPEN_AGE_MS - 60_000);
  const otherKey = episode(12, "awaiting-ci:pending", FLOW_OWN_RED_OPEN_AGE_MS + 60_000);
  const thresholds = markEligibility([...cleared, old, young, otherKey], NOW);
  assert.equal(thresholds.get(OWN_RED), 10);
  assert.equal(old.eligible, true, "open past the open age");
  assert.equal(young.eligible, false, "open for less is not made eligible by this rule");
  assert.equal(otherKey.eligible, false, "the open age rule is for own-red only");
  const alone = episode(13, OWN_RED, FLOW_OWN_RED_OPEN_AGE_MS + 60_000);
  markEligibility([alone], NOW);
  assert.equal(alone.eligible, true, "no cleared episode is needed");
});

test("W1-T12548 criterion 5: a garden pass whose costliest eligible cause is owned by NONE files the next cause", (t) => {
  const redChecks = ["ci-shard", "mutation-ratchet", "lint-plan", "coverage-ratchet", "acceptance-author-gate", "rule-checks", "test-slow", "security-merge-policy"];
  const unownedCauses = redChecks.flatMap((check, index) => {
    const reason = `plan-only PR is red on ${check}`;
    const pr = index + 10;
    return [-24, -12, 0].map(hours => row(pr, hours, "plan-proof-unrunnable", reason, "NONE"));
  });
  const h = harness(t, [...unownedCauses, ownRed(2, -2), ownRed(2, -1), ownRed(2, 0)]);
  const result = h.pass();
  assert.equal(result.prUrl, "https://github.com/acme/remudero/pull/7", `the next cause landed (rows: ${h.logs.map(([s]) => s).join(", ")})`);
  assert.equal(h.landed.length, 1);
  const text = readFileSync(join(h.repo.dir, h.landed[0]![0]!), "utf8");
  assert.match(text, /origin: "flow-blocker:own-red:required checks red"/);
  assert.match(text, /fix-lane → src\/lib\/sweep\.ts/);
  assert.equal(h.logs.filter(([step]) => step === "flow-remedy.garden_filing_failed").length, 0);
  const skipped = h.logs.filter(([step]) => step === "flow-remedy.cause_skipped");
  assert.equal(skipped.length, 8);
  assert.equal(skipped.some(([, fields]) => fields.cause === OWN_RED), false);
});
