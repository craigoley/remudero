import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { LANDING_BRANCH, landFeedback, landFeedbackStatusContent } from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";

function fixture(t: TestContext) {
  const origin = gitRepo({ bare: true });
  const seed = gitRepo();
  seed.addRemote("origin", origin.dir);
  seed.git("push", "--quiet", "origin", "main");
  const root = gitRepo({ cloneFrom: origin.dir });
  t.after(() => { root.cleanup(); seed.cleanup(); origin.cleanup(); });
  const path = "plan/feedback/fb-empty-landing.yaml";
  const content = "id: fb-empty-landing\nraw: durable record\n";
  mkdirSync(join(root.dir, "plan/feedback"), { recursive: true });
  writeFileSync(join(root.dir, path), content);
  const calls: string[][] = [];
  const gitCalls: string[][] = [];
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const pr = "https://github.com/o/r/pull/9425";
  const mergedPr = "https://github.com/o/r/pull/9400";
  let open = false;
  const gh = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      if (args.includes("merged")) return JSON.stringify([{ url: mergedPr, mergeCommit: { oid: origin.git("rev-parse", "main") } }]);
      return JSON.stringify(open ? [{ url: pr, headRefOid: origin.git("rev-parse", LANDING_BRANCH) }] : []);
    }
    if (args[0] === "pr" && args[1] === "create") { open = true; return pr; }
    if (args[0] === "pr" && args[1] === "close") { open = false; return ""; }
    if (args[0] === "api" && args.includes("PATCH")) return "{}";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  const git = (args: string[], opts?: { env?: NodeJS.ProcessEnv }): string => {
    gitCalls.push(args);
    return execFileSync("git", ["-C", root.dir, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: opts?.env ?? process.env,
    });
  };
  const opts = { git, gh, log: (step: string, extra?: Record<string, unknown>) => logs.push({ step, extra }),
    planPrPreflight: () => ({ ok: true, failures: [], unreadable: [] }) };
  const first = withLiveWritesAllowed(() => landFeedback(root.dir, opts));
  assert.equal(first.landed, true, first.error);
  const tip = origin.git("rev-parse", LANDING_BRANCH);
  calls.length = 0;
  gitCalls.length = 0;
  const merge = () => {
    origin.git("update-ref", "refs/heads/main", tip);
    root.git("fetch", "origin", "--quiet");
  };
  const assertNoPublication = (expectedTip = tip) => {
    assert.equal(gitCalls.filter(args => args[0] === "push").length, 0);
    assert.equal(gitCalls.filter(args => args.includes("commit-tree")).length, 0);
    assert.equal(calls.filter(args => args[0] === "pr" && args[1] === "create").length, 0);
    assert.equal(origin.git("rev-parse", LANDING_BRANCH), expectedTip);
    assert.deepEqual(logs.filter(row => row.step === "landing.nothing_to_land"), [{
      step: "landing.nothing_to_land", extra: { family: "feedback", branch: LANDING_BRANCH, mainSha: tip },
    }]);
  };
  return { origin, root, path, content, opts, calls, gitCalls, logs, git, merge, tip, pr, mergedPr, assertNoPublication };
}

test("W1-T9425: a landing whose rebuilt tree equals origin/main pushes nothing and opens no PR", (t) => {
  const f = fixture(t);
  let merged = false;
  const result = withLiveWritesAllowed(() => landFeedback(f.root.dir, {
    ...f.opts,
    git: (args, opts) => {
      if (!merged && args[0] === "rev-parse" && args[1] === "origin/main") {
        merged = true;
        f.merge();
      }
      return f.git(args, opts);
    },
  }));
  assert.equal(merged, true, "main advances before the scratch-index rebuild");
  assert.equal(result.landed, false, result.error);
  assert.deepEqual(result.files, []);
  assert.equal(result.error, undefined);
  f.assertNoPublication();
});

test("W1-T9425: a rebuild after a lost lease that equals main pushes nothing", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root.dir, "README.md"), "main advanced independently\n");
  f.root.git("add", "README.md");
  f.root.git("commit", "--quiet", "-m", "chore: advance main");
  f.root.git("push", "--quiet", "origin", "main");
  let attempts = 0;
  // A revised record, so the push is needed (W1-T9616: an unchanged one is no longer re-pushed when main moves).
  const revised = f.content.replace("durable record", "durable record, revised");
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, f.path, revised, {
    ...f.opts,
    git: (args, opts) => {
      if (args[0] === "push") {
        attempts++;
        const commit = args.at(-1)!.split(":")[0];
        f.origin.git("fetch", "--quiet", f.root.dir, commit);
        f.origin.git("update-ref", "refs/heads/main", commit);
        f.root.git("fetch", "origin", "--quiet");
        throw new Error("[rejected] (stale info)");
      }
      return f.git(args, opts);
    },
  }));
  assert.equal(attempts, 1);
  assert.equal(result.landed, false, result.error);
  assert.deepEqual(result.files, []);
  assert.equal(result.error, undefined);
  assert.equal(result.leaseMoved?.observed, f.tip);
  assert.equal(f.calls.some(args => args[1] === "create"), false);
  assert.equal(f.calls.length, 0, "a branch whose own tree still differs from main is kept open");
  assert.equal(f.gitCalls.filter(args => args.includes("commit-tree")).length, 1);
  assert.equal(f.logs.filter(row => row.step === "landing.nothing_to_land").length, 1);
  assert.equal(f.origin.git("rev-parse", LANDING_BRANCH), f.tip);
});

