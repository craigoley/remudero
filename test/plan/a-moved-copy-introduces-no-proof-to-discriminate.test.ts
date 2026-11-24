/**
 * W1-T14603 — a plan-PR preflight over an ops tree treats a task shard that is an exact catalog-move copy (its bytes
 * less one moved_from line equal the public original at the named commit) as introducing no proof, so
 * proof-discrimination never refuses a move step for a copied record's old proof (operator ruling 2026-11-24
 * "Exempt moved copies"). The exemption lives on the async preflight every move step runs; the sync forms judge a
 * copy exactly as on origin/main (amended design item 3: no extra blocking git read on a daemon-loop path). The copy
 * is built by the mover's own withMovedFromLine, so the input is the one production emits. Anything else (an edited
 * copy, an unreadable commit, two moved_from lines, no code root) is judged exactly as before: fail closed.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  planPrPreflight, planPrPreflightAsync, planPrPreflightAtCommit, planPrPreflightAtCommitAsync,
  type PlanPrPreflightResult,
} from "#src/lib/plan-pr-emitter.js";
import { withMovedFromLine } from "#src/lib/plan-task-move.js";
import { gitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";

const ID = "W1-T900";
const SHARD = `plan/tasks.d/${ID}-a-copied-record.yaml`;
const PROOF = "grep: copied outcome text in test/fixture.test.ts";
const ORIGINAL = `- id: ${ID}\n  title: "a copied record"\n  status: queued\n  acceptance:\n` +
  `    - claim: "the copied outcome holds"\n      proof: "${PROOF}"\n`;
/** check-proof's exit for a proof that already passes at origin/main (CHECK_PROOF_STALE_EXIT). */
const STALE = 5;
const GREEN = () => ({ status: 0, output: "" });

function put(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }

/** A public code root holding ORIGINAL at commit C, and an ops tree whose origin/main lacks the shard. */
function fixture(t: TestContext) {
  const code = gitRepo({ scope: t, kind: "moved-copy-public" });
  put(join(code.dir, SHARD), ORIGINAL);
  code.git("add", SHARD); code.git("commit", "-qm", "public record");
  const publicCommit = code.git("rev-parse", "HEAD");
  const ops = gitRepo({ scope: t, kind: "moved-copy-ops" });
  put(join(ops.dir, "plan/tasks.yaml"), "[]\n");
  ops.git("add", "plan/tasks.yaml"); ops.git("commit", "-qm", "ops base");
  ops.git("update-ref", "refs/remotes/origin/main", "HEAD");
  const stateDir = ownedFixtureDir(t, "moved-copy-state").dir; // no plan-destination file: no code root is inferred
  /** Commit `text` as the ops tree's head shard and return the head sha. */
  const head = (text: string): string => {
    put(join(ops.dir, SHARD), text);
    ops.git("add", SHARD); ops.git("commit", "-qm", "ops copy");
    return ops.git("rev-parse", "HEAD");
  };
  return { code, ops, publicCommit, stateDir, head };
}

const SYNC_FORMS = ["planPrPreflight", "planPrPreflightAtCommit"] as const;
const ASYNC_FORMS = ["planPrPreflightAsync", "planPrPreflightAtCommitAsync"] as const;
type Form = (typeof SYNC_FORMS)[number] | (typeof ASYNC_FORMS)[number];

/** All four preflight forms over the ops head; `asked[form]` records every proof that form's proof-discrimination checked. */
async function preflights(f: ReturnType<typeof fixture>, sha: string, opts: { codeRoot: boolean }) {
  const asked: Record<Form, string[]> = { planPrPreflight: [], planPrPreflightAsync: [], planPrPreflightAtCommit: [], planPrPreflightAtCommitAsync: [] };
  const checkProof = (form: Form) => (_cwd: string, proof: string) => { asked[form].push(proof); return proof === PROOF ? STALE : 0; };
  const sync = (form: Form) => ({ lintPlan: GREEN, taskIdExistence: GREEN, shardCensus: GREEN, checkProof: checkProof(form), destinationStateDir: () => f.stateDir });
  const async = (form: Form) => ({ lintPlan: async () => GREEN(), taskIdExistence: async () => GREEN(), shardCensus: async () => GREEN(),
    checkProof: async (cwd: string, proof: string) => checkProof(form)(cwd, proof), destinationStateDir: () => f.stateDir });
  const pr = { title: `chore(plan): move ${ID} into the ops catalog`, body: "", ...(opts.codeRoot ? { codeRoot: f.code.dir } : {}) };
  const input = { cwd: f.ops.dir, ...pr };
  const results: Record<Form, PlanPrPreflightResult> = {
    planPrPreflight: planPrPreflight(input, sync("planPrPreflight")),
    planPrPreflightAsync: await planPrPreflightAsync(input, async("planPrPreflightAsync")),
    planPrPreflightAtCommit: planPrPreflightAtCommit(f.ops.dir, sha, pr, sync("planPrPreflightAtCommit")),
    planPrPreflightAtCommitAsync: await planPrPreflightAtCommitAsync(f.ops.dir, sha, pr, async("planPrPreflightAtCommitAsync")),
  };
  return { results, asked };
}

