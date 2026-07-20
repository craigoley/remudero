import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// ── W3-T1b: packages/api-client GENERATOR + stale-client drift check (MASTER-PLAN §7A) ─────────
//
// §7A: "packages/api-client is GENERATED from that surface [openapi/daemon.yaml] and is the ONLY
// way any client talks to the daemon... drift between the committed client and the surface is
// caught in CI." This suite proves scripts/generate-api-client.mjs is ACTIVE, not merely present:
// a FRESH client (matches a regeneration byte-for-byte) turns `--check` green; a STALE one (spec
// edited without regenerating) turns it RED and names the file to regenerate -- same discipline as
// test/plan-index.test.ts (W1-T37) / test/learnings-index.test.ts (W1-T33). It also proves the
// REAL committed packages/api-client/src/schema.d.ts is currently fresh against the real
// openapi/daemon.yaml -- the same check CI runs, via `npm run api-client:check`, on every PR.
//
// (scripts/generate-api-client.mjs is a plain .mjs file outside tsconfig's `include`, so it's
// exercised here only via `spawnSync` against its CLI surface, mirroring test/plan-index.test.ts's
// convention for scripts/generate-plan-index.mjs.)

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-api-client.mjs");

const MINIMAL_SPEC = `
openapi: 3.1.0
info:
  title: Test surface
  version: 0.0.1
components:
  securitySchemes:
    bearerRead:
      type: http
      scheme: bearer
  schemas:
    Widget:
      type: object
      required: [name]
      properties:
        name:
          type: string
        count:
          type: number
paths: {}
`;

function runCheck(source: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, "--source", source, "--out", out, "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

function runGenerate(source: string, out: string) {
  return spawnSync(process.execPath, [SCRIPT, "--source", source, "--out", out], { cwd: REPO_ROOT, encoding: "utf8" });
}

test("generate-api-client (no --check) writes a client that a subsequent --check accepts", () => {
  const tmp = mkdtempSync(join(tmpdir(), "api-client-roundtrip-"));
  try {
    const source = join(tmp, "daemon.yaml");
    writeFileSync(source, MINIMAL_SPEC);
    const out = join(tmp, "schema.d.ts");
    const genResult = runGenerate(source, out);
    assert.equal(genResult.status, 0, genResult.stdout + genResult.stderr);

    const written = readFileSync(out, "utf8");
    assert.match(written, /GENERATED FILE -- DO NOT EDIT BY HAND/);
    assert.match(written, /Widget: \{/);
    assert.match(written, /name: string;/);
    assert.match(written, /count\?: number;/);
    assert.match(written, /bearerRead: \{ type: "http"; scheme: "bearer" \}/);

    const checkResult = runCheck(source, out);
    assert.equal(checkResult.status, 0, checkResult.stdout + checkResult.stderr);
    assert.match(checkResult.stdout + checkResult.stderr, /OK -- .*schema\.d\.ts matches/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-api-client --check: a STALE client (spec changed since generation) -> non-zero exit, NAMES the file to regenerate", () => {
  const tmp = mkdtempSync(join(tmpdir(), "api-client-stale-"));
  try {
    const source = join(tmp, "daemon.yaml");
    const out = join(tmp, "schema.d.ts");
    writeFileSync(source, MINIMAL_SPEC);
    assert.equal(runGenerate(source, out).status, 0);

    // Drift: add a new schema to the spec without regenerating the committed client.
    writeFileSync(
      source,
      MINIMAL_SPEC.replace("paths: {}", "    Gadget:\n      type: object\n      properties: {}\npaths: {}"),
    );
    const result = runCheck(source, out);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /is STALE/);
    assert.match(output, /schema\.d\.ts/);
    assert.match(output, /npm run api-client:generate/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-api-client --check: a MISSING committed client -> non-zero exit, tells the operator how to generate it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "api-client-missing-"));
  try {
    const source = join(tmp, "daemon.yaml");
    writeFileSync(source, MINIMAL_SPEC);
    const result = runCheck(source, join(tmp, "does-not-exist.d.ts"));
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /does not exist/);
    assert.match(output, /npm run api-client:generate/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate-api-client: an unresolvable $ref fails loudly (non-zero exit, names the bad ref) instead of emitting broken TS", () => {
  const tmp = mkdtempSync(join(tmpdir(), "api-client-bad-ref-"));
  try {
    const source = join(tmp, "daemon.yaml");
    writeFileSync(
      source,
      "openapi: 3.1.0\ninfo: { title: t, version: '1' }\ncomponents:\n  schemas:\n    Widget:\n      $ref: '#/components/schemas/DoesNotExist'\npaths: {}\n",
    );
    const result = runGenerate(source, join(tmp, "schema.d.ts"));
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /DoesNotExist/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── The real openapi/daemon.yaml + packages/api-client: the generated client is NOT stale ──────

test("the REAL committed packages/api-client/src/schema.d.ts is NOT stale (this is what CI checks on every PR via `npm run api-client:check`)", () => {
  // Relative paths + cwd: REPO_ROOT, matching the exact invocation `npm run api-client:check` uses
  // (no --source/--out overrides) -- an absolute --source would change the recorded source label
  // and produce a false-positive STALE result unrelated to real drift.
  const result = spawnSync(process.execPath, [SCRIPT, "--check"], { cwd: REPO_ROOT, encoding: "utf8" });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
});

test("the real generated client's components.schemas.Error mirrors src/lib/service.ts's error envelope", () => {
  const generated = readFileSync(join(REPO_ROOT, "packages", "api-client", "src", "schema.d.ts"), "utf8");
  assert.match(generated, /Error: \{/);
  assert.match(generated, /error: "unauthorized" \| "forbidden" \| "not_found" \| "invalid_request" \| "internal_error";/);
  assert.match(generated, /required_scope\?: "read" \| "write";/);
});