test("W1-T9425: an open landing PR with an empty diff is closed and its branch kept", (t) => {
  const f = fixture(t);
  f.merge();
  const emptyHead = f.root.git("commit-tree", `${f.tip}^{tree}`, "-p", f.tip, "-m", "chore: empty landing");
  f.root.git("push", "--quiet", "origin", `${emptyHead}:refs/heads/${LANDING_BRANCH}`);
  const result = withLiveWritesAllowed(() => landFeedback(f.root.dir, f.opts));
  assert.equal(result.landed, false, result.error);
  assert.equal(result.error, undefined);
  const close = f.calls.filter(args => args[0] === "pr" && args[1] === "close");
  assert.equal(close.length, 1);
  assert.equal(close[0][2], f.pr);
  assert.ok(close[0][close[0].indexOf("--comment") + 1].includes(f.mergedPr));
  assert.equal(close[0].includes("--delete-branch"), false);
  f.assertNoPublication(emptyHead);
});

test("W1-T9425: an empty local list still lands records carried from a non-main branch tree", (t) => {
  const f = fixture(t);
  const path = "plan/feedback/already-on-main.txt";
  writeFileSync(join(f.root.dir, path), "already durable\n");
  f.root.git("add", path);
  f.root.git("commit", "--quiet", "-m", "chore: advance main");
  f.root.git("push", "--quiet", "origin", "main");
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, path, "already durable\n", f.opts));
  assert.equal(result.landed, true, result.error);
  // W1-T9616: the branch already carries exactly this record, so main moving re-pushes nothing.
  assert.equal(result.pushed, false);
  assert.equal(result.unchangedSinceMainMoved, true);
  assert.deepEqual(result.files, []);
  assert.equal(f.origin.git("rev-parse", LANDING_BRANCH), f.tip);
  assert.equal(f.origin.git("show", `${LANDING_BRANCH}:${f.path}`), f.content.trim());
  assert.equal(f.logs.some(row => row.step === "landing.nothing_to_land"), false);
});

test("W1-T9425: a main-tree no-op preserves refused records", (t) => {
  const f = fixture(t);
  f.merge();
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, f.path, "[invalid", f.opts));
  assert.equal(result.landed, false);
  assert.equal(result.error, undefined);
  assert.ok(result.refused);
  assert.equal(result.refused.length, 1);
  assert.equal(result.refused[0].path, f.path);
  assert.match(result.refused[0].reason, /invalid YAML/);
  f.assertNoPublication();
});

test("W1-T9425: a failed redundant PR close reports its reason without pushing", (t) => {
  const f = fixture(t);
  f.merge();
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, f.path, f.content, {
    ...f.opts,
    gh: (args) => {
      if (args[0] === "pr" && args[1] === "close") throw new Error("closing PR transport unavailable");
      return f.opts.gh(args);
    },
  }));
  assert.equal(result.landed, false);
  assert.match(result.error ?? "", /redundant landing PR cleanup failed: closing PR transport unavailable/);
  f.assertNoPublication();
});

test("W1-T9425: a redundant PR is kept when no merged PR can be identified", (t) => {
  const f = fixture(t);
  f.merge();
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, f.path, f.content, {
    ...f.opts,
    gh: (args) => args.includes("merged") ? "[]" : f.opts.gh(args),
  }));
  assert.equal(result.landed, false);
  assert.match(result.error ?? "", /cannot identify the merged PR/);
  assert.equal(f.calls.some(args => args[1] === "close"), false);
  f.assertNoPublication();
});

test("W1-T9425: cleanup leaves a PR alone when its head moved since the build", (t) => {
  const f = fixture(t);
  f.merge();
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, f.path, f.content, {
    ...f.opts,
    gh: () => JSON.stringify([{ url: f.pr, headRefOid: f.root.git("rev-parse", "HEAD") }]),
  }));
  assert.equal(result.landed, false);
  assert.equal(result.error, undefined);
  assert.equal(f.calls.length, 0);
  f.assertNoPublication();
});

test("W1-T9425: a main-tree no-op without an open PR creates nothing", (t) => {
  const f = fixture(t);
  f.merge();
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, f.path, f.content, {
    ...f.opts, gh: () => "[]",
  }));
  assert.equal(result.landed, false);
  assert.equal(result.error, undefined);
  f.assertNoPublication();
});

test("W1-T9425: cleanup names a merged ancestor that carries the landing content", (t) => {
  const f = fixture(t);
  f.merge();
  const base = f.root.git("rev-parse", "HEAD");
  const sibling = f.root.git("commit-tree", `${base}^{tree}`, "-p", base, "-m", "chore: unrelated commit");
  const result = withLiveWritesAllowed(() => landFeedbackStatusContent(f.root.dir, f.path, f.content, {
    ...f.opts,
    gh: (args) => args.includes("merged") ? JSON.stringify([
      { url: "https://github.com/o/r/pull/1" },
      { url: "https://github.com/o/r/pull/2", mergeCommit: { oid: sibling } },
      { url: "https://github.com/o/r/pull/3", mergeCommit: { oid: base } },
      { url: f.mergedPr, mergeCommit: { oid: f.tip } },
    ]) : f.opts.gh(args),
  }));
  assert.equal(result.error, undefined);
  assert.ok(f.calls.find(args => args[1] === "close")?.some(arg => arg.includes(f.mergedPr)));
  f.assertNoPublication();
});
