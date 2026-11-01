import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultDepReviewPrMutations, defaultNodePinSyncIo, depReviewCommand, type DepReviewDeps } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { gitRepo } from "./helpers/git-repo.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import { syncNodePinForImageBump, type NodePinSyncIo } from "../src/lib/dep-review.js";
import { hostWorktreeGit } from "../src/lib/worktree-git.js";

const DOCKERFILE = (v: string) => `FROM node:${v}-bookworm-slim\nWORKDIR /app\n`;
const DIFF = "diff --git a/deploy/Dockerfile b/deploy/Dockerfile\n--- a/deploy/Dockerfile\n+++ b/deploy/Dockerfile\n";

function fixture(image: string, pin: string) {
  const root = mkdtempSync(join(tmpdir(), "rmd-node-pin-sync-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const heads = new Map<string, { dockerfile: string; nvmrc: string }>([["a".repeat(40), { dockerfile: DOCKERFILE(image), nvmrc: `${pin}\n` }]]);
  let head = "a".repeat(40);
  const pushes: Array<{ headRef: string; headSha: string; nvmrc: string; subject: string }> = [];
  const statuses: string[] = [];
  const nodePin: NodePinSyncIo = {
    readAtHead: (sha, path) => {
      const tree = heads.get(sha);
      return path === ".nvmrc" ? tree?.nvmrc : tree?.dockerfile;
    },
    commitAndPush: (input) => {
      pushes.push(input);
      const next = "c".repeat(40);
      heads.set(next, { dockerfile: heads.get(input.headSha)!.dockerfile, nvmrc: input.nvmrc });
      head = next;
      return next;
    },
  };
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => 1_000),
    gh: () => ({
      number: 9001, url: "https://github.com/craigoley/remudero/pull/9001",
      title: `build(deps): bump node from ${pin} to ${image} in /deploy`, body: "",
      headRefOid: head, headRefName: "dependabot/docker/deploy/node-24.22.0",
      author: { login: "app/dependabot" },
      statusCheckRollup: [{ name: "ci-gate", conclusion: "FAILURE" }],
    }),
    prDiff: () => DIFF,
    postStatus: (async (args) => { statuses.push(args.state); return { posted: true }; }) as DepReviewDeps["postStatus"],
    arm: () => "armed",
    nodePin,
    prMutations: { comment: () => undefined, close: () => undefined },
    captureMigrationFeedback: (args) => ({ id: args.id }) as never,
  };
  return {
    root, pushes, statuses,
    run: () => depReviewCommand("9001", ["--repo", "remudero"], { ...deps }),
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

test("W1-T6258: the dep-review pass pushes the node pin sync once and leaves a synced head alone", async (t) => {
  const f = fixture("24.22.0", "24.21.0");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  await f.run();
  assert.equal(f.pushes.length, 1, "the drifted pin gets exactly one commit");
  assert.equal(f.pushes[0].headRef, "dependabot/docker/deploy/node-24.22.0");
  assert.equal(f.pushes[0].nvmrc, "24.22.0\n");
  assert.equal(f.pushes[0].subject, "chore(deps): .nvmrc follows the image's Node 24.22.0");
  const synced = f.ledger().filter((r) => r.step === "dep-review.node_pin_synced");
  assert.equal(synced.length, 1);
  assert.equal(synced[0].from, "24.21.0");
  assert.equal(synced[0].to, "24.22.0");
  assert.equal(synced[0].head_sha, "a".repeat(40));
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), false, "the sync returns before any verdict");
  assert.deepEqual(f.statuses, []);

  await f.run();
  assert.equal(f.pushes.length, 1, "a synced head is left alone");
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.node_pin_synced").length, 1);
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), true, "the synced head is judged as usual");
});

test("W1-T6258: a major image bump is ledgered refused and never synced", async (t) => {
  const f = fixture("25.0.0", "24.21.0");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await f.run();
  assert.equal(f.pushes.length, 0);
  const refused = f.ledger().filter((r) => r.step === "dep-review.node_pin_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason, "major");
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), true);
});

test("W1-T6258: unreadable and malformed image-bump inputs are refused without a push", () => {
  const pushes: unknown[] = [];
  const head = { sha: "a".repeat(40), ref: "dependabot/docker/deploy/node" };
  const unreadable = syncNodePinForImageBump(DIFF, head, {
    readAtHead: (_sha, path) => path === "deploy/Dockerfile" ? undefined : "24.21.0\n",
    commitAndPush: (input) => { pushes.push(input); return "b".repeat(40); },
  });
  assert.deepEqual(unreadable, {
    kind: "refused", reason: "unreadable",
    detail: "deploy/Dockerfile, .nvmrc or the head ref could not be read",
  });
  const malformed = syncNodePinForImageBump(DIFF, head, {
    readAtHead: (_sha, path) => path === "deploy/Dockerfile"
      ? "FROM alpine:latest\nFROM node:24.22.0-bookworm-slim\n"
      : "24.21.0\n",
    commitAndPush: (input) => { pushes.push(input); return "b".repeat(40); },
  });
  assert.deepEqual(malformed, {
    kind: "refused", reason: "unreadable",
    detail: "deploy/Dockerfile must carry exactly one `FROM node:<x.y.z>-` line",
  });
  assert.deepEqual(pushes, [], "refused inputs must never attempt a branch write");
});