const STALE_LINE = `shard proof ${JSON.stringify(PROOF)} passes at origin/main too`;
function assertJudged(run: Awaited<ReturnType<typeof preflights>>, label: string, forms: readonly Form[] = [...SYNC_FORMS, ...ASYNC_FORMS]): void {
  for (const form of forms) {
    const result = run.results[form];
    assert.equal(result.ok, false, `${label}: ${form} judges the shard's proof as introduced: ${JSON.stringify(result)}`);
    const finding = result.failures.find((x) => x.check === "proof-discrimination");
    assert.equal(finding?.firstLine, STALE_LINE, `${label}: ${form} names the stale shard proof`);
    assert.deepEqual(run.asked[form], [PROOF], `${label}: ${form} asked check-proof about the shard proof`);
  }
}

test("W1-T14603 criterion 1: an exact move copy contributes no shard proof in the async preflight forms every move step runs", async (t) => {
  const f = fixture(t);
  const copy = withMovedFromLine(ORIGINAL, ID, f.publicCommit);
  assert.notEqual(copy, ORIGINAL, "the copy carries the mover's moved_from line");
  const sha = f.head(copy);
  const { results, asked } = await preflights(f, sha, { codeRoot: true });
  for (const form of ASYNC_FORMS) {
    assert.equal(results[form].ok, true, `${form}: an exact move copy is not refused: ${JSON.stringify(results[form])}`);
    assert.deepEqual(results[form].failures, [], form);
    assert.deepEqual(results[form].unreadable, [], form);
    assert.deepEqual(asked[form], [], `${form} never asked check-proof about the copied record's proof`);
  }
});

test("W1-T14603 criterion 2: a copy that differs from the public original, names an unreadable commit, carries two moved_from lines, or is read with no code root, and any copy the sync forms read, is judged as before", async (t) => {
  await t.test("an exact copy read by the sync forms, which stay as on origin/main", async (st) => {
    const f = fixture(st);
    const sha = f.head(withMovedFromLine(ORIGINAL, ID, f.publicCommit));
    assertJudged(await preflights(f, sha, { codeRoot: true }), "sync forms", SYNC_FORMS);
  });
  await t.test("differs from the public original at the named commit", async (st) => {
    const f = fixture(st);
    const sha = f.head(withMovedFromLine(ORIGINAL.replace("status: queued", "status: blocked"), ID, f.publicCommit));
    assertJudged(await preflights(f, sha, { codeRoot: true }), "differs");
  });
  await t.test("names a commit the code root cannot read", async (st) => {
    const f = fixture(st);
    const sha = f.head(withMovedFromLine(ORIGINAL, ID, "0".repeat(40)));
    assertJudged(await preflights(f, sha, { codeRoot: true }), "unreadable commit");
  });
  await t.test("names a malformed moved_from value", async (st) => {
    const f = fixture(st);
    const sha = f.head(withMovedFromLine(ORIGINAL, ID, f.publicCommit).replace(`remudero@${f.publicCommit}`, `remudero@${f.publicCommit.slice(0, 12)}`));
    assertJudged(await preflights(f, sha, { codeRoot: true }), "malformed value");
  });
  await t.test("carries two moved_from lines", async (st) => {
    const f = fixture(st);
    // The second line sits on the criterion, so the record still parses (a duplicate top-level key is the lint's to refuse).
    const line = `      moved_from: remudero@${f.publicCommit}\n`;
    const sha = f.head(withMovedFromLine(ORIGINAL, ID, f.publicCommit).replace(`      proof: "${PROOF}"\n`, `${line}      proof: "${PROOF}"\n`));
    assertJudged(await preflights(f, sha, { codeRoot: true }), "two lines");
  });
  await t.test("is read with no code root", async (st) => {
    const f = fixture(st);
    const sha = f.head(withMovedFromLine(ORIGINAL, ID, f.publicCommit));
    assertJudged(await preflights(f, sha, { codeRoot: false }), "no code root");
  });
});

test("W1-T14603 criterion 3: invariant only-exact-copies-are-exempt — one edit beyond the moved_from line makes the shard judged again", async (t) => {
  const edits: Array<[string, (copy: string) => string]> = [
    ["an edited title line", (copy) => copy.replace('title: "a copied record"', 'title: "a copied record, edited"')],
    ["one appended byte", (copy) => `${copy}\n`],
    ["a carriage return on one line", (copy) => copy.replace("  status: queued\n", "  status: queued\r\n")],
  ];
  for (const [label, edit] of edits) {
    await t.test(label, async (st) => {
      const f = fixture(st);
      const copy = withMovedFromLine(ORIGINAL, ID, f.publicCommit);
      const edited = edit(copy);
      assert.notEqual(edited, copy, `${label} changes the copy`);
      const sha = f.head(edited);
      assertJudged(await preflights(f, sha, { codeRoot: true }), label);
    });
  }
});
