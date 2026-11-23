import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  landingIdentity,
  landPlanReconcileShards,
  landPlanReconcileShardsAsync,
  type LandContentInput,
  type LandFeedbackOpts,
  type LandFeedbackResult,
  type LandingRepository,
} from "#src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { reconcileShardStatus } from "#src/lib/plan-reconcile.js";
import { withGhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

// W1-T14313: a plan-reconcile batch whose every input is refused rebuilds main's tree, while the
// landing branch still holds an older batch's status flip. The landing runs against a real bare
// origin; only `gh` is faked, and it records every call.

const TARGET: LandingRepository = { owner: "o", repo: "r" };
const OWNER = "w1-t14313-fixture";
const BRANCH = landingIdentity({ family: "plan-reconcile", targetRepository: TARGET, landingOwner: OWNER }).branch;
const PR = "https://github.com/o/r/pull/14313";
const MERGED_PR = "https://github.com/o/r/pull/14300";

const shard = (id: string, status = "queued"): string => `- id: ${id}\n  title: ${id} fixture\n  status: ${status}\n`;
const pathOf = (id: string): string => `plan/tasks.d/${id}-fixture.yaml`;
const flip = (text: string, id: string): string => {
  const out = reconcileShardStatus(text, id, () => true).text;
  assert.ok(out !== undefined);
  return out;
};
const statusInput = (id: string): LandContentInput => ({
  relPath: pathOf(id),
  content: flip(shard(id), id),
  edit: (current) => reconcileShardStatus(current, id, () => true).text,
});

interface World {
  origin: GitRepo;
  root: string;
  rows: Array<{ step: string; extra?: Record<string, unknown> }>;
  main(files: Record<string, string | null>, message: string): string;
  /** Push a landing tip cut from `base` (default: main now) that writes `files`. */
  tip(files: Record<string, string>, base?: string): string;
  branchSha(): string;
  opts(): LandFeedbackOpts;
}

function world(t: TestContext): World {
  const origin = gitRepo({ scope: t, bare: true, kind: "t14313-origin" });
  const seed = gitRepo({ scope: t, kind: "t14313-seed" });
  seed.addRemote("origin", origin.dir);
  const rows: World["rows"] = [];
  const write = (repo: GitRepo, files: Record<string, string | null>, message: string): void => {
    for (const [path, content] of Object.entries(files)) {
      const abs = join(repo.dir, path);
      if (content === null) rmSync(abs);
      else {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    repo.git("add", "-A");
    repo.git("commit", "--quiet", "--allow-empty", "-m", message);
  };
  const w: World = {
    origin,
    root: "",
    rows,
    main(files, message) {
      write(seed, files, message);
      seed.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
      return seed.git("rev-parse", "HEAD");
    },
    tip(files, base) {
      const repo = gitRepo({ scope: t, cloneFrom: origin.dir, kind: "t14313-tip" });
      if (base) repo.git("checkout", "--quiet", "--detach", base);
      write(repo, files, "an earlier reconcile batch");
      repo.git("push", "--quiet", "origin", `HEAD:refs/heads/${BRANCH}`);
      return repo.git("rev-parse", "HEAD");
    },
    branchSha: () => origin.git("rev-parse", `refs/heads/${BRANCH}`),
    opts: () => ({
      targetRepository: TARGET,
      landingOwner: OWNER,
      log: (step, extra) => rows.push({ step, extra }),
      planPrPreflight: () => ({ ok: true, failures: [], unreadable: [] }),
    }),
  };
  return w;
}

/** Main holds shard A; the landing tip flips A against that main; main then moves A to running. */
function staleTipWorld(t: TestContext, ids: string[] = ["W1-T1431"]): World & { tipSha: string } {
  const w = world(t);
  w.main(Object.fromEntries(ids.map((id) => [pathOf(id), shard(id)])), "file the shards");
  const tipSha = w.tip({ [pathOf(ids[0])]: flip(shard(ids[0]), ids[0]) });
  w.main(Object.fromEntries(ids.map((id) => [pathOf(id), shard(id, "running")])), "main moves the shards to running");
  w.root = gitRepo({ scope: t, cloneFrom: w.origin.dir, kind: "t14313-checkout" }).dir;
  return Object.assign(w, { tipSha });
}

const openList = (url: string, head: string): GhShimRoute => ({ when: "--state open", stdout: JSON.stringify([{ url, headRefOid: head }]) });
/** The shim logs one line per argv line, so a multi-line comment follows its `pr close` line; close is the last call. */
const closeText = (calls: string[]): string => {
  const at = calls.findIndex((c) => c.startsWith("pr close"));
  return at < 0 ? "" : calls.slice(at).join("\n");
};
const noopRows = (w: World) => w.rows.filter((r) => r.step === "landing.nothing_to_land");

function land(w: World, routes: GhShimRoute[], inputs: LandContentInput[]): Promise<{ result: LandFeedbackResult; calls: string[] }> {
  return withGhShim(routes, async (shim) => {
    const result = await withLiveWritesAllowed(() => landPlanReconcileShardsAsync(w.root, inputs, w.opts()));
    return { result, calls: shim.calls() };
  });
}

test("W1-T14313 criterion 1: a wholly refused batch closes the open landing PR on the stale tip once, naming the refusal", async (t) => {
  const w = staleTipWorld(t);
  const a = pathOf("W1-T1431");

  const { result, calls } = await withGhShim([openList(PR, w.tipSha), { when: "pr close", stdout: "" }], (shim) => {
    const landed = withLiveWritesAllowed(() => landPlanReconcileShards(w.root, [statusInput("W1-T1431")], w.opts()));
    return { result: landed, calls: shim.calls() };
  });

  assert.equal(result.landed, false);
  assert.equal(result.error, undefined);
  assert.equal(result.pushed, undefined, "nothing was pushed");
  assert.deepEqual(result.refused?.map((r) => r.path), [a]);
  const reason = result.refused?.[0].reason ?? "";
  assert.match(reason, /status-not-queued/);
  const closes = calls.filter((c) => c.startsWith("pr close"));
  assert.equal(closes.length, 1, "the PR is closed once");
  assert.ok(closes[0].startsWith(`pr close ${PR} --comment `));
  assert.ok(closeText(calls).includes(`\n- ${a}: ${reason}`), "the comment names A and its refusal reason");
  assert.ok(!closes[0].includes("--delete-branch"));
  assert.equal(w.branchSha(), w.tipSha, "the landing branch still points at the old tip");
});

test("W1-T14313 criterion 2: a PR whose head is not the tip the build read, or no open PR, is left alone", async (t) => {
  const w = staleTipWorld(t);
  const moved = w.origin.git("rev-parse", "refs/heads/main");
  for (const routes of [[openList(PR, moved)], [{ when: "--state open", stdout: "[]" }]]) {
    w.rows.length = 0;
    const { result, calls } = await land(w, [...routes, { when: "pr close", stdout: "" }], [statusInput("W1-T1431")]);
    assert.equal(result.landed, false);
    assert.equal(result.error, undefined);
    assert.equal(calls.filter((c) => c.startsWith("pr close")).length, 0, "no PR is closed");
    assert.deepEqual(noopRows(w).map((r) => r.extra?.staleTipClosed), [undefined]);
    assert.equal(w.branchSha(), w.tipSha);
  }
});

test("W1-T14313 criterion 3: when the tip's tree is main's tree, a refused batch makes no gh call and an already-landed one still closes the redundant PR", async (t) => {
  const w = world(t);
  const id = "W1-T1433";
  w.main({ [pathOf(id)]: shard(id, "running") }, "file a running shard");
  const mainSha = w.origin.git("rev-parse", "refs/heads/main");
  const emptyTip = w.tip({});
  assert.equal(w.origin.git("rev-parse", `${emptyTip}^{tree}`), w.origin.git("rev-parse", `${mainSha}^{tree}`));
  w.root = gitRepo({ scope: t, cloneFrom: w.origin.dir, kind: "t14313-checkout" }).dir;

  const refused = await land(w, [openList(PR, emptyTip)], [statusInput(id)]);
  assert.equal(refused.result.landed, false);
  assert.equal(refused.result.error, undefined);
  assert.equal(refused.result.refused?.length, 1);
  assert.deepEqual(refused.calls, [], "a wholly refused landing makes no gh call (W1-T9425)");

  const merged: GhShimRoute = { when: "--state merged", stdout: JSON.stringify([{ url: MERGED_PR, mergeCommit: { oid: mainSha } }]) };
  const already = await land(w, [merged, openList(PR, emptyTip), { when: "pr close", stdout: "" }],
    [{ relPath: pathOf(id), content: shard(id, "running") }]);
  assert.equal(already.result.landed, false);
  assert.equal(already.result.error, undefined);
  const closes = already.calls.filter((c) => c.startsWith("pr close"));
  assert.equal(closes.length, 1, "closeRedundantLandingPr still runs");
  assert.ok(closes[0].includes(`Content already landed in ${MERGED_PR}`));
  assert.deepEqual(noopRows(w).map((r) => r.extra?.staleTipClosed), [undefined, undefined]);
  assert.equal(w.branchSha(), emptyTip);
});

test("W1-T14313 criterion 4: a failed close reports its reason and pushes nothing; only a successful close adds staleTipClosed", async (t) => {
  const w = staleTipWorld(t);
  const failed = await land(w, [openList(PR, w.tipSha), { when: "pr close", stderr: "GraphQL: close refused", exit: 1 }],
    [statusInput("W1-T1431")]);
  assert.equal(failed.result.landed, false);
  assert.ok(failed.result.error?.startsWith("stale landing PR cleanup failed:"), failed.result.error);
  assert.equal(failed.result.pushed, undefined);
  assert.equal(w.branchSha(), w.tipSha, "nothing was pushed");
  assert.deepEqual(noopRows(w).map((r) => r.extra), [{ family: "plan-reconcile", branch: BRANCH, mainSha: w.origin.git("rev-parse", "refs/heads/main") }]);

  w.rows.length = 0;
  const closed = await land(w, [openList(PR, w.tipSha), { when: "pr close", stdout: "" }], [statusInput("W1-T1431")]);
  assert.equal(closed.result.error, undefined);
  assert.deepEqual(noopRows(w).map((r) => r.extra?.staleTipClosed), [PR]);
});

test("W1-T14313 criterion 5: the comment names at most 5 refused paths with their reasons, then 'and N more'", async (t) => {
  const ids = ["W1-T14351", "W1-T14352", "W1-T14353", "W1-T14354", "W1-T14355", "W1-T14356", "W1-T14357"];
  const w = staleTipWorld(t, ids);
  const { result, calls } = await land(w, [openList(PR, w.tipSha), { when: "pr close", stdout: "" }], ids.map(statusInput));
  assert.equal(result.refused?.length, 7);
  assert.equal(calls.filter((c) => c.startsWith("pr close")).length, 1, "the PR was closed");
  const close = closeText(calls);
  const refused = result.refused ?? [];
  for (const r of refused.slice(0, 5)) assert.ok(close.includes(`- ${r.path}: ${r.reason}`), r.path);
  for (const r of refused.slice(5)) assert.ok(!close.includes(r.path), `${r.path} is not named`);
  assert.ok(close.endsWith("\nand 2 more --repo o/r"), JSON.stringify(close));
});