test("W1-T6258: a failed push is returned as a refusal, not thrown out of the daemon pass", () => {
  const outcome = syncNodePinForImageBump(DIFF, {
    sha: "a".repeat(40), ref: "dependabot/docker/deploy/node",
  }, {
    readAtHead: (_sha, path) => path === ".nvmrc" ? "24.21.0\n" : DOCKERFILE("24.22.0"),
    commitAndPush: () => { throw new Error("lease lost"); },
  });
  assert.deepEqual(outcome, { kind: "refused", reason: "push-failed", detail: "lease lost" });
});

test("W1-T6258: the real node-pin IO reads at the head and pushes the .nvmrc commit through the hardened git leaf", () => {
  // FIXTURES ONLY: a gitRepo() checkout whose origin is a bare temp repository; nothing reaches GitHub.
  const remote = gitRepo({ bare: true, kind: "node-pin-remote" });
  const seed = gitRepo({ kind: "node-pin-seed" });
  seed.addRemote("origin", remote.dir);
  writeFileSync(join(seed.dir, ".nvmrc"), "22.22.3\n");
  seed.git("add", ".nvmrc");
  seed.git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "HEAD:refs/heads/dependabot/docker/deploy/node");
  const head = seed.git("rev-parse", "HEAD").trim();
  const io = defaultNodePinSyncIo(seed.dir);
  assert.equal(io.readAtHead(head, ".nvmrc"), "22.22.3\n");
  assert.equal(io.readAtHead(head, "absent.txt"), undefined, "an unreadable path reads as undefined");
  const pushed = withLiveWritesAllowed(() =>
    io.commitAndPush({ headRef: "dependabot/docker/deploy/node", headSha: head, nvmrc: "24.21.0\n", subject: "chore(deps): sync .nvmrc" }));
  const onRemote = execFileSync("git", ["--git-dir", remote.dir, "rev-parse", "refs/heads/dependabot/docker/deploy/node"], { encoding: "utf8" }).trim();
  assert.equal(onRemote, pushed, "the pushed head is the new commit");
  assert.equal(execFileSync("git", ["--git-dir", remote.dir, "show", `${pushed}:.nvmrc`], { encoding: "utf8" }), "24.21.0\n");
});

test("W1-T6258: scratch-directory removal still succeeds when git worktree removal fails", () => {
  const remote = gitRepo({ bare: true, kind: "node-pin-cleanup-remote" });
  const seed = gitRepo({ kind: "node-pin-cleanup-seed" });
  seed.addRemote("origin", remote.dir);
  writeFileSync(join(seed.dir, ".nvmrc"), "22.22.3\n");
  seed.git("add", ".nvmrc");
  seed.git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "seed");
  seed.git("push", "-q", "origin", "HEAD:refs/heads/dependabot/docker/deploy/node");
  const head = seed.git("rev-parse", "HEAD").trim();
  let scratch: string | undefined;
  const io = defaultNodePinSyncIo(seed.dir, {
    git: (args, cwd) => {
      if (args[0] === "worktree" && args[1] === "add") scratch = dirname(args[5]!);
      if (args[0] === "worktree" && args[1] === "remove") throw new Error("injected git cleanup failure");
      return hostWorktreeGit(cwd || seed.dir, args, { maxBuffer: 1 << 24 });
    },
  });
  withLiveWritesAllowed(() => io.commitAndPush({
    headRef: "dependabot/docker/deploy/node", headSha: head, nvmrc: "24.21.0\n", subject: "chore(deps): sync .nvmrc",
  }));
  assert.ok(scratch, "the scratch path was captured from the actual git worktree-add command");
  assert.equal(existsSync(scratch!), false, "the finally block removes scratch files even when git worktree remove fails");
});

// W1-T9828: the title retitle rides the same pre-verdict block as the node-pin sync.
const LONG_TITLE = "chore(deps): bump google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml from 2.6.0 to 2.7.0 " +
  "in the actions-minor-and-patch group across 1 directory";
const LONG_BODY = "Updates `google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml` from 2.6.0 to 2.7.0";

