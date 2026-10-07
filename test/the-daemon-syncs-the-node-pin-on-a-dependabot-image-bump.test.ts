import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { depReviewCommand, type DepReviewDeps } from "../src/run-task.js";
import { clockFromMillisFn } from "../src/lib/clock.js";
import type { NodePinSyncIo } from "../src/lib/dep-review.js";

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
