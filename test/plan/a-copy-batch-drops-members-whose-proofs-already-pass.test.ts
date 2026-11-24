/**
 * W1-T14592: a mover copy batch that proof-discrimination refuses because some members' proofs already pass on core
 * drops exactly those members and is judged again by the same preflight, so one done-but-uncredited record no longer
 * holds back every record batched beside it. Every case drives the real mover over two real Git origins
 * (test/helpers/plan-move-world.ts); only the preflight is a fake, and it judges the exact commit it is handed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { PlanPrPreflightFinding, PlanPrPreflightResult } from "#src/lib/plan-pr-emitter.js";
import { moveWorld, record, shard, type MoveWorld } from "#test/helpers/plan-move-world.js";

type Json = Record<string, unknown>;
const proofOf = (id: string) => `grep: ${id} criterion 1 in test/fixture.test.ts`;
/** A fixture record whose one proof names its own id, so a refusal line names exactly one member. */
const own = (id: string) => record(id).replace("grep: fixture in test/fixture.test.ts", proofOf(id));
const staleLine = (proof: string) => `shard proof ${JSON.stringify(proof)} passes at origin/main too`;
const sorted = (ids: readonly unknown[]) => [...ids].map(String).sort();

/** The shard texts the commit under judgement holds, read from that commit itself. */
function shardsAt(repoDir: string, commit: string): string[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  return git("ls-tree", "--name-only", commit, "plan/tasks.d/").split("\n").filter(Boolean).map(path => git("cat-file", "blob", `${commit}:${path}`));
}

/**
 * A preflight that reads proof-discrimination as the emitter does for moved shards: red when a shard in the commit
 * carries a proof that already passes on core. `shown` keeps only the first N lines and adds the emitter's
 * truncation marker; `also` adds another check's failure beside it.
 */
function preflightFake(passing: readonly string[], opts: { shown?: number; also?: PlanPrPreflightFinding; bodyLine?: boolean } = {}) {
  const judged: string[] = [];
  const preflight = async (repoDir: string, commit: string): Promise<PlanPrPreflightResult> => {
    judged.push(commit);
    const red = shardsAt(repoDir, commit).flatMap(text => passing.filter(p => text.includes(p))).map(staleLine);
    if (opts.bodyLine === true) red.unshift(`body proof ${JSON.stringify("grep: x in y")} fails on this tree`);
    const failures: PlanPrPreflightFinding[] = [];
    if (red.length > 0) {
      const shown = red.slice(0, opts.shown ?? red.length);
      const lines = shown.length < red.length ? [...shown, `… ${red.length - shown.length} more line(s)`] : shown;
      failures.push({ check: "proof-discrimination", firstLine: lines[0]!, ...(lines.length > 1 ? { lines } : {}) });
    }
    if (opts.also !== undefined) failures.push(opts.also);
    return { ok: failures.length === 0, failures, unreadable: [] };
  };
  return { preflight, judged };
}

const FOUR = ["W1-T1", "W1-T2", "W1-T3", "W1-T4"];
const world = (t: Parameters<typeof moveWorld>[0]): MoveWorld => moveWorld(t, Object.fromEntries(FOUR.map(id => [id, own(id)])));
const copyRows = (w: MoveWorld) => w.ledger.filter(row => row.move_step === "copy");

test("W1-T14592 criterion 1: a copy refused only because some members' proofs already pass on core drops exactly those members, is preflighted again, and opens the COPY pull request for the rest", async t => {
  const w = world(t);
  const fake = preflightFake([proofOf("W1-T1"), proofOf("W1-T3")]);
  const run = await w.run(true, { preflight: fake.preflight });
  assert.equal(run.status, 0, run.lines.join("\n"));
  assert.equal(run.out.step, "copy");
  assert.equal(w.pulls.length, 1, `THE CLAIM: the rebuilt copy opens its pull request: ${run.lines.join("\n")}`);
  const [copy] = w.pulls;
  assert.equal(copy!.repository, "ops");
  assert.deepEqual(sorted(copy!.files), ["W1-T2", "W1-T4"].map(shard), "exactly the members whose proofs do not pass on core");
  assert.deepEqual(sorted(run.out.ids as unknown[]), ["W1-T2", "W1-T4"]);
  assert.doesNotMatch(copy!.body, /W1-T1\b|W1-T3\b/, "no receipt names a dropped member");
  assert.equal(fake.judged.length, 2, "the first refusal and one rebuild");
  assert.equal(w.sides.ops.origin.git("rev-parse", `${copy!.head}^`), w.main("ops"), "the rebuild sits on the same ops parent");

  await t.test("a truncated refusal shows the first proofs only; each rebuild's own refusal names the rest", async st => {
    const v = world(st);
    const truncated = preflightFake([proofOf("W1-T1"), proofOf("W1-T2"), proofOf("W1-T3")], { shown: 1 });
    const again = await v.run(true, { preflight: truncated.preflight });
    assert.equal(again.status, 0, again.lines.join("\n"));
    assert.deepEqual(v.pulls.map(p => p.files), [[shard("W1-T4")]]);
    assert.equal(truncated.judged.length, 4, "one rebuild per refusal that names a member to drop");
  });

  await t.test("a rebuild of one member is that member's own one-task copy", async st => {
    const v = world(st);
    const three = preflightFake([proofOf("W1-T1"), proofOf("W1-T2"), proofOf("W1-T3")]);
    const one = await v.run(true, { preflight: three.preflight });
    assert.equal(one.status, 0, one.lines.join("\n"));
    assert.match(v.pulls[0]!.head, /^plan-move-W1-T4-\d+$/);
    assert.equal(v.pulls[0]!.title, "chore(plan): move W1-T4 into the ops catalog");
  });
});

