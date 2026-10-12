import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// @ts-expect-error -- plain .mjs script, no type declarations
import { listTestFiles } from "../scripts/assertion-discrimination-check.mjs";

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}scan-vanish-`));
  mkdirSync(join(root, "sub", "deep"), { recursive: true });
  mkdirSync(join(root, "mutants-abc123"));
  mkdirSync(join(root, "sub", "mutants-zzz999"));
  writeFileSync(join(root, "a.test.ts"), "");
  writeFileSync(join(root, "sub", "b.test.ts"), "");
  writeFileSync(join(root, "sub", "deep", "c.test.ts"), "");
  writeFileSync(join(root, "sub", "notes.md"), "");
  writeFileSync(join(root, "mutants-abc123", "m.test.ts"), "");
  writeFileSync(join(root, "sub", "mutants-zzz999", "m.test.ts"), "");
  return root;
}

const rel = (root: string, files: string[]) => files.map((f) => f.slice(root.length + 1)).sort();

describe("listTestFiles", () => {
  it("returns every real test file and never a mutants-* entry", () => {
    const root = makeTree();
    try {
      assert.deepEqual(rel(root, listTestFiles(root, ".test.ts")), [
        "a.test.ts",
        "sub/b.test.ts",
        "sub/deep/c.test.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unit test: a directory removed during the walk is skipped without throwing", () => {
    const root = makeTree();
    try {
      // Simulate a sibling test removing directories as the walk reaches them: remove the
      // mutants directories and the `deep` subdirectory just before `deep` would be read.
      const racing = ((dir: string, opts: unknown) => {
        if (dir === join(root, "sub", "deep")) {
          rmSync(join(root, "mutants-abc123"), { recursive: true, force: true });
          rmSync(dir, { recursive: true, force: true });
        }
        return readdirSync(dir, opts as never);
      }) as never;
      assert.deepEqual(rel(root, listTestFiles(root, ".test.ts", racing)), [
        "a.test.ts",
        "sub/b.test.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still throws a non-ENOENT error", () => {
    const root = makeTree();
    try {
      const denied = ((dir: string, opts: unknown) => {
        if (dir === join(root, "sub")) {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        }
        return readdirSync(dir, opts as never);
      }) as never;
      assert.throws(() => listTestFiles(root, ".test.ts", denied), { code: "EACCES" });
      assert.throws(() => listTestFiles(join(root, "missing"), ".test.ts"), { code: "ENOENT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
