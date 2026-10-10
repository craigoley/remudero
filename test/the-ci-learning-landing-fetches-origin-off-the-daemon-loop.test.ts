// test/the-ci-learning-landing-fetches-origin-off-the-daemon-loop.test.ts
//
// MEASURED 2026-10-10, core daemon pid 113: the detached ci-learning rung (fired 07:26Z, never `.ran`) held the
// daemon loop from ~08:23Z. The pid's direct children were `git -C <checkout> fetch origin --quiet` and then
// `git grep --no-color -h -E ^[[:space:]]*origin:... origin/main -- plan/tasks.d`, the exact argv of
// `ciLearningLandingSteps`' prologue; its `daemon.pulse` stopped at 08:22:40Z, two exited children sat unreaped
// (a blocked uv loop never reaps), and the progress watchdog's recycle waited on a daemon that could not read it.
//
// `landCiLearningShardsAsync` is the daemon's lander, but its prologue called the SYNC `git` directly, and the
// net seam it handed `landContentSteps` had no async transport, so every "awaited" network verb was the sync one
// a microtask later. THE OBSERVATION is event-loop turns (the W1-T5965 shape): a fetch whose upload-pack marks
// its start, holds SLOW_FETCH_MS and marks its end, and a ticker set before the landing that sees the fetch
// running only if the loop turns while the child is alive. The control runs the sync lander and must never see it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as landing from "../src/lib/feedback-landing.js";
import { ciLearningRecordVerdict, ciLearningShardYaml } from "../src/lib/measurement-cadence.js";
import { buildCiLearningCadenceRunner } from "../src/run-task.js";
import { gitRepo } from "./helpers/git-repo.js";

const { landCiLearningShards, landCiLearningShardsAsync } = landing;

/** How long the fixture's upload-pack holds the fetch's child alive before serving it. */
const SLOW_FETCH_MS = 2_000;

