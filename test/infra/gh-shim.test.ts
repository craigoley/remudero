import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShimRoute } from "#test/helpers/gh-shim.js";

function fixture(t: { after(fn: () => void): void }, routes: (root: string) => GhShimRoute[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gh-bytes-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shim = ghShim(routes(root));
  t.after(() => rmSync(shim.dir, { recursive: true, force: true }));
  const run = () => spawnSync(join(shim.dir, "gh"), ["api", "archive/zip"]);
  return { root, shim, run };
}

test("the shared gh fixture returns exact binary stdout through a real child", (t) => {
  const expected = Buffer.from([0x50, 0x4b, 0, 0xff, 0x0a, 0x24, 0x60]);
  const f = fixture(t, (root) => {
    const file = join(root, "archive.zip"); writeFileSync(file, expected);
    return [{ when: "archive/zip", stdoutFile: file }];
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, expected);
  assert.deepEqual(f.shim.calls(), ["api archive/zip"]);
});

test("the shared gh binary path preserves spaces quotes and shell syntax literally", (t) => {
  const expected = Buffer.from("literal archive bytes");
  const f = fixture(t, (root) => {
    const file = join(root, "floor 'quoted' $literal $(printf wrong).zip");
    writeFileSync(file, expected);
    return [{ when: "archive/zip", stdoutFile: file }];
  });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, expected);
});

test("an unavailable shared gh binary file cannot report successful empty output", (t) => {
  const f = fixture(t, (root) => [{ when: "archive/zip", stdoutFile: join(root, "absent.zip"), exit: 0 }]);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.length, 0);
  assert.deepEqual(f.shim.calls(), ["api archive/zip"]);
});

test("a shared gh binary response preserves the chosen route failure", (t) => {
  const expected = Buffer.from([0, 0xff]);
  const f = fixture(t, (root) => {
    const file = join(root, "archive.zip"); writeFileSync(file, expected);
    return [{ when: "archive/zip", stdoutFile: file, exit: 7 }];
  });
  const result = f.run();
  assert.equal(result.status, 7);
  assert.deepEqual(result.stdout, expected);
});

test("shared gh refuses ambiguous stdout and relative binary paths", () => {
  assert.throws(() => ghShim([{ when: "", stdout: "text", stdoutFile: "/missing.zip" }]), /cannot also specify stdout/);
  assert.throws(() => ghShim([{ when: "", stdoutEnv: "GH_SHIM_PAYLOAD", stdoutFile: "/missing.zip" }]), /cannot also specify stdout/);
  assert.throws(() => ghShim([{ when: "", stdoutFile: "relative.zip" }]), /absolute path/);
});
