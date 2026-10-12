/**
 * W1-T5619 — A DUPLICATE-KEY REPAIR OF A MERGED TASK'S SHARD PASSES THE PLAN-PR PREFLIGHT.
 *
 * W1-T5519's self-repair lane opens a PR that drops a duplicate key from a shard on origin/main. The preflight's
 * shard-proof check discriminates only the proofs a PR INTRODUCES; it read the base shard with a unique-keys parse,
 * which throws on exactly the duplicate the repair removes, so every proof of the repaired shard read as introduced.
 * A MERGED task's proofs pass at origin/main (check-proof exit 5), and the repair was refused. Both arms are pinned
 * here: the repair passes, and a proof the PR really adds to a shard is still checked against origin/main.
 *
 * Every git fixture comes from test/helpers/git-repo.ts; check-proof is an offline grep of head and origin/main.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as emitter from "../src/lib/plan-pr-emitter.js";
import { gitRepo } from "./helpers/git-repo.js";

const { planPrPreflight, planPrPreflightAsync } = emitter;

const SHARD = "plan/tasks.d/W9-T1-merged.yaml";
const BUILT = "grep: built-feature in src/feature.ts";
/** A proof whose YAML text escapes it (`\\(`), so origin/main's raw bytes never carry its parsed string — only a
 *  parse of the duplicate-key base can credit it. */
const ESCAPED = String.raw`grep: built-feature\(\) in src/feature.ts`;
const ALSO_BUILT = "grep: other-feature in src/feature.ts";
const TITLE = "fix(plan): repair the duplicate key in W9-T1's shard";
const GREEN = { status: 0, output: "" };

/** A `check-proof --base origin/main` stand-in: 1 when the head misses, 5 when origin/main matches too, else 0. */
function grepAtHeadAndBase(cwd: string, proof: string): number {
  const m = /^grep: (.+) in (\S+)$/.exec(proof.trim());
  if (!m) return 2;
  const re = new RegExp(m[1], "m");
  const headPath = join(cwd, m[2]);
  if (!existsSync(headPath) || !re.test(readFileSync(headPath, "utf8"))) return 1;
  let base = "";
  try {
    base = execFileSync("git", ["-C", cwd, "show", `origin/main:${m[2]}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    base = "";
  }
  return re.test(base) ? 5 : 0;
}

const offlineChecks: emitter.PlanPrPreflightChecks = {
  lintPlan: () => GREEN,
  taskIdExistence: () => GREEN,
  shardCensus: () => GREEN,
  checkProof: grepAtHeadAndBase,
};
const offlineChecksAsync: emitter.PlanPrPreflightAsyncChecks = {
  lintPlan: async () => GREEN,
  taskIdExistence: async () => GREEN,
  shardCensus: async () => GREEN,
  checkProof: async (cwd, proof) => grepAtHeadAndBase(cwd, proof),
};

/** A merged task's shard; `extra` lines land after its acceptance list (the duplicate key the repair removes). */
function mergedShard(proofs: string[], extra: string[] = []): string {
  return [
    "- id: W9-T1",
    '  title: "a merged task"',
    "  repo: remudero",
    "  status: merged",
    "  acceptance:",
    ...proofs.flatMap((p) => ['    - claim: "it holds"', `      proof: ${JSON.stringify(p)}`]),
    ...extra,
    "",
  ].join("\n");
}

/** origin/main carries the built feature and `baseShard`; the returned clone is where the PR's commit is made. */
function repairFixture(baseShard: string, kind: string) {
  const seed = gitRepo({ kind: `${kind}-seed` });
  const files: Record<string, string> = { "src/feature.ts": "// built-feature()\n// other-feature\n", [SHARD]: baseShard };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(seed.dir, rel)), { recursive: true });
    writeFileSync(join(seed.dir, rel), text);
  }
  seed.git("add", "-A");
  seed.git("commit", "-q", "-m", "chore: seed");
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `${kind}-clone` });
  const commitShard = (text: string): void => {
    writeFileSync(join(clone.dir, SHARD), text);
    clone.git("add", "-A");
    clone.git("commit", "-q", "-m", "fix(plan): repair the shard");
  };
  return { clone, commitShard };
}

const DUPLICATE_KEY = ["  status: queued"]; // a second `status:` — the shape W1-T5519 quarantines and repairs

test("a duplicate-key repair of a merged task's shard introduces no proofs, so the preflight passes it", async () => {
  const f = repairFixture(mergedShard([ESCAPED], DUPLICATE_KEY), "w5619-repair");
  assert.equal(readFileSync(join(f.clone.dir, SHARD), "utf8").includes(ESCAPED), false, "the base bytes cannot credit the proof");
  f.commitShard(mergedShard([ESCAPED]));

  const sync = planPrPreflight({ cwd: f.clone.dir, title: TITLE, body: "" }, offlineChecks);
  assert.deepEqual(sync, { ok: true, failures: [], unreadable: [] }, "the merged task's own proof passes at origin/main by construction");
  const awaited = await planPrPreflightAsync({ cwd: f.clone.dir, title: TITLE, body: "" }, offlineChecksAsync);
  assert.deepEqual(awaited, { ok: true, failures: [], unreadable: [] }, "the awaited form reads the base the same way");
});

test("a proof a duplicate-key repair ADDS is still checked against origin/main and refused when it passes there", async () => {
  const f = repairFixture(mergedShard([ESCAPED], DUPLICATE_KEY), "w5619-added");
  f.commitShard(mergedShard([ESCAPED, ALSO_BUILT]));

  for (const r of [
    planPrPreflight({ cwd: f.clone.dir, title: TITLE, body: "" }, offlineChecks),
    await planPrPreflightAsync({ cwd: f.clone.dir, title: TITLE, body: "" }, offlineChecksAsync),
  ]) {
    assert.equal(r.ok, false);
    assert.deepEqual(r.failures.map((x) => x.check), ["proof-discrimination"]);
    assert.match(r.failures[0].firstLine, /other-feature/, "the added proof is the red one");
    assert.doesNotMatch(r.failures[0].firstLine, /built-feature/, "the pre-existing proof is not re-discriminated");
  }
});

test("a base shard that does not parse at all still credits a head proof whose exact text it carries", () => {
  const broken = ['  notes: "an unterminated quote']; // no parse option reads this — only its bytes remain
  const f = repairFixture(mergedShard([BUILT], broken), "w5619-bytes");
  f.commitShard(mergedShard([BUILT]));
  assert.deepEqual(planPrPreflight({ cwd: f.clone.dir, title: TITLE, body: "" }, offlineChecks), { ok: true, failures: [], unreadable: [] });

  const g = repairFixture(mergedShard([BUILT], broken), "w5619-bytes-added");
  g.commitShard(mergedShard([BUILT, ALSO_BUILT]));
  const added = planPrPreflight({ cwd: g.clone.dir, title: TITLE, body: "" }, offlineChecks);
  assert.equal(added.ok, false, "a proof absent from the base bytes is introduced, and it passes at origin/main");
  assert.match(added.failures[0].firstLine, /other-feature/);
  assert.doesNotMatch(added.failures[0].firstLine, /built-feature/);

  const h = repairFixture(mergedShard([BUILT]), "w5619-head-broken");
  h.commitShard(mergedShard([BUILT, ALSO_BUILT], broken));
  const headBroken = planPrPreflight({ cwd: h.clone.dir, title: TITLE, body: "" }, offlineChecks);
  assert.deepEqual(headBroken, { ok: true, failures: [], unreadable: [] }, "an unparseable HEAD shard is the plan lint's to refuse");
});
