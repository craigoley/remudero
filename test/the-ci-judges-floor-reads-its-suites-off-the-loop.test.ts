/**
 * W1-T9544 — the CI judge's floor reads its affected suites off the daemon loop.
 *
 * `productionCiJudgePorts` is the daemon's CI judge: once per due PR it reads the selector floor (git's tracked
 * files plus diff-class's listing children) and the suite ids (git's tracked test files). On 2026-10-14 the floor's
 * synchronous listing child froze core's loop for 122.7 s in 6 h, one block 27.9 s. These tests drive the REAL
 * default ports over a temp git repo, with the synchronous child primitives trapped the way
 * `startReadPlaneTelemetry`'s tests trap them (`syncBuiltinESMExports`).
 */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { affectedSelectionOrFull, readAffectedSuitesInput } from "#src/lib/affected-suites.js";
import { judgeCiEscalation, productionCiJudgePorts, type CiJudgePorts } from "#src/lib/ci-escalation-judge.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const SUITE = "test/example.test.ts";
const CHANGED = "src/example.ts";
const REPLY = JSON.stringify({ add: [], escalateFull: false, reason: "floor is sufficient" });
const TRAP = "synchronous child forbidden";

function judgeFixture(t: { after: (fn: () => void) => void }) {
  const repo = gitRepo({ kind: "ci-judge-floor" });
  t.after(() => repo.cleanup());
  mkdirSync(join(repo.dir, "src"));
  mkdirSync(join(repo.dir, "test"));
  writeFileSync(join(repo.dir, CHANGED), "export const value = 1;\n");
  writeFileSync(join(repo.dir, SUITE), 'import { value } from "../src/example.js";\nexport { value };\n');
  repo.git("add", "src", "test");
  repo.git("commit", "-q", "-m", "feat: fixture");
  return repo;
}

/** The real production ports with the network and the model forbidden: only the floor and suite-id defaults run. */
function offlinePorts(repoRoot: string): CiJudgePorts {
  const forbidden = async (): Promise<never> => { throw new Error("network or provider use forbidden"); };
  return productionCiJudgePorts({ owner: "fixture", repo: "fixture", repoRoot, stateDir: repoRoot, log: () => {},
    ghJson: forbidden, ghText: forbidden, spawn: forbidden });
}

/** Runs `body` with execFileSync, execSync and spawnSync replaced by a throw, in ESM bindings too. */
async function withSyncChildrenTrapped<T>(body: () => Promise<T>): Promise<T> {
  const names = ["execFileSync", "execSync", "spawnSync"] as const;
  const originals = names.map((name) => childProcess[name]);
  try {
    for (const name of names) Object.assign(childProcess, { [name]: () => { throw new Error(`${TRAP}: ${name}`); } });
    syncBuiltinESMExports();
    return await body();
  } finally {
    names.forEach((name, index) => Object.assign(childProcess, { [name]: originals[index] }));
    syncBuiltinESMExports();
  }
}

test("W1-T9544: the CI judge default floor and suite ids make no synchronous spawn", async (t) => {
  const repo = judgeFixture(t);
  const ports = offlinePorts(repo.dir);
  await withSyncChildrenTrapped(async () => {
    // Positive control: the trap reaches the live path — the synchronous reader under it is a FULL run naming the trap.
    const trapped = affectedSelectionOrFull([CHANGED], () => readAffectedSuitesInput(repo.dir, [CHANGED]));
    assert.equal(trapped.fullRun, true, "the trap must stop the synchronous reader, or this test proves nothing");
    assert.match(("reasons" in trapped ? trapped.reasons : []).join(" "), new RegExp(TRAP));

    const floor = await ports.floor([CHANGED]);
    const reasons = ("reasons" in floor && Array.isArray(floor.reasons) ? floor.reasons : []).join(" ");
    assert.equal(floor.fullRun, false, `the default floor made a synchronous spawn: ${reasons}`);
    assert.ok(floor.suites.includes(SUITE), `the floor selects the suite that imports the changed file; got ${floor.suites.join(", ")}`);
    assert.deepEqual(await ports.suiteIds(), [SUITE]);
  });
});

