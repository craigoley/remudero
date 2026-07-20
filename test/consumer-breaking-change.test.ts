import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

// ── W3-T1c: a consumer whose CI goes red on a breaking surface change (MASTER-PLAN §7A) ─────
//
// §7A: "A breaking contract change must fail CI in EVERY consumer in the SAME PR -- this is the
// whole reason the clients live in one repo (D-5). Drift cannot ship." packages/daemon-client-
// smoke is that consumer, minimal on purpose (no real client exists yet -- apps/dashboard is
// W3-T2, which depends on this task). Its typecheck is already wired into CI for free:
// tsconfig.json's `include` covers `packages/*/src/**/*.ts`, and the `ci` job's `npx tsc -p
// tsconfig.json --noEmit` step (.github/workflows/ci.yml) runs UNCONDITIONALLY on every PR.
//
// This suite proves that wiring is ACTUALLY load-bearing, not merely present: it drives the real
// `tsc` binary against packages/daemon-client-smoke/src/index.ts under a FIXTURE
// `@remudero/api-client` whose generated schema.d.ts has been mutated the way a breaking
// `openapi/daemon.yaml` edit + regeneration would mutate the real committed file --
//   1) a property rename (`error` -> `errorCode` on components.schemas.Error) -- direct property
//      access breaks.
//   2) an enum-member rename (`"internal_error"` -> `"server_error"` on the same field) -- the
//      exhaustive switch's `never` check breaks.
// -- and proves the REAL committed schema.d.ts compiles GREEN today. Same "drive the real CLI
// against a controlled fixture, then restore" discipline as test/api-client-drift-check.test.ts /
// test/strict-probe.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const CONSUMER_SRC = join(REPO_ROOT, "packages", "daemon-client-smoke", "src", "index.ts");
const API_CLIENT_PACKAGE_JSON = join(REPO_ROOT, "packages", "api-client", "package.json");
const REAL_SCHEMA = join(REPO_ROOT, "packages", "api-client", "src", "schema.d.ts");

/** Build a self-contained fixture dir: node_modules/@remudero/api-client (given schema.d.ts) + a copy of the real consumer source, so `tsc` resolves the bare `@remudero/api-client` import via plain node_modules lookup -- no workspace/monorepo tooling involved. */
function buildFixture(schemaContent: string) {
  const tmp = mkdtempSync(join(tmpdir(), "consumer-breaking-change-"));
  const pkgDir = join(tmp, "node_modules", "@remudero", "api-client");
  mkdirSync(join(pkgDir, "src"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), readFileSync(API_CLIENT_PACKAGE_JSON, "utf8"));
  writeFileSync(join(pkgDir, "src", "schema.d.ts"), schemaContent);
  writeFileSync(join(tmp, "consumer.ts"), readFileSync(CONSUMER_SRC, "utf8"));
  return tmp;
}

function typecheckFixture(tmp: string) {
  return spawnSync(
    process.execPath,
    [
      TSC_BIN,
      "--noEmit",
      "--skipLibCheck",
      "--ignoreConfig",
      "--strict",
      "true",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "ES2022",
      join(tmp, "consumer.ts"),
    ],
    { cwd: tmp, encoding: "utf8" },
  );
}

test("consumer-breaking-change: the REAL committed schema.d.ts -> packages/daemon-client-smoke compiles GREEN", () => {
  const tmp = buildFixture(readFileSync(REAL_SCHEMA, "utf8"));
  try {
    const result = typecheckFixture(tmp);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("consumer-breaking-change: renaming components.schemas.Error.error -> consumer typecheck goes RED, then GREEN again once reverted", () => {
  const real = readFileSync(REAL_SCHEMA, "utf8");
  const mutated = real.replace('error: "unauthorized"', 'errorCode: "unauthorized"');
  assert.notEqual(mutated, real, "fixture setup: the field-rename mutation must actually change the schema");

  const redTmp = buildFixture(mutated);
  try {
    const redResult = typecheckFixture(redTmp);
    const output = redResult.stdout + redResult.stderr;
    assert.notEqual(redResult.status, 0, output);
    assert.match(output, /consumer\.ts/);
  } finally {
    rmSync(redTmp, { recursive: true, force: true });
  }

  // Revert: the unmutated (real) schema compiles clean again -- proves the RED result above was
  // caused by the rename, not a broken fixture.
  const greenTmp = buildFixture(real);
  try {
    const greenResult = typecheckFixture(greenTmp);
    assert.equal(greenResult.status, 0, greenResult.stdout + greenResult.stderr);
  } finally {
    rmSync(greenTmp, { recursive: true, force: true });
  }
});

test("consumer-breaking-change: renaming an enum member of components.schemas.Error.error -> the exhaustive switch goes RED, then GREEN again once reverted", () => {
  const real = readFileSync(REAL_SCHEMA, "utf8");
  const mutated = real.replace('"internal_error"', '"server_error"');
  assert.notEqual(mutated, real, "fixture setup: the enum-rename mutation must actually change the schema");

  const redTmp = buildFixture(mutated);
  try {
    const redResult = typecheckFixture(redTmp);
    const output = redResult.stdout + redResult.stderr;
    assert.notEqual(redResult.status, 0, output);
    assert.match(output, /consumer\.ts/);
  } finally {
    rmSync(redTmp, { recursive: true, force: true });
  }

  const greenTmp = buildFixture(real);
  try {
    const greenResult = typecheckFixture(greenTmp);
    assert.equal(greenResult.status, 0, greenResult.stdout + greenResult.stderr);
  } finally {
    rmSync(greenTmp, { recursive: true, force: true });
  }
});
