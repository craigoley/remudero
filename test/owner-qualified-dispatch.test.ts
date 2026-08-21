import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveDaemonTarget, resolveReviewTarget } from "../src/run-task.js";

/**
 * W1-T1062 ACCEPTANCE 2: "an owner-qualified target resolves to that owner rather than to this
 * checkout's, through the splitting the review path already uses."
 *
 * The task record's design is explicit that the default-owner splitting `resolveReviewTarget`
 * (`rmd review --repo <owner>/<name>`) already implements and unit-tests must be REUSED by
 * `resolveDaemonTarget`, never re-derived as a second, parallel parser. These tests prove both
 * halves: the resolution itself, and that it is the SAME function doing the splitting.
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

test("resolveDaemonTarget: --repo <owner>/<name> resolves to THAT owner, not this checkout's own", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "other-owner/other-box"]) as { target: any };
  assert.ok(r.target, "an owner-qualified, different-owner target can never trip the self-host refusal");
  assert.equal(r.target.owner, "other-owner");
  assert.equal(r.target.repo, "other-box");
  assert.equal(r.target.isSelf, false);
});

test("resolveDaemonTarget: an owner-qualified target's plan still comes from reposDir/<repo> -- only the GATEWAY owner moves, never the clone layout", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "other-owner/other-box"]) as { target: any };
  assert.equal(r.target.planPath, "/root/repos/other-box/plan/tasks.yaml");
});

test("resolveDaemonTarget: --allow-self-target/--dry-run are irrelevant once an owner-qualified target is genuinely foreign -- nothing to acknowledge, it never reads as self", () => {
  const r = resolveDaemonTarget(dEnv, ["--repo", "other-owner/other-box"]) as { target: any };
  assert.ok(!("error" in r), "a foreign-owner target needs no --allow-self-target acknowledgement");
});

test("resolveDaemonTarget's owner-qualified split matches resolveReviewTarget's OWN split EXACTLY for the identical --repo <owner>/<name> token", () => {
  const defaults = { owner: dEnv.selfOwner, repo: dEnv.selfRepo };
  const viaDaemon = resolveDaemonTarget(dEnv, ["--repo", "acme/widgets"]) as { target: any };
  const viaReview = resolveReviewTarget(defaults, ["--repo", "acme/widgets"]);
  assert.deepEqual({ owner: viaDaemon.target.owner, repo: viaDaemon.target.repo }, viaReview);
});

test("DESIGN: resolveDaemonTarget calls resolveReviewTarget's splitter directly -- no parallel owner/repo parser was written for this task", () => {
  const body = extractFunctionBody(runTaskSrc, "export function resolveDaemonTarget(");
  assert.match(
    body,
    /resolveReviewTarget\(/,
    "resolveDaemonTarget must reuse resolveReviewTarget's splitting rather than re-deriving its own",
  );
  assert.doesNotMatch(
    body,
    /\.split\(["']\/["']/,
    "no ad hoc owner/repo string-splitting was added inside resolveDaemonTarget itself",
  );
});