/** A bare origin, a clone whose `origin` fetch runs through a slow upload-pack, and a state root. */
function slowFetchFixture(nonce: string) {
  const seed = gitRepo({ kind: `slowfetch-${nonce}-seed` });
  mkdirSync(join(seed.dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(seed.dir, "plan", "tasks.d", "W1-T1-seed.yaml"), "- id: W1-T1\n  origin: ci-learning:1:seed\n");
  seed.git("add", "-A");
  seed.git("commit", "--quiet", "-m", "chore: seed one filed origin");
  const origin = gitRepo({ bare: true, kind: `slowfetch-${nonce}-origin` });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "HEAD:main");
  const clone = gitRepo({ cloneFrom: origin.dir, kind: `slowfetch-${nonce}-clone` });
  const marks = join(dirname(clone.dir), `${clone.dir.split("/").pop()}-fetch-marks`);
  const uploadPack = join(dirname(clone.dir), `${clone.dir.split("/").pop()}-slow-upload-pack.sh`);
  writeFileSync(
    uploadPack,
    [
      "#!/bin/sh",
      `echo started >> '${marks}'`,
      `sleep ${SLOW_FETCH_MS / 1000}`,
      `echo done >> '${marks}'`,
      'exec git-upload-pack "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(uploadPack, 0o755);
  clone.git("config", "remote.origin.uploadpack", uploadPack);
  const root = mkdtempSync(join(tmpdir(), `rmd-slowfetch-${nonce}-state-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const deps = {
    stateRoot: root,
    mintTaskId: (): string => {
      throw new Error("no draft is offered, so no id may be minted");
    },
    planOrigins: [] as string[],
    renderShard: ciLearningShardYaml,
    recordVerdict: ciLearningRecordVerdict,
    gh: (args: string[]): string => {
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    },
  };
  const marksRead = () => (existsSync(marks) ? readFileSync(marks, "utf8") : "");
  return { clone, marks, marksRead, deps };
}

/** Run `land` with a ticker scheduled first; reports whether a tick landed while the slow fetch was alive. */
async function observeLoop<T>(marks: string, land: () => T | Promise<T>): Promise<{ result: T; sawFetchRunning: boolean }> {
  let sawFetchRunning = false;
  const ticker = setInterval(() => {
    if (existsSync(marks) && readFileSync(marks, "utf8") === "started\n") sawFetchRunning = true;
  }, 20);
  try {
    const result = await land();
    return { result, sawFetchRunning };
  } finally {
    clearInterval(ticker);
  }
}

test("the daemon's ci-learning landing runs its git fetch of origin while a timer set before it fires", async () => {
  const f = slowFetchFixture("async");

  const { result, sawFetchRunning } = await observeLoop(f.marks, () => landCiLearningShardsAsync([], f.clone.dir, f.deps));

  assert.equal(f.marksRead(), "started\ndone\n", "the fetch ran through the slow upload-pack in a real child process");
  assert.ok(sawFetchRunning, "a tick landed while the fetch's child was alive: the sync git was never called for it");
  assert.deepEqual(result, { filed: [], skipped: [], refused: [] });
});

test("control: the sync ci-learning landing holds the loop for the whole git fetch of origin", async () => {
  const f = slowFetchFixture("sync");

  const { result, sawFetchRunning } = await observeLoop(f.marks, () => landCiLearningShards([], f.clone.dir, f.deps));

  assert.equal(f.marksRead(), "started\ndone\n", "the fetch ran through the slow upload-pack in a real child process");
  assert.equal(sawFetchRunning, false, "no tick can land while execFileSync holds the thread");
  assert.deepEqual(result, { filed: [], skipped: [], refused: [] });
});

test("the awaited ci-learning landing still skips a draft whose origin fetched origin/main already holds", async () => {
  const f = slowFetchFixture("held");
  const draft = {
    findingId: "ci-learning:1:seed",
    title: "already filed on main",
    gate: "ci-gate",
    pr: 1,
    prs: [1],
    repairFiles: [],
    dominantRepairFiles: [],
    action: "gate",
    author_class: "machine",
    verify: "human",
    remedySurface: "test",
  } as unknown as Parameters<typeof landCiLearningShardsAsync>[0][number];

  const result = await landCiLearningShardsAsync([draft], f.clone.dir, f.deps);

  assert.deepEqual(result, { filed: [], skipped: ["ci-learning:1:seed"], refused: [] }, "the yielded origin/main read still feeds idempotency");
});

/** One draft the rung would land; its finding id is not on the fixture's main. */
function freshDraft(findingId: string) {
  return {
    findingId,
    title: "teach the ci gate its repaired failure shape",
    gate: "ci-gate",
    pr: 2,
    prs: [2],
    repairFiles: ["src/lib/x.ts"],
    dominantRepairFiles: [{ file: "src/lib/x.ts", prs: 1 }],
    action: "gate",
    author_class: "machine",
    verify: "human",
    remedySurface: "test",
  } as unknown as Parameters<typeof landCiLearningShardsAsync>[0][number];
}

test("the awaited ci-learning landing mints its task id through the async minter, never the sync one", async () => {
  const f = slowFetchFixture("mint");
  const asked: string[] = [];

  const result = await landCiLearningShardsAsync([freshDraft("ci-learning:2:mint")], f.clone.dir, {
    ...f.deps,
    mintTaskIdAsync: async (branch: string) => {
      asked.push(branch);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "W1-T9901";
    },
    recordVerdict: (_content: string, label: string) => ({ ok: false, reason: `fixture refuses ${label}` }),
  } as Parameters<typeof landCiLearningShardsAsync>[2]);

  assert.equal(asked.length, 1, "the reservation is asked once, as an awaited child");
  assert.deepEqual(result.refused, [{ findingId: "ci-learning:2:mint", reason: "fixture refuses ci-learning:W1-T9901" }]);
});

test("the daemon's ci-learning rung reads origin/main's filed origins while a timer set before it fires", async () => {
  const f = slowFetchFixture("merged");
  const shimDir = mkdtempSync(join(tmpdir(), "rmd-slowgrep-shim-"));
  const marks = join(shimDir, "grep-marks");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(shimDir, "git"),
    ["#!/bin/sh", 'case " $* " in *" grep "*)', `  echo started >> '${marks}'`, `  sleep ${SLOW_FETCH_MS / 1000}`, `  echo done >> '${marks}' ;;`, "esac", `exec '${realGit}' "$@"`, ""].join("\n"),
  );
  chmodSync(join(shimDir, "git"), 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${savedPath ?? ""}`;
  try {
    const runner = buildCiLearningCadenceRunner({
      root: f.deps.stateRoot,
      checkoutRoot: f.clone.dir,
      loadWindow: () => ({ prs: [] }) as never,
      loadLessons: () => ({ status: "unreadable" }),
      planOrigins: [],
      recordFire: () => {},
      recordAttempt: () => {},
    } as Parameters<typeof buildCiLearningCadenceRunner>[0]);
    const { result, sawFetchRunning } = await observeLoop(marks, () => runner());
    assert.equal(readFileSync(marks, "utf8"), "started\ndone\n", "the origin/main read ran through the slow git in a real child");
    assert.ok(sawFetchRunning, "a tick landed while the origin/main read's child was alive");
    assert.equal(result.draftCount, 0);
  } finally {
    process.env.PATH = savedPath;
  }
});

test("the daemon's ci-learning rung hands its lander the minter's async reservation", async () => {
  const f = slowFetchFixture("wired");
  const mintAsync = async (): Promise<string> => "W1-T9902";
  const mintTaskId = Object.assign((): string => "W1-T9902", { async: mintAsync });
  let handed: unknown;
  const runner = buildCiLearningCadenceRunner({
    root: f.deps.stateRoot,
    checkoutRoot: f.clone.dir,
    loadWindow: () =>
      ({
        prs: [
          {
            number: 2,
            commits: [
              { sha: "aaa0002", rollup: [{ name: "ci-gate", conclusion: "FAILURE" }], changedFiles: ["src/lib/x.ts"] },
              { sha: "bbb0002", rollup: [{ name: "ci-gate", conclusion: "SUCCESS" }], changedFiles: ["src/lib/x.ts"] },
            ],
          },
        ],
      }) as never,
    loadLessons: () => ({ status: "unreadable" }),
    planOrigins: [],
    mergedOrigins: () => [],
    mintTaskId,
    landShards: (_drafts: unknown, _root: unknown, deps: Record<string, unknown>) => {
      handed = deps.mintTaskIdAsync;
      return { filed: [], skipped: [], refused: [] };
    },
    recordFire: () => {},
    recordAttempt: () => {},
  } as unknown as Parameters<typeof buildCiLearningCadenceRunner>[0]);

  const result = await runner();

  assert.equal(result.draftCount, 1, "the window minted one draft to land");
  assert.equal(handed, mintAsync, "the lander awaits the reservation instead of running it on the loop");
});
