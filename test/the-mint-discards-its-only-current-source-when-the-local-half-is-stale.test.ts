/**
 * test/the-mint-discards-its-only-current-source-when-the-local-half-is-stale.test.ts — W1-T2710.
 *
 * `MAX_MENTION_LEAD` (W1-T1039) drops an open-PR figure that leads the plan's own ceiling by more
 * than 100, because a PR body is prose and may name an id nothing has filed. That is right while
 * the plan half is CURRENT. It INVERTS the moment it is not: every source `mintNextTaskId` reads
 * lives in THIS CHECKOUT, so all of them are stale together, while the open-PR scan reads PRs on
 * the remote and cannot be stale in the same way. The guard then throws away the only source
 * telling the truth, precisely BECAUSE the stale half disagrees with it.
 *
 * MEASURED 2026-09-02, one invocation, every number from the verb's own output and from origin:
 * `shards` read 2598 from a checkout 107 ids behind while origin's highest shard was 2705, so the
 * lead computed as 109 (> 100) and the open-PR ceiling was discarded as uncorroborated. With every
 * current source gone the ceiling fell back to the plan history's 2690, and the reserve path
 * walked 2691, 2692, … 2710 — TWENTY sequential pushes into `refs/rmd-id/`, five of them stepping
 * over ids that are FILED SHARDS ON MAIN and were each reported as held by another caller. A
 * reader watching that scroll past concludes the fleet is busy, not that their checkout is behind.
 *
 * THE FIX IS WHICH SOURCES ARE TRUSTED, NEVER A WIDER TOLERANCE: `MAX_MENTION_LEAD` is asserted
 * unchanged below. The discriminator is whether the plan half is CURRENT — checkable against the
 * remote — not whether the numbers differ.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_MENTION_LEAD, describeMint, mintNextTaskId } from "../src/lib/task-id.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { describeMintWithHistory, mintNextTaskIdWithHistory, remotePlanCeilingOnRef } from "../src/run-task.js";

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

/** A plan whose LOCAL half declares exactly `localCeiling` — a monolith plus one shard, the two
 *  sources `mintNextTaskId` folds as "the plan". Returns the `tasks.yaml` path. */
