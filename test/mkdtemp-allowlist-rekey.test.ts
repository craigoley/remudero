/**
 * W1-T2786 — allowlist identity is content-addressed by file and observed prefix.
 *
 * A line number is presentation, not identity. These tests use real temporary git repositories
 * and the shipped scanner so an unrelated insertion must leave an exemption valid while a new
 * prefix or a different file still fails closed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "scripts", "mkdtemp-callsite-check.mjs");

type RefusedRow = { file: string; line: number; arg: string; classification: string };
type ScanSummary = { refused: RefusedRow[]; scanned: number; allowedCount: number };

const mod = (await import(pathToFileURL(SCRIPT).href)) as {
  UNRESOLVABLE_PREFIX: string;
  allowlistKey: (file: string, arg: string) => string;
  collectRefusableCallsites: (repoRoot: string) => { rows: RefusedRow[]; scanned: number };
  extractMkdtempPrefix: (arg: string) => string;
  formatRefusal: (row: RefusedRow) => string;
  loadAllowlist: (repoRoot: string) => Set<string>;
  scanRepo: (repoRoot: string) => ScanSummary;
};

function fixture(files: Record<string, string>): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), "rmd-mkdtemp-rekey-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"], { env });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"], { env });
  execFileSync("git", ["-C", root, "config", "user.name", "RMD Test"], { env });
  for (const [relative, body] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
  execFileSync("git", ["-C", root, "add", "-A"], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture", "--no-verify"], { env });
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const bareCall = "const d = mkdtempSync(join(tmpdir(), 'sweep-reentry-'));";

test("W1-T2786: an unrelated insertion above an allowlisted callsite keeps the exemption valid", () => {
  const f = fixture({
    "test/bare.test.ts": ["import { mkdtempSync } from 'node:fs';", bareCall].join("\n"),
    "hooks/mkdtemp-allowlist.txt": "test/bare.test.ts\tsweep-reentry- # pre-existing site\n",
  });
  try {
    assert.equal(mod.scanRepo(f.root).refused.length, 0, "precondition: the content key exempts the site");
    writeFileSync(join(f.root, "test/bare.test.ts"), ["// unrelated insertion", "import { mkdtempSync } from 'node:fs';", bareCall].join("\n"));
    assert.equal(mod.scanRepo(f.root).refused.length, 0, "moving the callsite cannot change its identity");
  } finally {
    f.dispose();
  }
});

test("W1-T2786: a genuinely new bare prefix is still refused", () => {
  const f = fixture({
    "test/bare.test.ts": [bareCall, "const e = mkdtempSync(join(tmpdir(), 'new-leak-'));"].join("\n"),
    "hooks/mkdtemp-allowlist.txt": "test/bare.test.ts\tsweep-reentry- # existing prefix only\n",
  });
  try {
    const summary = mod.scanRepo(f.root);
    assert.deepEqual(summary.refused.map((row) => mod.extractMkdtempPrefix(row.arg)), ["new-leak-"]);
  } finally {
    f.dispose();
  }
});

test("W1-T2786: the same prefix in a different file remains refused", () => {
  const f = fixture({
    "test/allowed.test.ts": bareCall,
    "test/different.test.ts": bareCall,
    "hooks/mkdtemp-allowlist.txt": "test/allowed.test.ts\tsweep-reentry- # only this file\n",
  });
  try {
    assert.deepEqual(mod.scanRepo(f.root).refused.map((row) => row.file), ["test/different.test.ts"]);
  } finally {
    f.dispose();
  }
});

test("W1-T2786: an unresolvable callsite has an explicit, exemptible sentinel key", () => {
  const file = "scripts/variable.mjs";
  const call = "export const make = (prefix) => mkdtempSync(join(tmpdir(), prefix));";
  const f = fixture({
    [file]: call,
    "hooks/mkdtemp-allowlist.txt": `${file}\t${mod.UNRESOLVABLE_PREFIX} # runtime normalises it\n`,
  });
  try {
    assert.equal(mod.extractMkdtempPrefix("join(tmpdir(), prefix)"), mod.UNRESOLVABLE_PREFIX);
    assert.equal(mod.scanRepo(f.root).refused.length, 0, "the sentinel keeps unresolvable sites expressible");
    writeFileSync(join(f.root, "hooks/mkdtemp-allowlist.txt"), "# no exemption\n");
    assert.equal(mod.scanRepo(f.root).refused.length, 1, "without the sentinel entry it still fails closed");
  } finally {
    f.dispose();
  }
});

test("W1-T2786: key computation and refusal rendering share one observed-prefix extractor", () => {
  const row: RefusedRow = {
    file: "test/x.test.ts",
    line: 42,
    arg: "join(tmpdir(), `worker-${kind}-`)",
    classification: "bare-literal",
  };
  const prefix = mod.extractMkdtempPrefix(row.arg);
  assert.equal(prefix, "worker-${kind}-");
  assert.equal(mod.allowlistKey(row.file, row.arg), `${row.file}\t${prefix}`);
  assert.match(mod.formatRefusal(row), new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(mod.formatRefusal(row), /test\/x\.test\.ts\\tworker-/, "the printed escape hatch is the exact key");
});

test("W1-T2786: every migrated allowlist entry names a currently observed file and prefix", () => {
  const observedRows = mod.collectRefusableCallsites(REPO_ROOT).rows;
  const observed = new Set(observedRows.map((row) => mod.allowlistKey(row.file, row.arg)));
  const allowed = mod.loadAllowlist(REPO_ROOT);
  assert.equal(mod.scanRepo(REPO_ROOT).refused.length, 0, "the migrated allowlist leaves the real tree clean");
  assert.ok(allowed.size < observedRows.length, "same-file same-prefix sites collapse to one stable entry");
  assert.deepEqual([...allowed].filter((key) => !observed.has(key)), [], "no migrated key is inferred from a stale line");
  assert.deepEqual([...observed].filter((key) => !allowed.has(key)), [], "every live refusable key is represented");
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /formatRefusal[\s\S]*extractMkdtempPrefix/, "the refusal display calls the shared extractor");
});
