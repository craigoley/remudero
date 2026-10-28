/**
 * W1-T5892: a `gh-shim` route leaves every file an artifact holds, byte for byte. A route's
 * `writes` takes one file or a list, and each `content` may be text or binary, the way a real
 * `gh run download` leaves an `lcov.info` beside a `provenance.json`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";

test("W1-T5892: a gh-shim route writes every listed file byte for byte, binary included", () => {
  const out = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-shim-writes-`));
  const binary = Uint8Array.from([0, 1, 2, 0xff, 0x0a, 0x27, 0x22, 0]);
  const shim = ghShim([
    { when: "run download 7", writes: [
      { path: join(out, "a", "lcov.info"), content: "SF:src/a.ts\nend_of_record\n" },
      { path: join(out, "a", "blob.bin"), content: binary },
    ] },
    { when: "run download 8", writes: { path: join(out, "b", "one.txt"), content: "only'one\n" } },
  ]);
  const env = { ...process.env, PATH: `${shim.dir}:${process.env.PATH}` };
  assert.equal(spawnSync("gh", ["run", "download", "7"], { env }).status, 0);
  assert.equal(spawnSync("gh", ["run", "download", "8"], { env }).status, 0);

  assert.equal(readFileSync(join(out, "a", "lcov.info"), "utf8"), "SF:src/a.ts\nend_of_record\n");
  assert.deepEqual(new Uint8Array(readFileSync(join(out, "a", "blob.bin"))), binary, "binary content survives the shim");
  assert.equal(readFileSync(join(out, "b", "one.txt"), "utf8"), "only'one\n", "a single write still works");
  assert.deepEqual(shim.calls(), ["run download 7", "run download 8"]);
});
