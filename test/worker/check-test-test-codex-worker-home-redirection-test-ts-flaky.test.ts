// @census-reads: src/lib/worker.ts — the anchors test/codex-worker-home-redirection.test.ts greps in that file.
// @source-text-subject: this suite's subject is the literal anchors in src/lib/worker.ts that
// test/codex-worker-home-redirection.test.ts greps; it names the drifted anchor instead of an opaque ordering failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T10244: check:test:test/codex-worker-home-redirection.test.ts:flaky is prevented, not retried", () => {
  const source = readFileSync(join(REPO_ROOT, "src/lib/worker.ts"), "utf8");
  const anchors = [
    "execution.prompt = withWorkspaceCleanup(execution.prompt);",
    "const childEnv = buildWorkerEnv(args.env ?? {}, process.env",
    "Object.assign(childEnv, workerMarkerEnv(args.runId, args.taskId, workerInstallationScope(config.root)))",
    "const options: Options = {",
    "const liveQuery = runQuery({ prompt: execution.prompt, options });",
    'if (selection.provider === "codex")',
    "materializeWorkerHome({ workerHome, realHome })",
    "reapWorkerHome(workerHomeRoot, workerHome)",
  ];
  for (const anchor of anchors) {
    const first = source.indexOf(anchor);
    assert.ok(first >= 0, `src/lib/worker.ts lost the anchor test/codex-worker-home-redirection.test.ts greps: ${anchor}`);
  }
  const at = (n: number): number => source.indexOf(anchors[n] as string);
  assert.ok(
    at(0) < at(1) && at(1) < at(2) && at(2) < at(3) && at(3) < at(4),
    "Claude spawn anchors must stay in cleanup -> env -> markers -> options -> query order",
  );
});