function planFixture(localCeiling: number): { planPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mint-stale-`));
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T280\n    title: old monolith id\n");
  writeFileSync(
    join(root, "plan", "tasks.d", `W1-T${localCeiling}-a-shard.yaml`),
    `- id: W1-T${localCeiling}\n  title: the highest id this checkout can see\n`,
  );
  return { planPath: join(root, "plan", "tasks.yaml"), root };
}

const cleanups: string[] = [];
function fixture(localCeiling: number): string {
  const { planPath, root } = planFixture(localCeiling);
  cleanups.push(root);
  return planPath;
}
process.on("exit", () => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

// The measured 2026-09-02 numbers, used verbatim so a reader can line the assertions up against
// the rationale: a checkout at 2598, origin at 2705, and an open PR mentioning 2707.
const STALE_LOCAL = 2598;
const REMOTE_TRUTH = 2705;
const OPEN_PR_MENTION = 2707;

// ── acceptance 1: the staleness is DETECTED and NAMED, not merely worked around ────────────────

test("W1-T2710 (acceptance 1): a plan ceiling read from a checkout behind the remote is detected and named in the provenance line", () => {
  const mint = mintNextTaskId({
    planPath: fixture(STALE_LOCAL),
    openPrTexts: () => [`filing W1-T${OPEN_PR_MENTION}`],
    remotePlanCeiling: () => REMOTE_TRUTH,
  });
  assert.equal(mint.planBehindBy, REMOTE_TRUTH - STALE_LOCAL, "107 — the measured gap, not a rounded one");
  const line = describeMint(mint);
  assert.match(line, /remote plan 2705/, "the provenance line names the source it compared against");
  assert.match(line, /107 id\(s\) behind origin's/, "and says the local half is behind, in as many words");
  assert.match(line, /pull before filing/, "with the action that fixes it");
});

test("W1-T2710 (acceptance 1b): a CURRENT local half reports a MEASURED zero — the provenance line still names the comparison so the zero is legible as measured", () => {
  const current = mintNextTaskId({ planPath: fixture(REMOTE_TRUTH), remotePlanCeiling: () => REMOTE_TRUTH });
  assert.equal(current.planBehindBy, 0);
  assert.match(describeMint(current), /remote plan 2705/, "the check ran and said so");
  assert.doesNotMatch(describeMint(current), /behind origin/, "nothing to report when the half is current");

  // The UNMEASURED zero, which must read differently: no reader injected at all.
  const offline = mintNextTaskId({ planPath: fixture(STALE_LOCAL) });
  assert.equal(offline.planBehindBy, 0, "an unmeasured gap is never reported as a measured one");
  assert.match(describeMint(offline), /remote plan -/, "and the line says the comparison never happened");
});

// ── acceptance 2: the accurate source survives a lead that staleness explains ──────────────────

test("W1-T2710 (acceptance 2): an open-PR figure is NOT discarded as over-leading when the lead is explained by that staleness", () => {
  const mint = mintNextTaskId({
    planPath: fixture(STALE_LOCAL),
    openPrTexts: () => [`filing W1-T${OPEN_PR_MENTION}`],
    remotePlanCeiling: () => REMOTE_TRUTH,
  });
  // Against the STALE half the lead is 109 (> 100) and the old code dropped the source. Against
  // the CURRENT ceiling it is 2, well inside the bound.
  assert.equal(OPEN_PR_MENTION - STALE_LOCAL, 109, "the lead the old code measured — over the bound");
  assert.equal(mint.sources.openPrs, OPEN_PR_MENTION, "the accurate source stands, not nulled");
  assert.equal(
    mint.degraded.filter((d) => d.source === "open-prs").length,
    0,
    "and it is not reported as uncorroborated",
  );
  assert.equal(mint.maxSeen, OPEN_PR_MENTION, "so the ceiling is the truth, not the stale history");
});

test("W1-T2710 (acceptance 2b): the FALSIFIER — with no remote reader the SAME inputs still drop the source, so this test is measuring the fix and not the fixture", () => {
  const mint = mintNextTaskId({
    planPath: fixture(STALE_LOCAL),
    openPrTexts: () => [`filing W1-T${OPEN_PR_MENTION}`],
  });
  assert.equal(mint.sources.openPrs, null, "pre-W1-T2710 behaviour, byte-identical, when nothing measures staleness");
  assert.equal(mint.degraded.filter((d) => d.source === "open-prs").length, 1);
});

// ── acceptance 3: W1-T1039's own defect stays caught ──────────────────────────────────────────

test("W1-T2710 (acceptance 3): a genuine over-lead against a CURRENT plan ceiling is STILL dropped — W1-T1039's defect stays caught", () => {
  // The plan half is current (local == remote), and an open PR body carries a fabricated id far
  // above it — the doc-example case W1-T1039 exists for. Nothing about this task may bless it.
  const mint = mintNextTaskId({
    planPath: fixture(REMOTE_TRUTH),
    openPrTexts: () => [`see W1-T${REMOTE_TRUTH + 7711} for an example`],
    remotePlanCeiling: () => REMOTE_TRUTH,
  });
  assert.equal(mint.sources.openPrs, null, "the uncorroborated ceiling is dropped exactly as before");
  assert.equal(mint.maxSeen, REMOTE_TRUTH, "and the mint stands on the plan, which is authoritative");
  const dropped = mint.degraded.find((d) => d.source === "open-prs");
  assert.ok(dropped, "and says so");
  assert.match(dropped.reason, /read fine but uncorroborated/);
});

test("W1-T2710 (acceptance 3b): a STALE half does not bless an over-lead either — the ceiling rises to the remote's, and a mention still beyond THAT is dropped", () => {
  const mint = mintNextTaskId({
    planPath: fixture(STALE_LOCAL),
    openPrTexts: () => [`see W1-T${REMOTE_TRUTH + 7711} for an example`],
    remotePlanCeiling: () => REMOTE_TRUTH,
  });
  assert.equal(mint.sources.openPrs, null, "staleness widens the ceiling, never the tolerance");
  assert.equal(mint.planBehindBy, REMOTE_TRUTH - STALE_LOCAL, "and the staleness is still reported on its own");
});

// ── acceptance 4: the BOUND is untouched — the fix is which sources are trusted ────────────────

test("W1-T2710 (acceptance 4): MAX_MENTION_LEAD is unchanged, and it is still the number the check applies", () => {
  assert.equal(MAX_MENTION_LEAD, 100, "widening this re-opens W1-T1039 exactly as its own doc warns");
  // Drive the boundary through the real check against a CURRENT ceiling: a lead of exactly the
  // bound is kept, one more is dropped. If the constant or the comparison ever moved, this fails.
  const at = mintNextTaskId({
    planPath: fixture(REMOTE_TRUTH),
    openPrTexts: () => [`W1-T${REMOTE_TRUTH + MAX_MENTION_LEAD}`],
    remotePlanCeiling: () => REMOTE_TRUTH,
  });
  assert.equal(at.sources.openPrs, REMOTE_TRUTH + MAX_MENTION_LEAD, "a lead OF the bound is not over it");
  const over = mintNextTaskId({
    planPath: fixture(REMOTE_TRUTH),
    openPrTexts: () => [`W1-T${REMOTE_TRUTH + MAX_MENTION_LEAD + 1}`],
    remotePlanCeiling: () => REMOTE_TRUTH,
  });
  assert.equal(over.sources.openPrs, null, "one past it is");
});

// ── acceptance 5: with a current ceiling the walk is short, and the producer is real ───────────

test("W1-T2710 (acceptance 5): with a current ceiling the mint lands one above the TRUE frontier, so a burst of sequential reservation pushes is not the normal path", () => {
  const fixed = mintNextTaskId({
    planPath: fixture(STALE_LOCAL),
    openPrTexts: () => [`filing W1-T${OPEN_PR_MENTION}`],
    remotePlanCeiling: () => REMOTE_TRUTH,
  });
  assert.equal(fixed.n, OPEN_PR_MENTION + 1, "one push, not twenty");

  // The measured walk, reconstructed: without the remote half the mint answers from the stale
  // ceiling and `--reserve` must step over every id already taken between there and the truth.
  const stale = mintNextTaskId({ planPath: fixture(STALE_LOCAL), openPrTexts: () => [`filing W1-T${OPEN_PR_MENTION}`] });
  assert.ok(
    fixed.n - stale.n > 100,
    `the stale mint starts ${fixed.n - stale.n} ids below the frontier — every one of them a network push`,
  );
});

test("W1-T2710 (acceptance 5b): the producer is REAL — remotePlanCeilingOnRef reads DECLARED ids off origin/main, not the working tree", () => {
  // A real local git repo with a real `origin` remote. The remote carries a HIGHER id than the
  // working tree does, which is the entire situation under test: a reader that answered from the
  // checkout would return the low number and this would fail.
  const origin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mint-origin-`));
  const clone = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mint-clone-`));
  cleanups.push(origin, clone);
  git(origin, "init", "--quiet", "-b", "main");
  mkdirSync(join(origin, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(origin, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T280\n    title: old\n");
  writeFileSync(join(origin, "plan", "tasks.d", "W1-T2598-a.yaml"), "- id: W1-T2598\n  title: a\n");
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "first");
  execFileSync("git", ["clone", "--quiet", origin, clone], { encoding: "utf8", env: GIT_ENV });

  assert.equal(remotePlanCeilingOnRef(clone, "plan"), 2598, "the clone is level with origin");

  // origin advances; the clone does NOT pull, only fetches — exactly the stale-checkout shape.
  writeFileSync(join(origin, "plan", "tasks.d", "W1-T2705-b.yaml"), "- id: W1-T2705\n  title: b\n");
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "second");
  git(clone, "fetch", "--quiet", "origin", "main:refs/remotes/origin/main");

  assert.equal(remotePlanCeilingOnRef(clone, "plan"), 2705, "reads origin/main's blobs, not the checkout's");
  const mint = mintNextTaskId({
    planPath: join(clone, "plan", "tasks.yaml"),
    remotePlanCeiling: () => remotePlanCeilingOnRef(clone, "plan"),
  });
  assert.equal(mint.sources.shards, 2598, "the working tree really is behind");
  assert.equal(mint.planBehindBy, 107, "and the mint says by how much — the measured 107");
  assert.equal(mint.n, 2706, "answering above the remote's frontier rather than the checkout's");
});

test("W1-T2710 (acceptance 5c): a repo with NO origin/main is EMPTY, not a degradation — a fixture checkout keeps minting", () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mint-noremote-`));
  cleanups.push(root);
  git(root, "init", "--quiet", "-b", "main");
  mkdirSync(join(root, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(root, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T280\n    title: old\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "only");
  assert.equal(remotePlanCeilingOnRef(root, "plan"), null, "no tracking ref to compare against");
  const mint = mintNextTaskId({ planPath: join(root, "plan", "tasks.yaml"), remotePlanCeiling: () => remotePlanCeilingOnRef(root, "plan") });
  assert.equal(mint.degraded.length, 0, "an absent remote is empty, exactly as an absent tasks.d/ is");
  assert.equal(mint.n, 281);
});

