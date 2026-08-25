import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_MENTION_LEAD, mintNextTaskId } from "../src/lib/task-id.js";

// A plan whose REAL ceiling is 2288, matching the shape the fleet actually carries: a low
// monolith and a much higher shard set. The gap between those two is itself large (280 vs 2288),
// which is why the guard keys on a MENTION source leading the PLAN, never on any two sources
// disagreeing — a rule of the latter kind would degrade the shards and break every mint.
function planWithCeiling(dir: string, monolithMax: number, shardMax: number): string {
  const planPath = join(dir, "tasks.yaml");
  writeFileSync(planPath, `tasks:\n  - id: W1-T1\n    title: "a"\n  - id: W1-T${monolithMax}\n    title: "b"\n`);
  mkdirSync(join(dir, "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "tasks.d", "shard.yaml"), `- id: W1-T${shardMax}\n  title: "c"\n`);
  return planPath;
}

test("a W1-T9999 mention in an open PR body does NOT become the ceiling — the source is dropped and named", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mint-uncorroborated-"));
  try {
    const planPath = planWithCeiling(dir, 280, 2288);
    const mint = mintNextTaskId({
      planPath,
      // The exact role the real body used it in: a doc example inside a code span. It is a
      // well-formed anchored token, so TASK_ID_MENTION_RE matches it correctly -- the regex is
      // not the defect and this fixture must keep it matchable.
      openPrTexts: () => ['`dispatchClaimRef("W1-T9999")` and the holder sha, plus the drop command.'],
    });

    assert.equal(mint.n, 2289, "the mint must stand on the plan's own ceiling, not the mention");
    assert.equal(mint.id, "W1-T2289");
    assert.notEqual(mint.n, 10000, "the observed failure returned 10000");

    const drop = mint.degraded.find((d) => d.source === "open-prs");
    assert.ok(drop, "the dropped source must be NAMED, never silently ignored");
    assert.match(drop.reason, /uncorroborated/, "the reason must say why it was dropped");
    assert.match(drop.reason, /7711/, "the reason must carry the measured lead");

    assert.equal(mint.sources.openPrs, null, "the burned number must not survive to be echoed back at an author");
    assert.doesNotMatch(JSON.stringify(mint), /9999/, "no rendering of the mint may reprint the burned id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mention that leads the plan by less than the bound is still believed, so a filing PR naming its own new id keeps working", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mint-normal-lead-"));
  try {
    const planPath = planWithCeiling(dir, 280, 2288);
    // The legitimate case measured on the real fleet: the open PRs' highest mention led the plan
    // by exactly 1, because a filing PR names the id it is about to add.
    const mint = mintNextTaskId({ planPath, openPrTexts: () => ["files W1-T2289 for the intake triggers"] });
    assert.equal(mint.n, 2290, "a lead inside the bound must still raise the ceiling");
    assert.equal(mint.degraded.filter((d) => d.source === "open-prs").length, 0, "and must not be reported as degraded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the boundary is exact: a lead OF the bound is believed and one PAST it is dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mint-boundary-"));
  try {
    const planPath = planWithCeiling(dir, 280, 2288);
    const at = mintNextTaskId({ planPath, openPrTexts: () => [`W1-T${2288 + MAX_MENTION_LEAD}`] });
    assert.equal(at.n, 2288 + MAX_MENTION_LEAD + 1, "a lead exactly at the bound is still corroborated enough");
    assert.equal(at.degraded.filter((d) => d.source === "open-prs").length, 0);

    const past = mintNextTaskId({ planPath, openPrTexts: () => [`W1-T${2288 + MAX_MENTION_LEAD + 1}`] });
    assert.equal(past.n, 2289, "one past the bound falls back to the plan's ceiling");
    assert.equal(past.degraded.filter((d) => d.source === "open-prs").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an EMPTY plan cannot be led astray either — with no plan ceiling to corroborate against, the guard does not fire and the mint stays degraded-free", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-mint-empty-plan-"));
  try {
    const planPath = join(dir, "tasks.yaml");
    writeFileSync(planPath, "tasks: []\n");
    mkdirSync(join(dir, "tasks.d"), { recursive: true });
    // planCeiling is 0, so the guard is inert BY CONSTRUCTION rather than by threshold: a fresh
    // repo with no ids yet must be able to take its first ceiling from anywhere it can.
    const mint = mintNextTaskId({ planPath, openPrTexts: () => ["W1-T7"] });
    assert.equal(mint.n, 8);
    assert.equal(mint.degraded.filter((d) => d.source === "open-prs").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
