/**
 * The knowledge gardener acts on at most GARDEN_MAX_ACTIONS_PER_PASS (3) retire/merge targets in one
 * pass (operator ruling, 2026-10-13). One pass retired 14 learnings at once (#7205). The cap keeps
 * the most certain targets (largest share of posterior draws below the corpus median, ties by id),
 * and every candidate it leaves out is named as deferred in the pass's scorecard row and in its
 * garden-log section, so the next pass judges it again instead of it vanishing.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import { GARDEN_LOG, GARDEN_MAX_ACTIONS_PER_PASS, runGardenPass, type GardenWorkspace } from "#src/lib/knowledge-gardener.js";
import { learningUsagePath } from "#src/lib/knowledge-value.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

type Usage = { offered: number; used: number };

const entry = (id: string) => [`- id: ${id}`, "  subsystem: t", "  lifecycle: active", "  files: [src/x.ts]", "  fact: >-", `    Entry ${id} alone.`, "  src: t", ""].join("\n");

/** Retired with certainty: every one of the 400 draws falls below the corpus median. */
const CERTAIN: Usage = { offered: 400, used: 0 };
/** Retired too, but only about 98% of draws fall below the median: clears the 95% bar, less surely. */
const LIKELY: Usage = { offered: 20, used: 12 };
/** The corpus's typical learning; sixteen of them set the median every candidate is judged against. */
const TYPICAL: Usage = { offered: 100, used: 80 };
const typical = Array.from({ length: 16 }, (_, i) => [`mm-typical-${String(i + 1).padStart(2, "0")}`, TYPICAL] as const);

/** One pass over a shard holding `entries` in the order given, with only the retire class able to act. */
async function pass(entries: ReadonlyArray<readonly [string, Usage]>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-cap-`));
  mkdirSync(join(root, "learnings"), { recursive: true });
  writeFileSync(join(root, "learnings", "core.yaml"), entries.map(([id]) => entry(id)).join("\n"));
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(learningUsagePath(join(root, "state")), JSON.stringify(Object.fromEntries(entries)));
  for (const c of ["merge", "refresh"]) writeFileSync(join(root, "state", `KNOWLEDGE_OFF-${c}`), "");
  const rows: Array<[string, Record<string, unknown> | undefined]> = [];
  const workspace = (): GardenWorkspace => ({ root, refreshAssertions: () => [], land: () => "https://github.com/acme/remudero/pull/9", dispose: () => {} });
  const result = await runGardenPass({ stateDir: join(root, "state"), repoRoot: root, openWorkspace: workspace, log: (s, e) => rows.push([s, e]), seed: 3, clock: fixedClock(Date.parse("2026-10-13T00:00:00.000Z")) });
  const shard = readFileSync(join(root, "learnings", "core.yaml"), "utf8");
  const log = readFileSync(join(root, GARDEN_LOG), "utf8");
  const scorecard = rows.find(([s]) => s === "knowledge.scorecard")?.[1];
  return { result, shard, log, scorecard, retired: [...shard.matchAll(/# knowledge gardener: retire (\S+)/g)].map((m) => m[1]!).sort() };
}

const likely = Array.from({ length: 11 }, (_, i) => `aa-likely-${String(i + 1).padStart(2, "0")}`);
const certain = ["zz-certain-1", "zz-certain-2", "zz-certain-3"];
// The less certain eleven come FIRST, in both shard order and id order, so a cap that took the first
// three found, or the first three by id, would pick them; only ranking by certainty picks the last three.
const fourteen = [...likely.map((id) => [id, LIKELY] as const), ...typical, ...certain.map((id) => [id, CERTAIN] as const)];

test("a garden pass with 14 eligible retirements retires only the 3 most certain", async () => {
  const { result, retired } = await pass(fourteen);
  assert.equal(GARDEN_MAX_ACTIONS_PER_PASS, 3);
  assert.deepEqual(result.plan?.acting, ["retire"]);
  assert.deepEqual(result.plan?.actions.map((a) => a.target).sort(), certain, "the plan holds exactly the three most certain");
  assert.deepEqual(retired, certain, "only those three are superseded in the shard");
});

test("a garden pass names the 11 retirements its cap deferred, in its scorecard row and the garden log", async () => {
  const { result, log, scorecard } = await pass(fourteen);
  const named = likely.map((id) => `retire ${id}`);
  assert.deepEqual([...((scorecard?.deferred as string[]) ?? [])].sort(), named, "the pass's knowledge.scorecard row names all eleven");
  assert.deepEqual([...(result.scorecard?.deferred ?? [])].sort(), named, "and so does the pass's own result");
  const section = log.slice(log.indexOf("## Pass 2026-10-13T00:00:00.000Z"));
  for (const id of likely) assert.match(section, new RegExp(`^- deferred retire ${id}: over this pass's cap of 3; the next pass judges it again\\.$`, "m"));
  assert.equal(section.match(/^- retire /gm)?.length, 3, "the log's action lines are the three retired, not the deferred");
});

test("a garden pass with 2 eligible retirements acts on both and defers none", async () => {
  const two = ["zz-certain-1", "zz-certain-2"];
  const { result, retired, log, scorecard } = await pass([...typical, ...two.map((id) => [id, CERTAIN] as const)]);
  assert.ok(two.length < GARDEN_MAX_ACTIONS_PER_PASS, "under the cap");
  assert.deepEqual(result.plan?.acting, ["retire"]);
  assert.deepEqual(retired, two, "both are retired");
  assert.equal(scorecard?.deferred, undefined, "nothing is deferred");
  assert.doesNotMatch(log, /^- deferred /m);
});

test("equally certain retirements past the cap are deferred in id order", async () => {
  // Shard order runs against id order, so the tie-break is the id, not where an entry sits.
  const ids = ["e-certain", "d-certain", "c-certain", "b-certain", "a-certain"];
  const { retired, scorecard } = await pass([...typical, ...ids.map((id) => [id, CERTAIN] as const)]);
  assert.deepEqual(retired, ["a-certain", "b-certain", "c-certain"]);
  assert.deepEqual(scorecard?.deferred, ["retire d-certain", "retire e-certain"]);
});
