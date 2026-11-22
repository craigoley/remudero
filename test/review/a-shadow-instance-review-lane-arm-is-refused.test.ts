import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { armIfVerdictPermitsAsync } from "#src/lib/arm-auto-merge.js";
import { instanceMode, readInstanceRegistryText } from "#src/lib/instance-mode.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T13698. The review lane resolves its instance mode from the repository's own daemon instance
// registry, the same `instanceMode(owner/repo, readInstanceRegistryText(root))` read the sweep makes,
// and hands it to the arm. A registry that declares the repository shadow refuses the review lane's
// arm before any effector runs. The end-to-end `runReview` drive of this lane lives beside the review
// arm's other drives in test/a-reviews-status-post-and-pass-arm-await-their-transport.test.ts.

const HEAD_SHA = "13698aaabbbbccccddddeeeeffff000011112222";
const PR_URL = "https://github.com/acme/remudero/pull/13698";
const TASK_ID = "W1-T13698";
const PASS = { state: "success", capped: false, planOnly: false } as const;

type Row = [string, Record<string, unknown>];

/** The review lane's arm, under the mode a registry with `body` resolves to for acme/remudero. */
async function reviewArmUnderRegistry(body: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t13698-registry-`));
  try {
    if (body !== undefined) {
      mkdirSync(join(root, ".remudero"), { recursive: true });
      writeFileSync(join(root, ".remudero", "daemon-instances.yaml"), body);
    }
    const repoMode = instanceMode("acme/remudero", readInstanceRegistryText(root));
    const rows: Row[] = [];
    const calls: string[] = [];
    const outcome = await armIfVerdictPermitsAsync(PASS, {
      prUrl: PR_URL,
      taskId: TASK_ID,
      headSha: HEAD_SHA,
      ledgerPath: join(root, "unused-ledger.ndjson"),
      log: (step: string, extra: Record<string, unknown> = {}) => void rows.push([step, extra]),
      repoMode,
    }, {
      arm: (prUrl) => {
        calls.push(prUrl);
        return "armed" as const;
      },
    });
    return { repoMode, outcome, rows, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const registry = (repo: string, mode: string) =>
  ["instances:", "  worker:", `    github_repo: ${repo}`, `    mode: ${mode}`, ""].join("\n");

test("a registry declaring the repository shadow refuses the review lane's arm: automerge.shadow_refused, no effector", async () => {
  const run = await reviewArmUnderRegistry(registry("acme/remudero", "shadow"));
  assert.equal(run.repoMode, "shadow", "the registry's declaration is what the review lane reads");
  assert.equal(run.outcome, "shadow-refused");
  assert.deepEqual(run.calls, [], "the arm effector is never reached under shadow");
  const refused = run.rows.filter(([step]) => step === "automerge.shadow_refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.[1].pr_url, PR_URL);
  assert.ok(!run.rows.some(([step]) => step === "automerge.armed"));
});

test("a live, foreign or absent registry declaration leaves the review lane's arm armed", async () => {
  for (const body of [registry("acme/remudero", "live"), registry("acme/other", "shadow"), undefined]) {
    const run = await reviewArmUnderRegistry(body);
    assert.equal(run.repoMode, "live", `registry ${JSON.stringify(body)} resolves live`);
    assert.equal(run.outcome, "armed");
    assert.deepEqual(run.calls, [PR_URL]);
    assert.ok(!run.rows.some(([step]) => step === "automerge.shadow_refused"));
  }
});