function titleFixture(t: { after(fn: () => void): void }, title: string, body: string, write?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "rmd-dep-retitle-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const view = { title };
  const retitles: Array<{ url: string; title: string }> = [];
  const statuses: string[] = [];
  const opened: string[] = [];
  let captures = 0;
  const deps: DepReviewDeps = {
    config: { root, ledger: ledgerPath } as never,
    clock: clockFromMillisFn(() => 1_000),
    gh: () => ({
      number: 11968, url: "https://github.com/craigoley/remudero/pull/11968", title: view.title, body,
      headRefOid: "f".repeat(40), headRefName: "dependabot/github_actions/actions-minor-and-patch-0123",
      author: { login: "app/dependabot" },
      statusCheckRollup: [{ name: "commitlint", conclusion: "FAILURE" }, { name: "ci-gate", conclusion: "FAILURE" }],
    }),
    prDiff: () => "diff --git a/.github/workflows/scan.yml b/.github/workflows/scan.yml\n",
    postStatus: (async (args) => { statuses.push(args.state); return { posted: true }; }) as DepReviewDeps["postStatus"],
    arm: () => "armed",
    issues: {
      create: (_title, issueBody) => { opened.push(issueBody); return `https://github.com/craigoley/remudero/issues/${11968 + opened.length}`; },
      listOpen: () => [], closeWithComment: () => undefined,
    },
    nodePin: { readAtHead: () => undefined, commitAndPush: () => "c".repeat(40) },
    prMutations: {
      comment: () => undefined, close: () => undefined,
      retitle: async (url, next) => { write?.(); retitles.push({ url, title: next }); view.title = next; },
    },
    captureMigrationFeedback: (args) => { captures += 1; return { id: args.id } as never; },
  };
  return {
    retitles, statuses, opened,
    get captures() { return captures; },
    run: () => depReviewCommand("11968", ["--repo", "remudero", "--dependabot-own-red", "main-passes"], { ...deps }),
    ledger: () => readFileSync(ledgerPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

test("W1-T9828: the dep-review command retitles before any verdict and files no own-red build", async (t) => {
  const f = titleFixture(t, LONG_TITLE, LONG_BODY);
  assert.equal(await f.run(), 1, "the retitle pass holds");
  const fitted = "chore(deps): bump google/osv-scanner-action/…/osv-scanner-reusable.yml from 2.6.0 to 2.7.0";
  assert.deepEqual(f.retitles, [{ url: "https://github.com/craigoley/remudero/pull/11968", title: fitted }]);
  const rows = f.ledger().filter((r) => r.step === "dep-review.retitled");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].old_title, LONG_TITLE);
  assert.equal(rows[0].new_title, fitted);
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), false, "the retitle returns before any verdict");
  assert.deepEqual(f.statuses, [], "no review is posted");
  assert.equal(f.captures, 0, "no own-red proposal");

  await f.run();
  assert.equal(f.retitles.length, 1, "a fitting title is not written");
  assert.equal(f.ledger().some((r) => r.step === "dep-review.decided"), true, "the fitted head is judged as usual");
});

test("W1-T9828: an unfittable title red is held without an own-red build, and a failed write holds", async (t) => {
  const unfittable = `chore(deps): bump @scope/${"a".repeat(80)} from 1.2.3 to 1.2.4 in /`;
  const f = titleFixture(t, unfittable, "");
  await f.run();
  await f.run();
  assert.deepEqual(f.retitles, []);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.retitle_refused").length, 1);
  assert.equal(f.ledger().filter((r) => r.step === "dep-review.decided").length, 2, "the existing hold still runs");
  assert.equal(f.opened.length, 1, "the unchanged title red asks on the second pass");
  assert.match(f.opened[0], /fingerprint unchanged since/i);
  assert.equal(f.ledger().some((r) => String(r.step).startsWith("dep-review.own_red")), false, "a title red files no own-red build");
  assert.equal(f.captures, 0);

  const failing = titleFixture(t, LONG_TITLE, LONG_BODY, () => { throw new Error("HTTP 502"); });
  assert.equal(await failing.run(), 1);
  assert.equal(failing.ledger().filter((r) => r.step === "dep-review.retitle_failed").length, 1);
  assert.equal(failing.ledger().some((r) => r.step === "dep-review.decided"), false);
});

test("W1-T9828: the default title write is a REST PATCH of the pull request", async () => {
  const shim = ghShim([], { kind: "dep-review-retitle" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath}`;
  try {
    await defaultDepReviewPrMutations("craigoley", "remudero").retitle!("https://github.com/craigoley/remudero/pull/11968", "chore(deps): bump x from 1.0.0 to 1.0.1");
  } finally {
    process.env.PATH = oldPath;
  }
  assert.deepEqual(shim.calls(), ["api -X PATCH repos/craigoley/remudero/pulls/11968 -f title=chore(deps): bump x from 1.0.0 to 1.0.1"]);
});
