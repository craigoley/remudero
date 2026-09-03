import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  LANDING_BRANCH,
  landFeedback,
  sweepFeedbackLanding,
  type LandFeedbackOpts,
} from "../src/lib/feedback-landing.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
}

function makeBareOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), "rmd-feedback-ack-origin-"));
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare], { env: GIT_ENV });
  const seed = mkdtempSync(join(tmpdir(), "rmd-feedback-ack-seed-"));
  execFileSync("git", ["init", "--quiet", "-b", "main", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(seed, "add", "-A");
  git(seed, "commit", "--quiet", "-m", "chore: seed");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "--quiet", "origin", "main");
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

function cloneRoot(bareOrigin: string): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-feedback-ack-root-"));
  execFileSync("git", ["clone", "--quiet", bareOrigin, root], { env: GIT_ENV });
  return root;
}

function writeRel(root: string, rel: string, content: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function advanceMain(bareOrigin: string, files: Record<string, string>, message = "chore: advance main"): void {
  const writer = cloneRoot(bareOrigin);
  try {
    for (const [rel, content] of Object.entries(files)) writeRel(writer, rel, content);
    git(writer, "add", "-A");
    git(writer, "commit", "--quiet", "-m", message);
    git(writer, "push", "--quiet", "origin", "main");
  } finally {
    rmSync(writer, { recursive: true, force: true });
  }
}

function fakeGh(prUrl = "https://github.com/o/r/pull/1") {
  let created = false;
  const gh = (args: string[]): string => {
    if (args[0] === "pr" && args[1] === "list") return JSON.stringify(created ? [{ url: prUrl }] : []);
    if (args[0] === "pr" && args[1] === "create") {
      created = true;
      return `${prUrl}\n`;
    }
    if (args[0] === "pr" && args[1] === "merge") return "";
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return { gh };
}

test("W1-T2749: a merged byte-identical queue copy is acknowledged before a later status change, so boot can fast-forward", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const rel = "plan/feedback/fb-ack.yaml";
  const original = "id: fb-ack\nstatus: new\nraw: durable queue payload\n";
  const terminal = "id: fb-ack\nstatus: rejected\nraw: durable queue payload\n";
  writeRel(root, rel, original);
  const { gh } = fakeGh();

  const first = withLiveWritesAllowed(() => landFeedback(root, { gh }));
  assert.equal(first.pushed, true, "positive control: the queue copy was submitted to the landing branch");
  execFileSync("git", ["--git-dir", bareOrigin, "update-ref", "refs/heads/main", `refs/heads/${LANDING_BRANCH}`]);
  assert.ok(existsSync(join(root, rel)), "pre-fix red state: merging does not itself alter the boot checkout's untracked copy");

  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const acknowledged = withLiveWritesAllowed(() =>
    sweepFeedbackLanding(root, { gh, log: (step, extra) => lines.push({ step, extra }) }),
  );
  assert.equal(existsSync(join(root, rel)), false, "the fetched, byte-identical untracked queue copy is removed");
  assert.deepEqual(acknowledged.acknowledgement, { count: 1, paths: [rel], truncated: false });

  advanceMain(bareOrigin, { [rel]: terminal }, "chore: triage feedback");
  assert.doesNotThrow(() => git(root, "pull", "--ff-only", "origin", "main"));
  assert.equal(readFileSync(join(root, rel), "utf8"), terminal, "the terminal upstream record reaches the boot checkout");

  const line = lines.find(({ step }) => step === "feedback.landing_sweep");
  assert.equal(line?.extra?.acknowledged_count, 1);
  assert.deepEqual(line?.extra?.acknowledged_paths, [rel]);
  assert.doesNotMatch(JSON.stringify(line), /durable queue payload/, "telemetry contains paths, never feedback content");
});

test("W1-T2749: acknowledgement preserves differing, absent-upstream, unreadable, and tracked paths while landing retryable content", () => {
  const bareOrigin = makeBareOrigin();
  const tracked = "plan/feedback/fb-tracked.yaml";
  advanceMain(bareOrigin, { [tracked]: "id: fb-tracked\nstatus: new\n" });
  const root = cloneRoot(bareOrigin);
  const identical = "plan/feedback/fb-identical.yaml";
  const different = "plan/feedback/fb-different.yaml";
  const absent = "plan/feedback/fb-absent.yaml";
  const unreadable = "plan/feedback/fb-unreadable.yaml";
  writeRel(root, identical, "id: fb-identical\nstatus: new\n");
  writeRel(root, different, "id: fb-different\nstatus: local\n");
  writeRel(root, absent, "id: fb-absent\nstatus: local\n");
  writeRel(root, unreadable, "id: fb-unreadable\nstatus: new\n");
  advanceMain(bareOrigin, {
    [identical]: "id: fb-identical\nstatus: new\n",
    [different]: "id: fb-different\nstatus: remote\n",
    [unreadable]: "id: fb-unreadable\nstatus: new\n",
  });

  const unreadableSha = execFileSync(
    "git",
    ["--git-dir", bareOrigin, "rev-parse", `main:${unreadable}`],
    { encoding: "utf8", env: GIT_ENV },
  ).trim();
  const realGit: NonNullable<LandFeedbackOpts["git"]> = (args, opts) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: opts?.env ?? GIT_ENV,
    });
  const unreadableGit: NonNullable<LandFeedbackOpts["git"]> = (args, opts) => {
    if (args[0] === "cat-file" && args.at(-1) === `${unreadableSha}^{blob}`) throw new Error("simulated unreadable blob");
    return realGit(args, opts);
  };

  const { gh } = fakeGh("https://github.com/o/r/pull/2");
  const result = withLiveWritesAllowed(() => sweepFeedbackLanding(root, { gh, git: unreadableGit }));
  assert.deepEqual(result.acknowledgement, { count: 1, paths: [identical], truncated: false });
  assert.equal(existsSync(join(root, identical)), false, "only the proved-identical untracked path is acknowledged");
  for (const rel of [different, absent, unreadable, tracked]) {
    assert.ok(existsSync(join(root, rel)), `${rel} is preserved`);
  }
  assert.equal(git(root, "ls-files", "--error-unmatch", tracked).trim(), tracked, "the tracked control is genuinely tracked");
  assert.equal(
    execFileSync("git", ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:${different}`], { encoding: "utf8" }),
    "id: fb-different\nstatus: local\n",
    "a differing queue file retains the existing landing behavior",
  );
  assert.equal(
    execFileSync("git", ["--git-dir", bareOrigin, "show", `${LANDING_BRANCH}:${absent}`], { encoding: "utf8" }),
    "id: fb-absent\nstatus: local\n",
    "an absent-upstream queue file retains the existing landing behavior",
  );
});

test("W1-T2749: a quiet sweep emits acknowledgement count only", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const { gh } = fakeGh();
  const result = withLiveWritesAllowed(() =>
    sweepFeedbackLanding(root, { gh, log: (step, extra) => lines.push({ step, extra }) }),
  );
  assert.equal(result.acknowledgement, undefined);
  const line = lines.find(({ step }) => step === "feedback.landing_sweep");
  assert.equal(line?.extra?.acknowledged_count, 0);
  assert.equal("acknowledged_paths" in (line?.extra ?? {}), false);
});

test("W1-T2749: acknowledgement evidence is bounded without undercounting", () => {
  const bareOrigin = makeBareOrigin();
  const root = cloneRoot(bareOrigin);
  const files: Record<string, string> = {};
  for (let i = 0; i < 51; i += 1) {
    const rel = `plan/feedback/fb-many-${String(i).padStart(2, "0")}.yaml`;
    files[rel] = `id: fb-many-${i}\nstatus: new\n`;
    writeRel(root, rel, files[rel]);
  }
  advanceMain(bareOrigin, files);
  const result = withLiveWritesAllowed(() => sweepFeedbackLanding(root, { gh: fakeGh().gh }));
  assert.equal(result.acknowledgement?.count, 51);
  assert.equal(result.acknowledgement?.paths.length, 50);
  assert.equal(result.acknowledgement?.truncated, true);
  assert.equal(Object.keys(files).some((rel) => existsSync(join(root, rel))), false, "bounding evidence does not bound the acknowledgements themselves");
});
