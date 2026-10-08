import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPlanPrBody } from "../src/lib/plan-pr-emitter.js";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
const SHARD = "plan/tasks.d/CONSOLE-T100-agent-pages.yaml";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...IDENTITY } });
}

function consumerCheckout(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "rmd-consumer-plan-proof-"));
  git(dir, "init", "--quiet", "-b", "main");
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, SHARD), "- id: CONSOLE-T100\n  status: queued\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore: seed");
  const base = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "update-ref", "refs/remotes/origin/main", base);
  writeFileSync(join(dir, SHARD), "- id: CONSOLE-T100\n  # refusal-amendment (CONSOLE-T100): owner decision required\n  status: queued\n");
  git(dir, "commit", "-qam", "chore: record the refusal");
  return { dir, base };
}

test("a consumer plan body proves its refusal amendment from rmd's own install", () => {
  const { dir, base } = consumerCheckout();
  try {
    assert.equal(existsSync(join(dir, "node_modules")), false);
    assert.equal(existsSync(join(dir, "src", "run-task.ts")), false);
    const proof = `grep: refusal-amendment (CONSOLE-T100 in ${SHARD}`;
    const body = buildPlanPrBody({
      intro: "Record the owner's pending decision; do not release the task hold.",
      criteria: [{ claim: "the refusal is recorded", proof }],
      changedFiles: [SHARD],
      proofCwd: dir,
    });
    assert.match(body, /Acceptance:\n- the refusal is recorded/);
    assert.ok(body.includes(proof));
    assert.doesNotMatch(body, /Remudero-Task:/);
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
    assert.equal(git(dir, "rev-parse", "origin/main").trim(), base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a consumer plan body still refuses a proof already passing at its base", () => {
  const { dir, base } = consumerCheckout();
  try {
    assert.throws(() => buildPlanPrBody({
      intro: "No new evidence.",
      criteria: [{ claim: "the id exists", proof: `grep: CONSOLE-T100 in ${SHARD}` }],
      proofCwd: dir,
      baseRef: base,
    }), /passes at both head and base/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a consumer plan body still refuses a proof whose target is absent", () => {
  const { dir, base } = consumerCheckout();
  try {
    assert.throws(() => buildPlanPrBody({
      intro: "Missing evidence.",
      criteria: [{ claim: "the refusal exists", proof: "grep: refusal-amendment in plan/tasks.d/missing.yaml" }],
      proofCwd: dir,
      baseRef: base,
    }), /could not prove this head/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
