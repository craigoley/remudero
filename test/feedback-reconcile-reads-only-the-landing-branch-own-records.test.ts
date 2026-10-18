// test/feedback-reconcile-reads-only-the-landing-branch-own-records.test.ts — W1-T9803.
//
// `rmd feedback-reconcile` counted every plan/feedback record on origin/feedback-landing as a
// source, including the copies the branch only inherited from the older main it was cut from.
// A record main deleted after the cut then read as missing-upstream, and `--apply` re-landed it
// (reproduced: the landing commit's diff against main re-added the deleted record). The source is
// now the branch's OWN records: the paths `diff origin/main...<tip>` names, read at the tip's blob.
//
// Real git fixtures throughout: a bare origin, main, and a landing branch cut from an older main.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import { LANDING_BRANCH } from "#src/lib/feedback-landing.js";
import { buildFeedbackReconcileManifest, reconcileFeedbackLanding } from "#src/lib/feedback-reconcile.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const FB = "plan/feedback";

function record(id: string, status: string): string {
  return stringifyYaml({ id, ts: "2026-01-01T00:00:00.000Z", raw: "fixture text", attachments: [], origin: "cli", status, proposal_pr: null });
}

function put(repo: GitRepo, id: string, status: string): void {
  mkdirSync(join(repo.dir, FB), { recursive: true });
  writeFileSync(join(repo.dir, FB, `${id}.yaml`), record(id, status));
}

function commitAndPush(repo: GitRepo, message: string, ref: string): void {
  repo.git("add", "-A");
  repo.git("commit", "--quiet", "-m", message);
  repo.git("push", "--quiet", "origin", `HEAD:${ref}`);
}

/** main holds `inherited` (fb-a) when the landing branch is cut; the branch adds its own fb-b;
 *  `afterCut` then changes main, and main also moves on for an unrelated reason (the live shape). */
function landingCutFromOlderMain(kind: string, afterCut: (seed: GitRepo) => void): { origin: string; checkout: string } {
  const origin = gitRepo({ bare: true, kind: `${kind}-origin` });
  const seed = gitRepo({ kind: `${kind}-seed` });
  seed.addRemote("origin", origin.dir);
  put(seed, "fb-a", "new");
  commitAndPush(seed, "main holds fb-a", "refs/heads/main");
  seed.git("checkout", "--quiet", "-b", "landing");
  put(seed, "fb-b", "new");
  commitAndPush(seed, "the landing adds its own fb-b", `refs/heads/${LANDING_BRANCH}`);
  seed.git("checkout", "--quiet", "main");
  afterCut(seed);
  writeFileSync(join(seed.dir, "README.md"), "unrelated main work\n");
  commitAndPush(seed, "main moves on", "refs/heads/main");
  return { origin: origin.dir, checkout: gitRepo({ cloneFrom: origin.dir, kind: `${kind}-clone` }).dir };
}

