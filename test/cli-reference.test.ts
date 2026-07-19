import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMANDS } from "../src/run-task.js";

// ── W1-T48: the docs/cli-reference.md generator + drift gate ────────────────────────────────
//
// `rmd --help` / `rmd <cmd> --help` already render from ONE source of truth -- the COMMANDS
// registry in src/run-task.ts (W1-T47). This suite proves docs/cli-reference.md is a THIRD
// rendering of that same registry, not a hand-maintained duplicate that can silently drift:
// a FRESH regeneration matches the committed file byte-for-byte (this IS the byte-compare CI
// runs, via `npm test` -> the `ci` job, already a REQUIRED check); a stale/missing file turns
// `--check` red and names the fix.
//
// (scripts/generate-cli-reference.mjs is a plain .mjs file outside tsconfig's `include` that
// also imports the COMMANDS registry from a .ts module, so -- mirroring
// test/claims-check.test.ts's convention for scripts/claims-check.mjs -- it is exercised here
// only via `spawnSync` against its CLI surface, run under `node --import tsx` the same way
// `npm run cli-reference` / `cli-reference:check` invoke it via the `tsx` bin.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-cli-reference.mjs");

function runCheck(out: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--check", "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runGenerate(out: string) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

test("generate-cli-reference: two independent regenerations are byte-identical (content-only, no timestamp)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-reference-roundtrip-"));
  try {
    const outA = join(dir, "a.md");
    const outB = join(dir, "b.md");
    const genA = runGenerate(outA);
    const genB = runGenerate(outB);
    assert.equal(genA.status, 0, genA.stdout + genA.stderr);
    assert.equal(genB.status, 0, genB.stdout + genB.stderr);
    assert.equal(readFileSync(outA, "utf8"), readFileSync(outB, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-cli-reference: every COMMANDS registry entry's usage line appears verbatim in the generated doc", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-reference-coverage-"));
  try {
    const out = join(dir, "cli-reference.md");
    const gen = runGenerate(out);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const rendered = readFileSync(out, "utf8");
    for (const spec of COMMANDS) {
      assert.ok(
        rendered.includes(spec.usage),
        `generated cli-reference.md is missing the ${spec.name} registry entry's usage line -- it must be generated from COMMANDS, not hand-duplicated`,
      );
      assert.ok(
        rendered.includes(`\`rmd ${spec.name}\``),
        `generated cli-reference.md has no section heading for command '${spec.name}'`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-cli-reference --check: the REAL committed docs/cli-reference.md is NOT stale (this is what CI byte-compares on every PR via `npm test`)", () => {
  const result = runCheck(join(REPO_ROOT, "docs", "cli-reference.md"));
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /OK -- .*cli-reference\.md matches the current COMMANDS registry/);
});

test("generate-cli-reference --check: a STALE committed file (hand-edited, deliberately wrong) -> non-zero exit, names the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-reference-stale-"));
  try {
    const out = join(dir, "cli-reference.md");
    writeFileSync(out, "# not what the generator would produce\n");
    const result = runCheck(out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /npm run cli-reference/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-cli-reference --check: a STALE file that hand-edits ONE command's section -> non-zero exit, NAMES that command (MASTER-PLAN §12A)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-reference-drift-"));
  try {
    const out = join(dir, "cli-reference.md");
    const gen = runGenerate(out);
    assert.equal(gen.status, 0, gen.stdout + gen.stderr);
    const original = readFileSync(out, "utf8");
    const tampered = original.replace(
      "### `rmd resume`\n\n```\nrmd resume\n```",
      "### `rmd resume`\n\n```\nrmd resume --hand-edited-drift\n```",
    );
    assert.notEqual(tampered, original, "fixture setup: the `rmd resume` section must actually exist to tamper");
    writeFileSync(out, tampered);
    const result = runCheck(out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /Drifted command\(s\): resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generate-cli-reference --check: a MISSING file -> non-zero exit, tells the operator how to generate it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-reference-missing-"));
  try {
    const result = runCheck(join(dir, "cli-reference.md"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /does not exist/);
    assert.match(output, /npm run cli-reference/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
