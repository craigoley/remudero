import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { declaredTaskIds, describeMint, mentionedTaskIds, mintNextTaskId } from "../src/lib/task-id.js";

// ── the mint (the 2/2 collision evidence: W1-T256->257 #770, W1-T260->261 #775) ──
// An id picked from "the last one I saw" collides with ids that live where the picker
// did not look — a merged PR's task, or a plan/tasks.d/ shard. These fixtures are those
// two collisions, reproduced as data.

/** A plan root with a monolith and (optionally) shard files. Returns the tasks.yaml path. */
function planFixture(monolithIds: number[], shards: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mint-plan-"));
  const planDir = join(root, "plan");
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, "tasks.yaml");
  writeFileSync(planPath, monolithIds.map((n) => `- id: W1-T${n}\n  title: "t${n}"\n`).join(""));
  const names = Object.keys(shards);
  if (names.length) {
    mkdirSync(join(planDir, "tasks.d"), { recursive: true });
    for (const name of names) writeFileSync(join(planDir, "tasks.d", name), shards[name]);
  }
  return planPath;
}

test("declaredTaskIds reads ids a plan file DECLARES, never ids it merely references", () => {
  const text = [
    "- id: W1-T10",
    "  depends_on: [W1-T999]", // a reference, not ownership — must not count
    "  note: \"supersedes W1-T998\"", // prose, not ownership
    "- id: W1-T12",
  ].join("\n");
  assert.deepEqual(declaredTaskIds(text), [10, 12]);
});

test("mentionedTaskIds is deliberately loose — an open PR offers only free text to scan", () => {
  assert.deepEqual(mentionedTaskIds("W1-T256: mint\n\nRemudero-Task: W1-T256\nrun-W1-T257-123"), [256, 256, 257]);
  assert.deepEqual(mentionedTaskIds("no ids here"), []);
});

test("mintNextTaskId: the #775 REGRESSION — a shard holding the would-be id forces the mint ABOVE it", () => {
  // Exactly the W1-T260 collision: the monolith's highest is 259, so "next" looks like 260 —
  // but plan/tasks.d/W1-T260-*.yaml already owns 260. A monolith-only mint returns the taken id.
  const planPath = planFixture([258, 259], {
    "W1-T260-console-up-next-write-actions.yaml": "- id: W1-T260\n  title: \"already owned by a shard\"\n",
  });
  const mint = mintNextTaskId({ planPath });
  assert.equal(mint.id, "W1-T261", "the mint must clear the shard-owned id, not collide with it");
  assert.equal(mint.sources.monolith, 259);
  assert.equal(mint.sources.shards, 260, "the shard is what pushed the mint up — its max is on the record");
  assert.equal(mint.maxSeen, 260);
  assert.deepEqual(mint.degraded, []);
});

test("mintNextTaskId: the #770 REGRESSION — an id minted by an OPEN plan PR is reserved, though it exists nowhere on main", () => {
  // W1-T256 was minted by a PR that had not merged: absent from tasks.yaml AND from every shard,
  // so both local sources say "255 is the max" and hand back an id another PR already owns.
  const planPath = planFixture([254, 255]);
  const mint = mintNextTaskId({
    planPath,
    openPrTexts: () => ["chore(plan): file the api-key overflow valve\n\nadds W1-T256 (origin: feedback#…)"],
  });
  assert.equal(mint.id, "W1-T257", "the open PR's minted id is reserved — mint above it");
  assert.equal(mint.sources.monolith, 255);
  assert.equal(mint.sources.openPrs, 256);
});

test("mintNextTaskId: every source is folded with max — the highest wins wherever it lives", () => {
  const planPath = planFixture([300, 12], { "a.yaml": "- id: W1-T7\n", "b.yaml": "- id: W1-T290\n" });
  const mint = mintNextTaskId({ planPath, openPrTexts: () => ["nothing minted here"] });
  assert.equal(mint.id, "W1-T301");
  assert.deepEqual(mint.sources, { monolith: 300, shards: 290, openPrs: null, remotePlan: null });
});

test("mintNextTaskId: an unsharded plan is EMPTY shards, not a degradation (back-compat)", () => {
  const mint = mintNextTaskId({ planPath: planFixture([4]) });
  assert.equal(mint.id, "W1-T5");
  assert.equal(mint.sources.shards, null);
  assert.deepEqual(mint.degraded, [], "a plan with no tasks.d/ is normal, never a degraded read");
});

test("mintNextTaskId: an empty plan mints W1-T1 rather than throwing on an empty max", () => {
  const mint = mintNextTaskId({ planPath: planFixture([]) });
  assert.equal(mint.id, "W1-T1");
  assert.equal(mint.maxSeen, 0);
});

test("mintNextTaskId: a THROWING open-PR enumerator DEGRADES loudly — the id ships as a floor, never silently", () => {
  const planPath = planFixture([100]);
  const mint = mintNextTaskId({
    planPath,
    openPrTexts: () => {
      throw new Error("gh: API rate limit already exceeded");
    },
  });
  assert.equal(mint.id, "W1-T101", "the mint still returns a usable id — a dead gh never blocks triage");
  assert.equal(mint.sources.openPrs, null);
  assert.equal(mint.degraded.length, 1);
  assert.equal(mint.degraded[0].source, "open-prs");
  assert.match(mint.degraded[0].reason, /rate limit/, "the reason is carried verbatim enough to act on");
  assert.match(describeMint(mint), /DEGRADED: open-prs/, "and it is legible in the one-line provenance");
});

test("describeMint names the id, the max, and every source it derived from", () => {
  const planPath = planFixture([9], { "s.yaml": "- id: W1-T11\n" });
  const line = describeMint(mintNextTaskId({ planPath, openPrTexts: () => ["W1-T10"] }));
  // W1-T2710 added the `remote plan` term. `-` is the UNMEASURED reading: no reader was injected
  // here, so the line must say the comparison never happened rather than imply a current ceiling.
  assert.match(line, /^W1-T12 \(max 11 across tasks\.yaml 9, shards 11, open PRs 10, remote plan -\)$/);
});

test("describeMint says 'not enumerated' when the open-PR source was never consulted (offline mint)", () => {
  const line = describeMint(mintNextTaskId({ planPath: planFixture([9]) }));
  assert.match(line, /open PRs not enumerated/);
});

test("mintNextTaskId: an UNREADABLE shard degrades — a shard that cannot be read may own a higher id than any that can", () => {
  const planPath = planFixture([5], { "ok.yaml": "- id: W1-T6\n" });
  // A directory where a shard file is expected: readFileSync throws EISDIR, standing in for any
  // unreadable shard (permissions, a broken symlink, a half-written file mid-checkout).
  mkdirSync(join(planPath, "..", "tasks.d", "broken.yaml"), { recursive: true });
  const mint = mintNextTaskId({ planPath });
  assert.equal(mint.id, "W1-T7", "the readable sources still produce a usable id");
  assert.equal(mint.degraded.length, 1);
  assert.equal(mint.degraded[0].source, "shards");
  assert.match(mint.degraded[0].reason, /cannot read shard broken\.yaml/);
});
