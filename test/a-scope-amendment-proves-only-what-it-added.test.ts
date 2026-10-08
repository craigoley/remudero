// 2026-10-08: scope amendment #10141 (W1-T6358 for #10137) proved `files includes src/lib/status.ts` with
// `grep: src/lib/status\.ts in <shard>`, but the shard's rationale already named that path, so the proof
// matched at the merge base and proof-discrimination refused the amendment (executed_stale).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as amendments from "../src/lib/proof-amendment.js";
import type { ProofAmendmentWritePorts } from "../src/lib/proof-amendment.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const taskId = "W1-T5534";
const shardPath = `plan/tasks.d/${taskId}-fixture.yaml`;
const rationale = "  rationale: |\n    The change also touches src/lib/status.ts and src/run-task.ts, which callers read.\n";
const FLOW = `- id: ${taskId}\n  files: [src/existing.ts]\n${rationale}`;
const BLOCK = `- id: ${taskId}\n  files:\n    - src/existing.ts\n${rationale}`;

function amend(text: string): { before: string; after: string; proofs: string[] } {
  let written = "";
  let body = "";
  const deps = {
    repoDir: "/fixture", findShard: () => ({ path: shardPath, text }),
    worktreeAdd: () => {}, worktreeRemove: () => {},
    writeFile: (_path: string, next: string) => { written = next; },
    gitAdd: () => {}, gitCommit: () => "amendment-sha", gitPush: () => {},
    probeExisting: () => undefined,
    createPr: (opts: { body: string }) => { body = opts.body; return { prUrl: "https://github.com/acme/repo/pull/99", prNumber: 99 }; },
    worktreePathFor: () => "/amendment", lookupIdentity: () => undefined, recordIdentity: () => {},
    updateBranch: () => ({ ok: true }),
  } as unknown as ProofAmendmentWritePorts;
  const paths = ["src/lib/status.ts", "src/run-task.ts"];
  const outcome = amendments.requestScopeAmendment({ taskId, prNumber: 42, prUrl: "https://github.com/acme/repo/pull/42",
    headSha: "head-a", trailerTaskId: taskId, paths, changedPaths: paths }, deps);
  assert.equal(outcome.kind, "created");
  // renderAcceptanceBlock writes each criterion as `- <claim> | grep: <pattern> in <path>`.
  const proofs = body.split("\n").filter((line) => line.startsWith("- ") && line.includes(" | grep: "))
    .map((line) => line.slice(line.indexOf(" | grep: ") + " | grep: ".length));
  assert.equal(proofs.length, 2, "one proof per added path");
  return { before: text, after: written, proofs };
}

function grepHits(pattern: string, text: string): number {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scope-proof-`));
  try {
    const file = join(dir, "shard.yaml");
    writeFileSync(file, text);
    // The review gate runs a grep proof as `grep -arn -- <pattern> <path>` (src/lib/review.ts).
    const run = spawnSync("grep", ["-arn", "--", pattern, file], { encoding: "utf8" });
    return run.stdout.split("\n").filter(Boolean).length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a scope amendment's proofs match only the files entries it added, never a rationale that already names the path", () => {
  for (const [shape, text] of [["flow", FLOW], ["block", BLOCK]] as const) {
    const { before, after, proofs } = amend(text);
    assert.ok(grepHits("src/lib/status\\.ts", before) > 0, `${shape}: positive control — the base shard already names the path`);
    for (const proof of proofs) {
      const pattern = proof.slice(0, proof.lastIndexOf(" in "));
      assert.equal(grepHits(pattern, after), 1, `${shape}: ${proof} holds on the amended shard`);
      assert.equal(grepHits(pattern, before), 0, `${shape}: ${proof} must miss at base, or proof-discrimination refuses it`);
    }
  }
});
