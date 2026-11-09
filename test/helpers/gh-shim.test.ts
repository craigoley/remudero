import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withGhShim } from "#test/helpers/gh-shim.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

test("W1-T11781: ghShim reads updated response-file contents at invocation time", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-response-`));
  const response = join(dir, "response.json");
  try {
    writeFileSync(response, '{"head":{"sha":"first"}}');
    await withGhShim([{ when: "api repos/example/pulls/1", stdoutFile: response }], async () => {
      const readResponse = () =>
        execFileSync("gh", ["api", "repos/example/pulls/1"], { encoding: "utf8" });
      assert.equal(readResponse(), '{"head":{"sha":"first"}}');
      writeFileSync(response, '{"head":{"sha":"second"}}');
      assert.equal(readResponse(), '{"head":{"sha":"second"}}');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
