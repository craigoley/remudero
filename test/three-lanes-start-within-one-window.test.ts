import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { GitHub } from "../src/lib/status.js";
import { memoiseGatewayByRepo } from "../src/run-task.js";

/**
 * W1-T2509 — THE DISPATCH FAN-OUT WAS THREE LANES WIDE AND ONE LANE DEEP.
 *
 * `dispatch.concurrent_set` proved the admission side correct: every row named two or three tasks
 * at `lane_count: 3`. But the run ids minted INSIDE those lanes were 78 seconds apart, because
 * `admitted.map((t) => deps.runOne(t.id))` INVOKES each `runOne` in turn, and a `runOne` that runs
 * synchronously to its first yield stops the next one from being CALLED at all — not merely from
 * progressing. The blocking work was `buildBatchedGithub`'s cold full-repo walk, paid once per
 * lane because every lane built its own gateway.
 *
 * Six alternatives were eliminated before this was filed as a defect: not a governor
 * (`dispatch.lane_governed`/`dispatch.wip_deferred` read zero across 48 archives), not file overlap
 * (the three measured tasks are mutually disjoint), not queue depth (53 runnable, largest disjoint
 * set 21), not the lane count (the real module reports 3), not a shared lock (`drain.lock` is
 * drain-scoped), not a deliberate stagger (the fan-out carries none).
 *
 * These tests pin the MEMOISATION CONTRACT — that N lanes on one repo construct ONE gateway — plus
 * the wiring that carries it to `runOne`. They deliberately do not drive a real three-lane dispatch:
 * that needs a network walk to be slow to be observable at all, which is precisely the property a
 * test must not depend on.
 */

/** A distinguishable stand-in — object identity is the whole assertion, so the shape is irrelevant. */
function fakeGateway(tag: string): GitHub {
  return { __tag: tag } as unknown as GitHub;
}

test("N lanes on one repo construct exactly ONE gateway — the cold walk is paid once, not N times", () => {
  const built: string[] = [];
  const forRepo = memoiseGatewayByRepo((o, r) => {
    built.push(`${o}/${r}`);
    return fakeGateway(`${o}/${r}#${built.length}`);
  });

  const lane1 = forRepo("craigoley", "remudero");
  const lane2 = forRepo("craigoley", "remudero");
  const lane3 = forRepo("craigoley", "remudero");

  assert.equal(built.length, 1, "three lanes on one repo must construct ONE gateway, not three");
  assert.equal(lane1, lane2, "lane 2 must receive the SAME instance lane 1 warmed");
  assert.equal(lane2, lane3, "and so must lane 3 — this is what makes lanes 2..N cheap");
});

test("a task naming a DIFFERENT repo is never answered by another repo's gateway", () => {
  const built: string[] = [];
  const forRepo = memoiseGatewayByRepo((o, r) => {
    built.push(`${o}/${r}`);
    return fakeGateway(`${o}/${r}`);
  });

  const home = forRepo("craigoley", "remudero");
  const other = forRepo("craigoley", "remudero-site");
  const foreign = forRepo("someone-else", "remudero");

  assert.notEqual(home, other, "a different repo must get its own gateway");
  assert.notEqual(home, foreign, "a different OWNER must get its own gateway");
  assert.deepEqual(built, ["craigoley/remudero", "craigoley/remudero-site", "someone-else/remudero"]);
});

test("the memoiser performs no I/O of its own — it only ever calls the injected builder", () => {
  let calls = 0;
  const forRepo = memoiseGatewayByRepo(() => {
    calls += 1;
    return fakeGateway("x");
  });
  forRepo("o", "r");
  forRepo("o", "r");
  forRepo("o", "r");
  assert.equal(calls, 1, "the builder is the ONLY construction path, and it runs once per key");
});

test("a builder returning distinct instances is still collapsed to one per key — identity, not equality", () => {
  let n = 0;
  const forRepo = memoiseGatewayByRepo(() => fakeGateway(`instance-${(n += 1)}`));
  const a = forRepo("o", "r");
  const b = forRepo("o", "r");
  assert.equal(n, 1, "a second call must not build a second instance");
  assert.equal(a, b);
});

test("THE WIRING: the daemon's runOne hands every lane the memoised factory", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "run-task.ts"), "utf8");

  // The lane factory exists and is memoised through the helper above — not rebuilt per lane.
  assert.match(
    src,
    /const laneGithubFor = memoiseGatewayByRepo\(/,
    "daemonCommand must build its lane gateway factory through memoiseGatewayByRepo",
  );
  // ...and it actually reaches runTask. Without this line the memoiser is dead code and every lane
  // falls back to its own cold `buildBatchedGithub` — the exact defect this task closes.
  assert.match(src, /githubFor: laneGithubFor,/, "runOne must pass the memoised factory to runTask");

  // runTask must CONSULT it, and `opts.github` must still win so no existing test caller changes.
  assert.match(
    src,
    /const github = opts\.github \?\? opts\.githubFor\?\.\(owner, task\.repo\) \?\? buildBatchedGithub\(owner, task\.repo\);/,
    "runTask must prefer opts.github, then githubFor, then a fresh gateway",
  );
});

test("the fallback is unchanged: absent githubFor, runTask still builds its own gateway", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "run-task.ts"), "utf8");
  assert.match(
    src,
    /\?\? buildBatchedGithub\(owner, task\.repo\);/,
    "a caller supplying neither seam must behave exactly as it did before this task",
  );
});
