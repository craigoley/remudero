import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultNodePinSyncIo, depReviewCommand, type DepReviewDeps } from "../src/run-task.js";
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