test("W1-T14592 criterion 2: the member-dropping row and every preflight_refused row carry the failing checks, their first lines and the dropped ids with the proof that dropped each", async t => {
  const w = world(t);
  const fake = preflightFake([proofOf("W1-T1"), proofOf("W1-T3")]);
  await w.run(true, { preflight: fake.preflight });
  const [opened] = copyRows(w);
  assert.equal(copyRows(w).length, 1, "one row for the step");
  assert.equal(opened!.outcome, "opened");
  assert.deepEqual(opened!.failures, [{ check: "proof-discrimination", first_lines: [staleLine(proofOf("W1-T1")), staleLine(proofOf("W1-T3"))] }],
    "THE CLAIM: the row names the refusal that dropped members");
  assert.deepEqual(opened!.dropped, [{ id: "W1-T1", proof: proofOf("W1-T1") }, { id: "W1-T3", proof: proofOf("W1-T3") }]);

  await t.test("a refusal that leaves no member stands down and names its failure", async st => {
    const v = world(st);
    const all = preflightFake(FOUR.map(proofOf));
    const run = await v.run(true, { preflight: all.preflight });
    assert.equal(run.status, 1);
    assert.equal(v.pulls.length, 0);
    const [refused] = copyRows(v);
    assert.equal(refused!.outcome, "preflight_refused");
    assert.deepEqual(refused!.failures, [{ check: "proof-discrimination", first_lines: FOUR.map(id => staleLine(proofOf(id))) }]);
    assert.equal(refused!.dropped, undefined, "nothing was dropped: the whole batch stood down");
  });

  await t.test("any other refusal's row names its check and first line too", async st => {
    const v = world(st);
    const lint = preflightFake([], { also: { check: "lint-plan", firstLine: "lint-plan-precheck: W1-T2 REFUSES" } });
    await v.run(true, { preflight: lint.preflight });
    const [refused] = copyRows(v);
    assert.equal(refused!.outcome, "preflight_refused");
    assert.deepEqual(refused!.failures as Json[], [{ check: "lint-plan", first_lines: ["lint-plan-precheck: W1-T2 REFUSES"] }]);
  });
});

test("W1-T14592 criterion 3: invariant:preflight-unchanged — the pushed copy is the commit the preflight last admitted, and any other refusal stands down after one preflight as before", async t => {
  const w = world(t);
  const fake = preflightFake([proofOf("W1-T2")]);
  await w.run(true, { preflight: fake.preflight });
  assert.equal(w.pulls[0]!.headOid, fake.judged.at(-1), "THE CLAIM: what is pushed is exactly what the preflight admitted");

  const standsDown: Array<[string, Parameters<typeof preflightFake>[1]]> = [
    ["a refusal of another check beside proof-discrimination", { also: { check: "lint-plan", firstLine: "lint-plan-precheck: REFUSES" } }],
    ["a PR-body proof line in the proof-discrimination refusal", { bodyLine: true }],
  ];
  for (const [name, opts] of standsDown) {
    await t.test(`${name} stands down with no pull request`, async st => {
      const v = world(st);
      const mixed = preflightFake([proofOf("W1-T1")], opts);
      const run = await v.run(true, { preflight: mixed.preflight });
      assert.equal(run.status, 1, run.lines.join("\n"));
      assert.equal(run.out.outcome, "preflight_refused");
      assert.equal(v.pulls.length, 0);
      assert.equal(mixed.judged.length, 1, "no rebuild");
      assert.equal(copyRows(v)[0]!.dropped, undefined);
    });
  }

  await t.test("a refusal with no failures listed but not ok never drops anything", async st => {
    const v = world(st);
    const run = await v.run(true, { preflight: async () => ({ ok: false, failures: [], unreadable: [] }) });
    assert.equal(run.status, 1);
    assert.equal(v.pulls.length, 0);
  });
});