/** Puts a real `git` first on PATH that sleeps `sleepS` before the floor's tracked-file listing (its
 *  `-- src scripts bin test` tail; it drops a marker), then runs the real git: the read is slow for real, as on core. */
async function withSlowListing<T>(t: { after: (fn: () => void) => void }, sleepS: number, body: (marker: string) => Promise<T>): Promise<T> {
  const realGit = childProcess.execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}ci-judge-slowgit-`));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const marker = join(bin, "listing-slept");
  writeFileSync(join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" -- src scripts bin test "*) : > '${marker}'; sleep ${sleepS} ;; esac\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ""}`;
  try {
    return await body(marker);
  } finally {
    process.env.PATH = path;
  }
}

test("W1-T9544: a slow floor read does not delay a concurrent timer", async (t) => {
  const repo = judgeFixture(t);
  let judgedAt = 0;
  const ports: CiJudgePorts = {
    ...offlinePorts(repo.dir),
    openPrs: async () => [{ number: 7, headSha: "head-7" }],
    changedFiles: async () => [CHANGED], diff: async () => "diff",
    judge: async () => { judgedAt = performance.now(); return REPLY; }, post: async () => {},
  };
  const sleepS = 1;
  const intervalMs = 10;
  const ticks: number[] = [];
  const { result, start, marker } = await withSlowListing(t, sleepS, async (marker) => {
    const start = performance.now();
    const timer = setInterval(() => { ticks.push(performance.now()); }, intervalMs);
    try {
      return { result: await judgeCiEscalation(ports), start, marker };
    } finally {
      clearInterval(timer);
    }
  });
  assert.deepEqual(result, { off: false, judged: [7], failed: [] }, "the pass judged the PR on the real default floor");

  // Positive control: the slow child really ran inside the floor read, which is read before the model is asked.
  const readMs = judgedAt - start;
  assert.ok(existsSync(marker), "the slow listing child must run inside the floor read, or this test proves nothing");
  assert.ok(readMs >= sleepS * 1000, `the floor read (${readMs.toFixed(0)} ms) spans the slow child's ${sleepS} s`);
  const during = ticks.filter((at) => at < judgedAt);
  const marks = [start, ...during, judgedAt];
  const longestGap = Math.max(...marks.slice(1).map((at, i) => at - marks[i]!));
  assert.ok(during.length > 0, `the concurrent timer recorded no tick during the ${readMs.toFixed(0)} ms floor read`);
  assert.ok(longestGap < readMs / 2,
    `the concurrent timer stalled ${longestGap.toFixed(0)} ms of a ${readMs.toFixed(0)} ms floor read (${during.length} tick(s))`);
});

test("W1-T9544: a failed floor read is a FULL run naming its cause", async (t) => {
  // A real checkout whose index is corrupt: git itself refuses the tracked-file listing, for a cause of its own.
  const repo = judgeFixture(t);
  writeFileSync(join(repo.dir, ".git", "index"), "not an index\n");
  const ports = offlinePorts(repo.dir);
  await withSyncChildrenTrapped(async () => {
    const floor = await ports.floor([CHANGED]);
    assert.equal(floor.fullRun, true, "an unreadable floor is a FULL run, never a narrower guess");
    assert.deepEqual(floor.suites, []);
    const reasons = ("reasons" in floor && Array.isArray(floor.reasons) ? floor.reasons : []) as string[];
    assert.equal(reasons.length, 1, `one named cause; got ${JSON.stringify(reasons)}`);
    assert.match(reasons[0]!, /^full run: the selector could not read its input — /);
    assert.doesNotMatch(reasons[0]!, new RegExp(TRAP), "the cause is git's own refusal, not a synchronous spawn");
    assert.match(reasons[0]!, /index/, "the reason names git's own cause: the corrupt index");
  });
});
