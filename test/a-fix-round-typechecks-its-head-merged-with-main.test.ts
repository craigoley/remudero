// test/a-fix-round-typechecks-its-head-merged-with-main.test.ts — W1-T5658: #9085's fix round pushed a head that
// compiled alone onto a head behind main; CI's merge ref failed TS2300 because both sides added the same import at
// different lines (git merges that with no textual conflict). The fixtures here are REAL repositories — a bare
// origin, a clone with the repo's node_modules linked in, the real `tsc` — so the refusal is observed, not stubbed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { FixRoundPushError, pushFixRound } from "../src/run-task.js";
import { mergedHeadTypechecks } from "../src/lib/merge-probe.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trim();
const IMPORT = 'import { createHash } from "node:crypto";\n';
const BASE = Array.from({ length: 10 }, (_, i) => `export const v${i} = ${i};\n`).join("");
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "nodenext", moduleResolution: "nodenext", strict: true, skipLibCheck: true, types: ["node"], noEmit: true },
  include: ["*.ts"],
});

interface Fixture { origin: string; wt: string; branch: string; cleanup: () => void }

/** main adds `mainEdit(BASE)`; the branch (cut BEFORE that main commit) adds `branchEdit(BASE)`. */
function fixture(branchEdit: (base: string) => string, mainEdit: (base: string) => string): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}merged-tc-`));
  const origin = join(root, "origin.git");
  const wt = join(root, "wt");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  execFileSync("git", ["clone", "-q", origin, wt], { env: ENV });
  git(wt, "checkout", "-q", "-b", "main");
  symlinkSync(resolve("node_modules"), join(wt, "node_modules"));
  writeFileSync(join(wt, ".gitignore"), "node_modules\n");
  writeFileSync(join(wt, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(wt, "a.ts"), BASE);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "base");
  git(wt, "push", "-q", "origin", "main");
  const branch = "run-T-MERGED-1";
  git(wt, "checkout", "-q", "-b", branch);
  writeFileSync(join(wt, "a.ts"), branchEdit(BASE));
  git(wt, "commit", "-q", "-am", "fix round");
  git(wt, "checkout", "-q", "main");
  writeFileSync(join(wt, "a.ts"), mainEdit(BASE));
  git(wt, "commit", "-q", "-am", "main moves");
  git(wt, "push", "-q", "origin", "main");
  git(wt, "checkout", "-q", branch);
  return { origin, wt, branch, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const remoteHead = (fx: Fixture): string => git(fx.origin, "rev-parse", "--verify", "-q", `refs/heads/${fx.branch}`);
const sameImportTwice = () => fixture((b) => IMPORT + b, (b) => b + IMPORT);

test("a fix-round push is refused, with a ledgered reason, when HEAD typechecks but HEAD merged with origin/main does not", async () => {
  const fx = sameImportTwice();
  try {
    const head = git(fx.wt, "rev-parse", "HEAD");
    const refusal = await withLiveWritesAllowed(() => pushFixRound(fx.wt, fx.branch, head)).then(() => undefined, (e: unknown) => e);
    assert.ok(refusal instanceof FixRoundPushError, `the merged-tree failure is a named FixRoundPushError; got ${String(refusal)}`);
    assert.deepEqual(refusal.refusal?.censuses, ["merged-tree-typecheck"], "the refusal names its check so fix.push_refused ledgers it");
    assert.match(refusal.refusal?.text ?? "", /TS2300/, "the next strike is handed CI's own error");
    assert.throws(() => remoteHead(fx), "nothing was pushed");
  } finally {
    fx.cleanup();
  }
});

test("a head whose merge typechecks is pushed as today", async () => {
  const fx = fixture((b) => 'import { join } from "node:path";\n' + b, (b) => b + IMPORT);
  try {
    const head = git(fx.wt, "rev-parse", "HEAD");
    await withLiveWritesAllowed(() => pushFixRound(fx.wt, fx.branch, head));
    assert.equal(remoteHead(fx), head);
  } finally {
    fx.cleanup();
  }
});

test("a precheck that throws is skipped with its reason, never refused", async () => {
  const result = await mergedHeadTypechecks("/nonexistent", {
    git: () => { throw new Error("git exploded"); },
  });
  assert.deepEqual(result, { outcome: "skipped", reason: "precheck failed: git exploded" });
  const nonError = await mergedHeadTypechecks("/nonexistent", {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    git: () => { throw "plain string"; },
  });
  assert.deepEqual(nonError, { outcome: "skipped", reason: "precheck failed: plain string" });
});

test("a head that already fails alone is not blamed on the merge, and a head containing main is not probed", async () => {
  const broken = fixture((b) => IMPORT + "export const bad: number = 'x';\n" + b, (b) => b + IMPORT);
  try {
    const result = await mergedHeadTypechecks(broken.wt);
    assert.equal(result.outcome, "head_fails");
  } finally {
    broken.cleanup();
  }
  const fx = sameImportTwice();
  try {
    git(fx.wt, "reset", "-q", "--hard", "origin/main");
    const result = await mergedHeadTypechecks(fx.wt);
    assert.deepEqual(result, { outcome: "skipped", reason: "head is main" });
  } finally {
    fx.cleanup();
  }
});
