import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execWhitelistedProof, execWhitelistedProofAsync, parseWhitelistedProof, pinnedVitestCli } from "#src/lib/review.js";

const target = { owner: "craigoley", repo: "remudero-console" };
const title = "a selected shared-install proof";
const tap = `TAP version 13\n1..1\nok 1 - tests/unit/shared.test.ts {\n    1..1\n    ok 1 - ${title}\n}\n`;
const noBrowsers = { preflightBrowsers: () => {} };

function checkout(): { root: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-vitest-shared-"));
  const cwd = join(root, "checkout");
  const modules = join(root, "install");
  mkdirSync(join(modules, "vitest"), { recursive: true });
  mkdirSync(join(cwd, "tests", "unit"), { recursive: true });
  writeFileSync(join(modules, "vitest", "vitest.mjs"), "");
  writeFileSync(join(cwd, "tests", "unit", "shared.test.ts"), `test("${title}", () => {});\n`);
  symlinkSync(modules, join(cwd, "node_modules"), "dir");
  return { root, cwd };
}

test("shared-install Vitest proofs load native config in the synchronous executor", () => {
  const { root, cwd } = checkout();
  try {
    const proof = parseWhitelistedProof("unit test: tests/unit/shared.test.ts", target)!;
    const parsed = [...proof.args];
    const result = execWhitelistedProof(proof, cwd, 1000, (command, args) => {
      assert.equal(command, "node");
      assert.equal(args[0], pinnedVitestCli(cwd));
      assert.deepEqual(args.slice(-2), ["--configLoader", "native"]);
      assert.ok(!args.includes("--config"), "the target still chooses its own config file");
      return tap;
    }, noBrowsers);
    assert.equal(result, "pass");
    assert.deepEqual(proof.args, parsed, "execution must not mutate the reusable parsed proof");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared-install Vitest proofs load native config in the asynchronous executor", async () => {
  const { root, cwd } = checkout();
  try {
    const proof = parseWhitelistedProof(`unit test: ${title}`, target)!;
    const result = await execWhitelistedProofAsync(proof, cwd, 1000, async (_command, args) => {
      assert.deepEqual(args.slice(-2), ["--configLoader", "native"]);
      assert.ok(args.includes("tests/unit/shared.test.ts"), "title narrowing still chooses the observed file");
      assert.ok(args.includes("--reporter=tap"));
      return tap;
    }, noBrowsers);
    assert.equal(result, "pass");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared-install Vitest config reaches the real pinned-runner child without a dependency write", () => {
  const { root, cwd } = checkout();
  const install = join(root, "install");
  try {
    // A tiny pinned-runner fixture models Vite's measured config write, not Vitest's test semantics.
    writeFileSync(join(install, "vitest", "vitest.mjs"), `
import { mkdirSync } from "node:fs";
if (process.argv[process.argv.indexOf("--configLoader") + 1] !== "native") {
  mkdirSync(new URL("../.vite-temp/", import.meta.url));
}
process.stdout.write(${JSON.stringify(tap)});
`);
    chmodSync(install, 0o555);
    const proof = parseWhitelistedProof("unit test: tests/unit/shared.test.ts", target)!;
    assert.equal(execWhitelistedProof(proof, cwd, 5000, undefined, noBrowsers), "pass");
    assert.deepEqual(readdirSync(install), ["vitest"], "the shared dependency payload was not written");
  } finally {
    chmodSync(install, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