function recordingGit(dir: string): { git: (args: string[]) => string; calls: string[][] } {
  const calls: string[][] = [];
  const git = (args: string[]): string => {
    calls.push(args);
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  return { git, calls };
}

function fakeGh(): (args: string[]) => string {
  let created = false;
  return (args) => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(created ? [{ url: "https://github.com/o/r/pull/9803" }] : []);
    if (args[0] === "pr" && args[1] === "create") {
      created = true;
      return "https://github.com/o/r/pull/9803\n";
    }
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
}

test("W1-T9803: an inherited landing-branch record is not a reconcile source", () => {
  // main advances fb-a after the cut; the branch's stale inherited copy must not count as a source.
  const { checkout } = landingCutFromOlderMain("inherited", (seed) => put(seed, "fb-a", "accepted"));
  const { git, calls } = recordingGit(checkout);

  const result = buildFeedbackReconcileManifest({ roots: [{ name: "core", path: checkout }], checkoutRoot: checkout, git });

  assert.ok(result.ok);
  if (!result.ok) return;
  const a = result.manifest.entries.find((e) => e.id === "fb-a");
  assert.deepEqual(a?.foundIn, ["core"], `the inherited copy must not be a source: ${JSON.stringify(a)}`);
  assert.equal(a?.classification, "present-everywhere");
  // The landing source read exactly its own record: the root's fb-a and fb-b are absent from the
  // root (fb-b was never merged), so byteCount = the root's fb-a + the branch's fb-b, nothing else.
  assert.equal(result.manifest.byteCount, Buffer.byteLength(record("fb-a", "accepted")) + Buffer.byteLength(record("fb-b", "new")));
  assert.ok(!calls.some((c) => c[0] === "ls-tree" && c.includes("-r")), `no whole-tree listing: ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((c) => c.some((a) => a.includes(`${LANDING_BRANCH}:${FB}/fb-a.yaml`))), "the inherited copy is never read");
});

test("W1-T9803: a record main deleted is not re-landed from an inherited copy", () => {
  const { origin, checkout } = landingCutFromOlderMain("deleted", (seed) => {
    seed.git("rm", "--quiet", `${FB}/fb-a.yaml`);
  });

  const result = withLiveWritesAllowed(() =>
    reconcileFeedbackLanding({ roots: [{ name: "core", path: checkout }], checkoutRoot: checkout, apply: true, gh: fakeGh() }),
  );

  assert.equal(result.error, undefined);
  const landingDiff = execFileSync("git", ["--git-dir", origin, "diff", "--name-status", `main...${LANDING_BRANCH}`], { encoding: "utf8" });
  assert.doesNotMatch(landingDiff, /fb-a\.yaml/, `the landing PR must not re-add the record main deleted:\n${landingDiff}`);
  assert.ok(!result.landed.includes(`${FB}/fb-a.yaml`), `fb-a must not be re-landed: ${JSON.stringify(result.landed)}`);
  assert.equal(result.manifest.entries.find((e) => e.id === "fb-a"), undefined, JSON.stringify(result.manifest.entries));
});

test("W1-T9803: the landing branch own record is still reconciled", () => {
  const { origin, checkout } = landingCutFromOlderMain("own", (seed) => {
    seed.git("rm", "--quiet", `${FB}/fb-a.yaml`);
  });

  const dry = buildFeedbackReconcileManifest({ roots: [{ name: "core", path: checkout }], checkoutRoot: checkout });
  assert.ok(dry.ok);
  if (!dry.ok) return;
  const b = dry.manifest.entries.find((e) => e.id === "fb-b");
  assert.deepEqual(b?.foundIn, ["feedback-landing"]);
  assert.equal(b?.classification, "missing-upstream");
  assert.equal(b?.bestStatus, "new");

  const applied = withLiveWritesAllowed(() =>
    reconcileFeedbackLanding({ roots: [{ name: "core", path: checkout }], checkoutRoot: checkout, apply: true, gh: fakeGh() }),
  );
  assert.ok(applied.landed.includes(`${FB}/fb-b.yaml`), JSON.stringify(applied.landed));
  const landingDiff = execFileSync("git", ["--git-dir", origin, "diff", "--name-status", `main...${LANDING_BRANCH}`], { encoding: "utf8" });
  assert.match(landingDiff, /^A\tplan\/feedback\/fb-b\.yaml$/m);
});

test("W1-T9803: a record the landing branch itself deleted is not a candidate", () => {
  const { checkout } = landingCutFromOlderMain("branch-deleted", () => undefined);
  const landing = gitRepo({ cloneFrom: checkout, kind: "branch-deleted-landing" });
  landing.git("remote", "set-url", "origin", execFileSync("git", ["-C", checkout, "remote", "get-url", "origin"], { encoding: "utf8" }).trim());
  landing.git("fetch", "--quiet", "origin");
  landing.git("checkout", "--quiet", "-b", "drop", `origin/${LANDING_BRANCH}`);
  landing.git("rm", "--quiet", `${FB}/fb-a.yaml`);
  commitAndPush(landing, "the landing drops fb-a", `refs/heads/${LANDING_BRANCH}`);

  const result = buildFeedbackReconcileManifest({ roots: [{ name: "core", path: checkout }], checkoutRoot: checkout });

  assert.ok(result.ok);
  if (!result.ok) return;
  // fb-a: the root still holds main's copy, and the branch's deletion contributes no candidate.
  assert.deepEqual(result.manifest.entries.find((e) => e.id === "fb-a")?.foundIn, ["core"]);
  assert.deepEqual(result.manifest.entries.find((e) => e.id === "fb-b")?.foundIn, ["feedback-landing"]);
});
