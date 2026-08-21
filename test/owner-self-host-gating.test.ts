import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveDaemonTarget } from "../src/run-task.js";

/**
 * W1-T1062 ACCEPTANCE 3: "the self-host predicate compares owner as well as repo, so this
 * repo's name under a foreign owner is not treated as self and cannot reach the retro or
 * auto-triage hooks."
 *
 * Design (iii), verbatim: "isSelf MUST COMPARE BOTH OWNER AND REPO. Today it compares repo
 * alone. Retro and auto-triage hooks are gated on it, and so is the plan-sync branch — so a
 * target repo that merely SHARES THIS REPO'S NAME under a different owner would be treated as
 * self-hosting and would start filing into this instance's own plan." Design (iv), the
 * falsifier, verbatim: "the self repo NAME under a foreign owner is NOT self."
 */

const dEnv = { selfOwner: "craigoley", selfRepo: "remudero", repoRoot: "/repo", reposDir: "/root/repos" };
const runTaskSrc = readFileSync(fileURLToPath(new URL("../src/run-task.ts", import.meta.url)), "utf8");

function extractFunctionBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `expected to find '${signature}' in run-task.ts`);
  const nextFn = src.indexOf("\nfunction ", start + 1);
  const nextAsyncFn = src.indexOf("\nasync function ", start + 1);
  const nextExportAsyncFn = src.indexOf("\nexport async function ", start + 1);
  const boundaries = [nextFn, nextAsyncFn, nextExportAsyncFn].filter((i) => i > start);
  const end = boundaries.length ? Math.min(...boundaries) : src.length;
  return src.slice(start, end);
}

// ── THE FALSIFIER, verbatim from the task record's design (iv). ──────────────────────────────
test("resolveDaemonTarget: this checkout's OWN repo NAME under a FOREIGN owner is NOT self -- the sharpest single failure mode design (iii) names", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "someone-else/remudero"]) as { target: any };
  assert.ok(r.target, "a foreign owner is never refused as a self-target, no matter the repo name");
  assert.equal(r.target.owner, "someone-else");
  assert.equal(r.target.repo, "remudero"); // the SAME name as dEnv.selfRepo
  assert.equal(
    r.target.isSelf,
    false,
    "repo-name equality alone must never satisfy isSelf -- owner equality is also required",
  );
});

test("resolveDaemonTarget: this checkout's own owner+repo TOGETHER (deliberately) IS self -- the predicate still recognizes the real self-host case", () => {
  const r = resolveDaemonTarget(dEnv, ["--allow-self-target"]) as { target: any };
  assert.equal(r.target.owner, dEnv.selfOwner);
  assert.equal(r.target.repo, dEnv.selfRepo);
  assert.equal(r.target.isSelf, true);
});

test("resolveDaemonTarget: this checkout's own owner with a DIFFERENT repo name is not self either -- both fields are independently load-bearing, not just the new one", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "remudero-sandbox"]) as { target: any };
  assert.equal(r.target.owner, dEnv.selfOwner);
  assert.equal(r.target.repo, "remudero-sandbox");
  assert.equal(r.target.isSelf, false);
});

test("daemonCommand: the retro / auto-triage / github-posture hooks are gated on target.isSelf -- the SAME predicate proved above to compare owner AND repo, never a looser one", () => {
  const body = extractFunctionBody(runTaskSrc, "export async function daemonCommand(");
  assert.match(
    body,
    /const retroHooks = target\.isSelf \? buildRetroDaemonHooks\(\) : undefined;/,
    "the retro cadence hooks must still be gated on target.isSelf",
  );
  assert.match(
    body,
    /const autoTriageHooks = target\.isSelf \? buildAutoTriageDaemonHooks\(/,
    "the auto-triage hooks must still be gated on target.isSelf",
  );
  assert.match(
    body,
    /const githubPostureHooks = target\.isSelf \? buildGithubPostureDaemonHooks\(/,
    "the github-posture drift hooks must still be gated on target.isSelf",
  );
});
