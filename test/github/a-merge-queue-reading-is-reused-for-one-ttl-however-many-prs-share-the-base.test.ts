// W1-T14239 — the arm path kept a merge-queue answer per PR for MERGE_QUEUE_READ_TTL_MS from the moment
// it copied it out of the per-base rules reading, which is itself kept for MERGE_QUEUE_READ_TTL_MS. A
// reading could therefore answer for almost two TTLs: a second PR that first read at t0+TTL-1 kept the
// t0 answer until t0+2*TTL-1. A stale `true` sends the arm down the queue path, ahead of the W1-T5615
// plan-PR guard and the W1-T9962 ratchet-collision hold, and arms auto-merge on a base with no queue.
// INVARIANT one-queue-ttl: no merge-queue answer is served once MERGE_QUEUE_READ_TTL_MS has passed since
// the rules read it came from.
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { MERGE_QUEUE_READ_TTL_MS, attemptArmAsync, realArmDepsAsync, type ArmDeps } from "#src/lib/arm-auto-merge.js";
import { systemClock } from "#src/lib/clock.js";
import { judgeMergedRatchets, type MergedRatchetInputs } from "#src/lib/merged-ratchet-verdict.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

const ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "PATH", "HOME", "RMD_GH_CACHE_HOME", "XDG_CACHE_HOME", "GH_CONFIG_DIR", "GH_HOST"] as const;
const ON = JSON.stringify([{ type: "merge_queue" }]);
const OFF = JSON.stringify([]);

/** A `gh` on PATH whose rules answer for `owner/repo`'s main is read from a file at call time, so the
 *  queue can be turned off between reads; every PR in `prs` has main as its base. */
function scene(t: TestContext, owner: string, repo: string, prs: number[]) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1-t14239-`));
  fs.mkdirSync(join(root, "gh-config"));
  const rulesFile = join(root, "rules.json");
  fs.writeFileSync(rulesFile, ON);
  const shim = ghShim([
    { when: `repos/${owner}/${repo}/rules/branches/main`, stdoutFile: rulesFile },
    ...prs.map((n) => ({ when: `repos/${owner}/${repo}/pulls/${n}`, stdout: JSON.stringify({ base: { ref: "main" } }) })),
  ]);
  process.env.GH_TOKEN = "w1-t14239-fixture-token";
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_HOST;
  delete process.env.RMD_GH_CACHE_HOME;
  delete process.env.XDG_CACHE_HOME;
  process.env.HOME = root;
  process.env.GH_CONFIG_DIR = join(root, "gh-config");
  process.env.PATH = `${shim.dir}:${saved.PATH ?? ""}`;
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(shim.dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    queueOff: () => fs.writeFileSync(rulesFile, OFF),
    rulesReads: () => shim.calls().filter((call) => call.includes("/rules/branches/main")).length,
    mergeQueue: realArmDepsAsync((() => { throw new Error("the merge-queue reading reads no config"); }) as never).mergeQueue!,
    url: (n: number) => `https://github.com/${owner}/${repo}/pull/${n}`,
  };
}

test("W1-T14239 criterion 1: a second PR that first reads at t0+TTL-1 reads false at t0+TTL on the arm path once the queue went off after t0", async (t) => {
  let now = 5_000_000;
  t.mock.method(systemClock, "now", () => now);
  const s = scene(t, "fixture-owner", "w1-t14239-one", [1, 2]);
  const t0 = now;
  assert.equal(await s.mergeQueue(s.url(1)), true, "the first PR reads the queue at t0");
  assert.equal(s.rulesReads(), 1);
  s.queueOff();
  now = t0 + MERGE_QUEUE_READ_TTL_MS - 1;
  assert.equal(await s.mergeQueue(s.url(2)), true, "positive control: inside the TTL the t0 reading answers the second PR");
  assert.equal(s.rulesReads(), 1, "positive control: two PRs on one base still make one rules read");
  now = t0 + MERGE_QUEUE_READ_TTL_MS;
  assert.equal(await s.mergeQueue(s.url(2)), false, "at t0+TTL the t0 reading is spent, however recently this PR copied it");
  assert.equal(s.rulesReads(), 2, "the base is read again at t0+TTL");
  assert.equal(await s.mergeQueue(s.url(1)), false, "the first PR reads the fresh reading too");
  assert.equal(s.rulesReads(), 2, "the fresh reading serves every PR on the base");
});