test("W1-T2710 (acceptance 5d): a THROWING remote reader degrades and never blocks the mint", () => {
  const mint = mintNextTaskId({
    planPath: fixture(STALE_LOCAL),
    remotePlanCeiling: () => {
      throw new Error("git exploded");
    },
  });
  assert.equal(mint.n, STALE_LOCAL + 1, "the mint still answers, from the sources it could read");
  const d = mint.degraded.find((x) => x.source === "remote-plan");
  assert.ok(d, "and says which source it lost");
  assert.match(d.reason, /git exploded/);
});

// ── the WIRING end: the seam has a producer on the path every caller already takes ─────────────

test("W1-T2710 (wiring): mintNextTaskIdWithHistory supplies the remote reader itself, so every caller inherits the current ceiling with nothing injected", () => {
  // THE #339/W1-T281 SHAPE, GUARDED: a `remotePlanCeiling` parameter with no producer here is a
  // dead seam — deleting the argument in `mintNextTaskIdWithHistory` would fail no test above,
  // because every one of them injects its own reader. This one injects NOTHING and drives the
  // function all five call sites go through, so removing that hop reddens it.
  const origin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mint-wire-origin-`));
  const clone = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}mint-wire-clone-`));
  cleanups.push(origin, clone);
  git(origin, "init", "--quiet", "-b", "main");
  mkdirSync(join(origin, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(origin, "plan", "tasks.yaml"), "tasks:\n  - id: W1-T280\n    title: old\n");
  writeFileSync(join(origin, "plan", "tasks.d", "W1-T2598-a.yaml"), "- id: W1-T2598\n  title: a\n");
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "first");
  execFileSync("git", ["clone", "--quiet", origin, clone], { encoding: "utf8", env: GIT_ENV });
  writeFileSync(join(origin, "plan", "tasks.d", "W1-T2705-b.yaml"), "- id: W1-T2705\n  title: b\n");
  git(origin, "add", "-A");
  git(origin, "commit", "--quiet", "-m", "second");
  git(clone, "fetch", "--quiet", "origin", "main:refs/remotes/origin/main");

  const mint = mintNextTaskIdWithHistory({ planPath: join(clone, "plan", "tasks.yaml"), repoRoot: clone });
  assert.equal(mint.sources.remotePlan, 2705, "no reader injected — this function supplied one");
  assert.equal(mint.n, 2706, "so the layered mint answers above the remote's frontier too");
  const behind = mint.degraded.find((d) => d.source === "local-plan");
  assert.ok(behind, "and the staleness reaches the layered result's own degradations");
  assert.match(behind.reason, /107 id\(s\) behind origin's/);
  assert.match(describeMintWithHistory(mint), /remote plan 2705/, "and the operator-facing line names it");
});
