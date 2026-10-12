import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { fixedClock } from "../src/lib/clock.js";
import { runGarden, runGardenAsync, type GardenCheckout, type GardenSpec } from "../src/lib/gardener.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import * as worker from "../src/lib/worker.js";
import * as gardens from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo } from "./helpers/git-repo.js";

type Row = [string, Record<string, unknown> | undefined];
const PR = "https://github.com/acme/demo/pull/7";
const landing = { paths: ["change.txt"], title: "chore(plan): tend the fixture", body: "fixture" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t5787-`));
  const origin = gitRepo({ bare: true, kind: "t5787-origin" });
  const seed = gitRepo({ kind: "t5787-seed" });
  seed.addRemote("origin", origin.dir);
  seed.git("push", "-q", "origin", "main");
  const repo = gitRepo({ cloneFrom: origin.dir, kind: "t5787-clone" });
  repo.git("config", "user.name", GIT_REPO_FIXTURE_IDENTITY.name);
  repo.git("config", "user.email", GIT_REPO_FIXTURE_IDENTITY.email);
  const rows: Row[] = [];
  const opts: gardens.GardenCheckoutOpts = {
    name: "plan", repoDir: repo.dir, worktreesRoot: join(root, "worktrees"),
    owner: "acme", repo: "demo", clock: fixedClock(1790000000777),
    log: (step, extra) => { rows.push([step, extra]); },
    preflight: () => ({ ok: true, failures: [], unreadable: [] }),
  };
  const events = join(root, "git-events");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh
case "$*" in
  *"worktree remove"*|*"--delete"*)
    echo start >> '${events}'
    sleep 0.15
    '${realGit}' "$@"
    rc=$?
    echo end >> '${events}'
    exit "$rc" ;;
  *) exec '${realGit}' "$@" ;;
esac
`, { mode: 0o755 });
  return {
    root, origin, repo, opts, rows, bin,
    reset: () => rmSync(events, { force: true }),
    inFlight: () => existsSync(events) && readFileSync(events, "utf8").trimEnd().endsWith("start"),
    heads: () => origin.git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean),
    close: () => {
      [origin, seed, repo].forEach((item) => item.cleanup());
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function withPath<T>(dirs: string[], run: () => Promise<T>): Promise<T> {
  const prior = process.env.PATH;
  process.env.PATH = [...dirs, prior].join(":");
  try { return await run(); }
  finally {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
  }
}

async function during<T>(inFlight: () => boolean, run: () => Promise<T>): Promise<T> {
  let ticks = 0;
  const timer = setInterval(() => { if (inFlight()) ticks++; }, 5);
  try {
    const result = await run();
    assert.ok(ticks > 0, "a timer fired before the child settled");
    return result;
  } finally { clearInterval(timer); }
}

describe("test/a-gardens-async-checkout-lands-and-disposes-off-the-loop.test.ts", () => {
  test("async disposal yields during real removal and removes the same base record", async () => {
    const f = fixture();
    const ws = await gardens.gardenCheckoutAsync(f.opts);
    try {
      assert.ok(existsSync(worker.worktreeBasePath(ws.root)));
      await withPath([f.bin], () => during(f.inFlight, () => ws.dispose()));
      assert.equal(existsSync(ws.root), false);
      assert.equal(existsSync(worker.worktreeBasePath(ws.root)), false);
      const missing = join(f.root, "missing");
      worker.recordWorktreeBase(missing, "keep-on-refusal");
      f.reset();
      await withPath([f.bin], () => during(f.inFlight, async () => {
        await assert.rejects(worker.worktreeRemoveAsync(f.repo.dir, missing), /worktree|working tree/);
      }));
      assert.equal(worker.readWorktreeBase(missing), "keep-on-refusal");
    } finally { f.close(); }
  });

  test("async landing yields during the default REST create and preserves its reference", async () => {
    const f = fixture();
    const github = ghShim([{ when: "POST", stdout: JSON.stringify({ html_url: PR, number: 7 }), delaySeconds: 0.15 }]);
    const ws = await gardens.gardenCheckoutAsync(f.opts);
    writeFileSync(join(ws.root, "change.txt"), "tended\n");
    try {
      const inFlight = () => {
        const events = github.events();
        return events.some((start) => start.phase === "start" && !events.some((end) => end.id === start.id && end.phase === "end"));
      };
      const url = await withPath([github.dir], () => withLiveWritesAllowed(() => during(inFlight, () => ws.land(landing))));
      assert.equal(url, PR);
      assert.ok(f.heads().includes(ws.branch!));
      assert.equal(github.calls().length, 1);
      assert.ok(github.calls()[0].includes(`head=${ws.branch}`));
    } finally {
      await ws.dispose();
      f.close();
      rmSync(github.dir, { recursive: true, force: true });
    }
  });

  test("failed async creation awaits the REST probe and real branch deletion", async () => {
    const f = fixture();
    const github = ghShim([
      { when: "POST", stderr: "fixture create refused", exit: 2, delaySeconds: 0.15 },
      { when: "head=", stdout: "[]", delaySeconds: 0.15 },
    ]);
    const ws = await gardens.gardenCheckoutAsync(f.opts);
    writeFileSync(join(ws.root, "change.txt"), "tended\n");
    const observed = new Set<number>();
    const timer = setInterval(() => {
      const events = github.events();
      events.filter((row) => row.phase === "start" && !events.some((end) => end.id === row.id && end.phase === "end")).forEach((row) => observed.add(row.id));
    }, 5);
    try {
      await withPath([f.bin, github.dir], () => withLiveWritesAllowed(() => during(f.inFlight, async () => {
        await assert.rejects(ws.land(landing), /fixture create refused/);
      })));
      assert.deepEqual(f.heads(), ["main"]);
      const started = github.events().filter((row) => row.phase === "start");
      assert.equal(started.length, 2, "both create and probe reached the real transport");
      assert.ok(started.every((row) => observed.has(row.id)), "the loop serviced both children");
      assert.deepEqual(f.rows.filter(([step]) => step.includes("garden_head")), [["plan.garden_head_deleted", { branch: ws.branch }]]);
    } finally {
      clearInterval(timer);
      await ws.dispose();
      f.close();
      rmSync(github.dir, { recursive: true, force: true });
    }
  });

  test("sync and async retraction preserve every outcome and recorded row", async () => {
    for (const scenario of ["deleted", "pr", "unreadable", "delete-failed"] as const) {
      const sync: Row[] = [], async: Row[] = [];
      let syncDeletes = 0, asyncDeletes = 0;
      const fetcher = () => {
        if (scenario === "unreadable") throw new Error("probe refused");
        return scenario === "pr" ? [{ html_url: PR, number: 7 }] : [];
      };
      const git = () => {
        if (scenario === "delete-failed") throw new Error("delete refused");
        return "";
      };
      const base = { branch: "plan-garden-1", name: "plan", owner: "acme", repo: "demo" };
      const expected = gardens.retractGardenBranch({ ...base, fetcher, git: () => { syncDeletes++; return git(); }, log: (s, e) => { sync.push([s, e]); } });
      const actual = await gardens.retractGardenBranchAsync({ ...base, fetcher: async () => fetcher(), git: async () => { asyncDeletes++; return git(); }, log: (s, e) => { async.push([s, e]); } });
      assert.equal(actual, expected, scenario);
      assert.deepEqual(async, sync, scenario);
      assert.equal(asyncDeletes, syncDeletes, scenario);
    }
  });

  test("async landing retains malformed-response and preflight refusals", async () => {
    const malformed = fixture();
    const ws = await gardens.gardenCheckoutAsync({ ...malformed.opts, fetcher: async () => ({}) });
    writeFileSync(join(ws.root, "change.txt"), "tended\n");
    try {
      await withLiveWritesAllowed(() => assert.rejects(ws.land(landing), /produced no html_url\/number/));
      assert.deepEqual(malformed.heads(), ["main"]);
      assert.deepEqual(malformed.rows.filter(([step]) => step.includes("garden_head")), [["plan.garden_head_deleted", { branch: ws.branch }]]);
    } finally { await ws.dispose(); malformed.close(); }

    const refused = fixture();
    let creates = 0;
    const blocked = await gardens.gardenCheckoutAsync({
      ...refused.opts,
      fetcher: async () => { creates++; return { html_url: PR, number: 7 }; },
      preflight: () => ({ ok: false, failures: [{ check: "tree", firstLine: "fixture refused" }], unreadable: [] }),
    });
    writeFileSync(join(blocked.root, "change.txt"), "tended\n");
    try {
      assert.equal(await withLiveWritesAllowed(() => blocked.land(landing)), undefined);
      assert.equal(creates, 0);
      assert.deepEqual(refused.heads(), ["main"]);
      assert.deepEqual(refused.rows.find(([step]) => step === "plan_pr.preflight_refused"), [
        "plan_pr.preflight_refused", { lane: "plan", branch: blocked.branch, failures: [{ check: "tree", firstLine: "fixture refused" }] },
      ]);
    } finally { await blocked.dispose(); refused.close(); }
  });

  test("sync and async garden passes preserve recorded rows and state", async () => {
    const spec: GardenSpec<"refresh", number, { class: "refresh"; target: string; reason: string }, GardenCheckout> = {
      name: "plan", classes: ["refresh"], cheapFingerprint: () => "cheap", inventory: () => 1,
      fingerprint: () => "full", metric: () => ({ trials: 0, successes: 0 }),
      candidates: () => [{ class: "refresh", target: "fixture", reason: "tend" }],
      scorecard: () => ({ changed: 1 }),
      apply: (ws) => { writeFileSync(join(ws.root, "change.txt"), "tended\n"); return landing; },
    };
    const sync = fixture(), async = fixture();
    const syncRows: Row[] = [], asyncRows: Row[] = [];
    const fetcher = () => ({ html_url: PR, number: 7 });
    const shared = { clock: sync.opts.clock, seed: 1 };
    try {
      const expected = withLiveWritesAllowed(() => runGarden(spec, {
        ...shared, stateDir: sync.root, repoRoot: sync.repo.dir,
        openWorkspace: () => gardens.gardenCheckout({ ...sync.opts, fetcher }),
        log: (s, e) => { syncRows.push([s, e]); },
      }));
      const actual = await withLiveWritesAllowed(() => runGardenAsync(spec, {
        ...shared, stateDir: async.root, repoRoot: async.repo.dir,
        openWorkspace: () => gardens.gardenCheckoutAsync({ ...async.opts, fetcher: async () => fetcher() }),
        log: (s, e) => { asyncRows.push([s, e]); },
      }));
      assert.equal(actual.prUrl, PR);
      assert.deepEqual(actual, expected);
      assert.ok(syncRows.some(([step]) => step === "plan.scorecard"));
      assert.deepEqual(asyncRows, syncRows);
      assert.equal(readFileSync(join(async.root, "plan-gardener.json"), "utf8"), readFileSync(join(sync.root, "plan-gardener.json"), "utf8"));
    } finally { sync.close(); async.close(); }
  });
});