// The counted clock-signature ratchet, judged on in-memory trees: the merged tree carries one more
// counted line than main's recorded row, so the merge into main's tip crosses the ceiling.
const FILE = "src/run-task.ts";
const BASELINE = "scripts/clock-signature-baseline.json";
function memoryInputs(merged: { count: number; row: number }, main: { count: number; row: number }): MergedRatchetInputs {
  const text = (n: number) => `${Array.from({ length: n }, (_, i) => `Date.now(); // l${i}`).join("\n")}\n`;
  const tree = (s: { count: number; row: number }) => (p: string) =>
    (p === FILE ? text(s.count) : p === BASELINE ? JSON.stringify({ [FILE]: { dateNow: s.row, legacy: 0, newDate: 0 } }) : null);
  return { mainSha: "main-sha", headSha: "head-sha", changed: [FILE, BASELINE], measuredFiles: [FILE, BASELINE], populationFiles: [FILE],
    readMerged: tree(merged), readMain: tree(main) };
}
const CROSSING = judgeMergedRatchets(memoryInputs({ count: 302, row: 301 }, { count: 301, row: 301 }));

function armDeps(calls: string[], mergeQueue: ArmDeps<true>["mergeQueue"], over: Partial<ArmDeps<true>>): ArmDeps<true> {
  return {
    headSha: () => "head-sha",
    ledgerLines: () => [],
    armAuto: () => { calls.push("armAuto"); },
    mergeDirect: () => { calls.push("mergeDirect"); },
    disableAuto: () => { calls.push("disableAuto"); },
    enqueue: () => { calls.push("enqueue"); },
    updateBranch: () => { calls.push("updateBranch"); return { ok: true }; },
    isMerged: () => false,
    say: () => {},
    mergeQueue,
    ...over,
  } as ArmDeps<true>;
}

/** The queue reads on at t0 and goes off after it; `pr` first reads at t0+TTL-1, and the clock then
 *  stands at t0+TTL, where the t0 reading must no longer answer. */
async function spentReading(t: TestContext, repo: string, pr: number) {
  let now = 9_000_000;
  t.mock.method(systemClock, "now", () => now);
  const s = scene(t, "fixture-owner", repo, [1, pr]);
  const t0 = now;
  assert.equal(await s.mergeQueue(s.url(1)), true, "another PR on the base reads the queue at t0");
  s.queueOff();
  now = t0 + MERGE_QUEUE_READ_TTL_MS - 1;
  assert.equal(await s.mergeQueue(s.url(pr)), true, "positive control: the PR first reads the t0 reading");
  now = t0 + MERGE_QUEUE_READ_TTL_MS;
  return s;
}

test("W1-T14239 criterion 2: after the queue goes off and the TTL passes, a plan PR takes the plan-PR path, with no armAuto call", async (t) => {
  const s = await spentReading(t, "w1-t14239-plan", 11);
  const calls: string[] = [];
  const plan = await attemptArmAsync(s.url(11), armDeps(calls, s.mergeQueue, {
    readPlanTouch: () => "touched",
    readMergeFacts: () => ({ mergeable: "MERGEABLE", behindBy: 0, mergeableState: "blocked" }),
  }), "head-sha");
  assert.equal(plan.outcome, "plan-pr-held", "the plan PR takes the W1-T5615 plan-PR path");
  assert.equal(plan.directMergePreflight?.planTouch, "touched");
  assert.ok(!calls.includes("armAuto") && !calls.includes("enqueue"), "a plan PR is never armed");
});

test("W1-T14239 criterion 2: after the queue goes off and the TTL passes, a colliding code PR is held, with no armAuto call", async (t) => {
  const s = await spentReading(t, "w1-t14239-code", 12);
  const calls: string[] = [];
  const code = await attemptArmAsync(s.url(12), armDeps(calls, s.mergeQueue, {
    readPlanTouch: () => "untouched",
    readMergeFacts: () => ({ mergeable: "MERGEABLE", mergeableState: "clean", behindBy: 7 }),
    readMergedRatchets: () => CROSSING,
  }), "head-sha");
  assert.equal(code.outcome, "direct-merge-updated", "the colliding code PR is held by the W1-T9962 ratchet-collision hold");
  assert.equal(code.directMergePreflight?.reason, "ratchet_collision");
  assert.deepEqual(calls, ["updateBranch"], "updated once; never armed");
});
