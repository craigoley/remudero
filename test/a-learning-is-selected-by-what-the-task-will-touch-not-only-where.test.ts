import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { candidateShardFiles, selectLearnings, type LearningEntry, type LearningsIndex } from "../src/lib/learnings.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-learnings-index.mjs");

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: "base",
    subsystem: "test",
    lifecycle: "active",
    files: ["src/run-task.ts"],
    fact: "base fact",
    src: "test",
    ...overrides,
  };
}

test("an error-signature match outranks an entry that only shares a file glob", () => {
  const { selected, matchedBy } = selectLearnings(
    [
      entry({
        id: "file-neighbour",
        files: ["src/run-task.ts"],
        fact: "shared path only",
        cited: "2099-01-01",
      }),
      entry({
        id: "symlink-refusal",
        files: ["src/lib/install.ts"],
        errorSignatures: ["SymlinkInstallRefusal"],
        fact: "the symlink install refusal has a known remedy",
        cited: "2000-01-01",
      }),
    ],
    ["src/run-task.ts"],
    undefined,
    { text: "install failed with SymlinkInstallRefusal while preparing the worker" },
  );

  assert.deepEqual(selected.map((e) => e.id), ["symlink-refusal", "file-neighbour"]);
  assert.deepEqual(matchedBy, { file: 1, symbol: 0, error: 1 });
});

test("an empty files list admits only entries matched by symbol or error text", () => {
  const { selected, matchedBy } = selectLearnings(
    [
      entry({ id: "file-only", files: ["src/run-task.ts"], fact: "shares only a path" }),
      entry({ id: "symbol-match", files: ["src/lib/other.ts"], symbols: ["selectLearnings"], fact: "selector fact" }),
      entry({ id: "error-match", files: ["src/lib/install.ts"], errorSignatures: ["fatal refusal"], fact: "error fact" }),
    ],
    [],
    undefined,
    { text: "The task changes selectLearnings after recon observed a fatal refusal." },
  );

  assert.deepEqual(selected.map((e) => e.id), ["error-match", "symbol-match"]);
  assert.deepEqual(matchedBy, { file: 0, symbol: 1, error: 1 });
});

test("candidateShardFiles uses indexed symbols and error signatures when task files are empty", () => {
  const index: LearningsIndex = {
    files: {
      "a.yaml": { entries: ["file-only"], globs: ["src/run-task.ts"], symbols: [], error_signatures: [] },
      "b.yaml": { entries: ["symbol-match"], globs: ["src/lib/other.ts"], symbols: ["selectLearnings"], error_signatures: [] },
      "c.yaml": { entries: ["error-match"], globs: ["src/lib/install.ts"], symbols: [], error_signatures: ["fatal refusal"] },
    },
    bySubsystem: {},
  };

  assert.deepEqual(candidateShardFiles(index, [], { text: "selectLearnings hit a fatal refusal" }), ["b.yaml", "c.yaml"]);
});

test("generate-learnings-index emits symbols and error_signatures, and --check fails when they are stale", () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}learnings-index-signals-`));
  writeFileSync(
    join(dir, "signals.yaml"),
    [
      "- id: signal-fixture",
      "  subsystem: test",
      "  files: [src/run-task.ts]",
      "  symbols: [selectLearnings]",
      "  error_signatures: [SymlinkInstallRefusal]",
      "  fact: signal fact",
      "  src: test",
      "",
    ].join("\n"),
  );

  const out = join(dir, "index.json");
  const gen = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stdout + gen.stderr);

  const fresh = JSON.parse(readFileSync(out, "utf8")) as LearningsIndex;
  assert.deepEqual(fresh.files["signals.yaml"].symbols, ["selectLearnings"]);
  assert.deepEqual(fresh.files["signals.yaml"].error_signatures, ["SymlinkInstallRefusal"]);

  fresh.files["signals.yaml"].symbols = [];
  writeFileSync(out, `${JSON.stringify(fresh, null, 2)}\n`);
  const check = spawnSync(process.execPath, [SCRIPT, "--dir", dir, "--out", out, "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.notEqual(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout + check.stderr, /is STALE/);
});
