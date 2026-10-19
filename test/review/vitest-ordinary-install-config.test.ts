import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execWhitelistedProof, execWhitelistedProofAsync, parseWhitelistedProof, pinnedVitestCli } from "#src/lib/review.js";

// An ordinary-install fixture writes its own tiny dependency payload. Keep that
// filesystem capability separate from the shared-install/read-only cases; the
// complete hosted suite always runs both, without an exclusion or skip.
test("ordinary Vitest installs keep their existing config-loading argv on both executors", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-vitest-ordinary-"));
  try {
    mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
    mkdirSync(join(root, "tests", "unit"), { recursive: true });
    writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "");
    writeFileSync(join(root, "tests", "unit", "shared.test.ts"), "test('ordinary proof', () => {});\n");
    const proof = parseWhitelistedProof("unit test: tests/unit/shared.test.ts", { owner: "craigoley", repo: "remudero-console" })!;
    const expected = [pinnedVitestCli(root), ...proof.args.slice(1)];
    const tap = "TAP version 13\n1..1\nok 1 - ordinary proof\n";
    const observe = (_command: string, args: readonly string[]) => { assert.deepEqual(args, expected); return tap; };
    const noBrowsers = { preflightBrowsers: () => {} };
    assert.equal(execWhitelistedProof(proof, root, 1000, observe, noBrowsers), "pass");
    assert.equal(await execWhitelistedProofAsync(proof, root, 1000, async (...args) => observe(args[0], args[1]), noBrowsers), "pass");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
