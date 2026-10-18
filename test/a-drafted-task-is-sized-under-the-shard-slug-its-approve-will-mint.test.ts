/**
 * test/a-drafted-task-is-sized-under-the-shard-slug-its-approve-will-mint.test.ts — W1-T9327.
 *
 * OBSERVED 2026-10-13: the draft lint had no shard slug, so `subsystemsOf` discounted any test path as the task's own
 * falsifier, while the push preflight sized the written shard by its title slug and refused the same task [sizing].
 * Here the draft lint, the approve repair and the shard writer take the slug from one helper.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  draftShardSlug,
  lintDraftedFragment,
  ratificationShardFiles,
  relintRatificationFragment,
  writeRatificationShards,
} from "#src/lib/inbox.js";
import { lintTask } from "#src/lib/task-linter.js";
import { parseTasksFromYaml } from "#src/lib/plan.js";

/** The DAEMON-1790001204828 shape: a recon task at risk:low naming another concern's test plus one src file. */
function draft(title: string, files: string[], risk = "low"): string {
  return [
    "- id: NEW-1",
    `  title: ${JSON.stringify(title)}`,
    "  repo: remudero",
    "  depends_on: []",
    "  type: recon",
    "  verify: auto",
    `  risk: ${risk}`,
    "  status: queued",
    "  attempts: 0",
    "  files:",
    ...files.map((f) => `    - ${f}`),
    "  acceptance:",
    '    - claim: "the plan filing provenance is read"',
    '      proof: "unit test: the plan filing provenance is read"',
    '  origin: "architect"',
    "",
  ].join("\n");
}

const OTHER_TEST = "test/review-command-plan-filing-provenance.test.ts";
const FOREIGN = draft("Investigate nested worktree path artifact causing esm parse crash", [OTHER_TEST, "src/lib/plan.ts"]);
const OWN = draft("Review command plan filing provenance", [OTHER_TEST, "src/lib/plan.ts"]);
const yes = (): boolean => true;
const sizing = (yaml: string) =>
  lintDraftedFragment(yaml, "p-1", undefined, new Set(["remudero"]), yes, undefined, () => false, yes).filter((v) => v.check === "sizing");

/** What the push preflight does: lint the written shard under the slug its filename carries. */
function pushSizing(yaml: string) {
  const [shard] = (ratificationShardFiles(yaml.replace("NEW-1", "W1-T9999")) as { files: Array<{ relPath: string; contents: string }> }).files;
  const [task] = parseTasksFromYaml(shard.contents, shard.relPath);
  return lintTask({ ...task, sourcePath: shard.relPath }).violations.filter((v) => v.check === "sizing" && v.severity === "block");
}

test("W1-T9327: a drafted task naming a test of another concern is sized as the push sizes it", () => {
  assert.ok(pushSizing(FOREIGN).length > 0, "the push refuses the fixture");
  const drafted = sizing(FOREIGN);
  assert.ok(drafted.some((v) => v.severity === "block"), `the draft lint blocks it too: ${JSON.stringify(drafted)}`);
  assert.match(drafted[0].message, /spans 2 distinct subsystems/);
});

test("W1-T9327: a drafted task whose title slug names its own falsifier keeps the discount", () => {
  assert.equal(draftShardSlug("Review command plan filing provenance"), "review-command-plan-filing-provenance");
  assert.deepEqual(pushSizing(OWN), []);
  assert.deepEqual(sizing(OWN), []);
});

test("W1-T9327: an approve repairs a cached draft whose sizing block appears only under its minted slug", () => {
  const relinted = relintRatificationFragment(FOREIGN, "p-1", { moduleExists: yes, readGrepProofFile: () => undefined });
  assert.ok(relinted.ok, JSON.stringify(relinted));
  assert.match(relinted.fragmentYaml, /risk: high/);
  assert.match(relinted.fragmentYaml, /band_meaning: span/);
  const written: Record<string, string> = {};
  writeRatificationShards("/w", FOREIGN, "p-1", { mkdirSync: () => undefined, writeFileSync: (p, d) => { written[p] = d; } }, (...parts) => parts.join("/"));
  assert.ok(Object.values(written).every((c) => /risk: high/.test(c)), "the written shard is repaired");
});

test("W1-T9327: the shard writer and the draft lint derive one stem, quoted and over-long titles included", () => {
  const long = `${"alpha ".repeat(20)}tail`;
  const stem = draftShardSlug(long);
  assert.ok(stem.length <= 72 && !stem.endsWith("-"));
  const raw = '- id: W1-T1\n  title: "Quoted title here"\n';
  const files = ratificationShardFiles(raw);
  assert.ok(files.ok && files.files[0].relPath === "plan/tasks.d/W1-T1-quoted-title-here.yaml");
  assert.equal(draftShardSlug('"Quoted title here"'), "quoted-title-here");
  assert.equal(draftShardSlug("Quoted title"), "quoted-title");
});
