// W1-T3707 — TWO MANIFEST ALLOWLISTS DISAGREED, IN OPPOSITE DIRECTIONS.
//
// `src/lib/dep-review.ts` anchored every pattern to the repo root and REFUSED
// `apps/dashboard/package.json`; `scripts/head-identity-gate.mjs` matched on BASENAME and ADMITTED
// `test/fixtures/onboard/repo/package.json`. #5757 sat terminally stuck between them — checks
// green, review none — because dep-review's refusal is a terminal outcome the sweep will not
// re-derive.
//
// The repository already publishes which nested manifests are real: the root package.json's
// `workspaces` globs. This suite pins that ONE predicate, and pins BOTH directions of the old
// disagreement: a declared workspace is admitted, a fixture is not.
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { declaredWorkspaceGlobs, isManifestPath } from "../src/lib/dep-review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = pathToFileURL(join(__dirname, "..", "scripts", "head-identity-gate.mjs")).href;
const gate = (await import(GATE)) as {
  isDependencyManifestPath: (path: string, readRootManifest?: () => string) => boolean;
};

/** This repository's own declaration, as committed. */
const ROOT = () => JSON.stringify({ workspaces: ["packages/*", "apps/*"] });

// ── The workspace manifest dep-review refused, which is why #5757 could not be reviewed ─────────

test("a manifest inside a declared workspace is admitted", () => {
  for (const p of ["apps/dashboard/package.json", "packages/api-client/package.json", "packages/daemon-client-smoke/package-lock.json"]) {
    assert.equal(isManifestPath(p, ROOT), true, `${p} is a declared-workspace manifest`);
    assert.equal(gate.isDependencyManifestPath(p, ROOT), true, `${p} must agree in the gate`);
  }
});

// ── The fixture the gate admitted, which is the credit hole the path constraint exists to close ──

test("a manifest outside every declared workspace is refused", () => {
  for (const p of ["test/fixtures/onboard/repo/package.json", "scratch/package.json", "src/package.json"]) {
    assert.equal(isManifestPath(p, ROOT), false, `${p} is NOT a declared workspace`);
    assert.equal(gate.isDependencyManifestPath(p, ROOT), false, `${p} must agree in the gate`);
  }
});

test("root manifests and workflow files are admitted, unchanged", () => {
  for (const p of ["package.json", "package-lock.json", "go.mod", "Cargo.lock", ".github/workflows/ci.yml", ".github/workflows/codeql.yaml"]) {
    assert.equal(isManifestPath(p, ROOT), true, `${p} matched before W1-T3707 and must still match`);
  }
});

test("a source path is refused however deep it sits", () => {
  for (const p of ["src/run-task.ts", "apps/dashboard/src/main.ts", "packages/api-client/index.ts", "deploy/Dockerfile"]) {
    assert.equal(isManifestPath(p, ROOT), false);
    assert.equal(gate.isDependencyManifestPath(p, ROOT), false);
  }
});

// ── No declaration, or an unreadable one, means ROOT ONLY — today's dep-review behaviour ─────────

test("a repository declaring no workspaces admits root manifests only", () => {
  const none = () => JSON.stringify({ name: "x" });
  assert.equal(isManifestPath("package.json", none), true);
  assert.equal(isManifestPath("apps/dashboard/package.json", none), false, "nothing is declared, so nothing nested is admitted");
  assert.equal(declaredWorkspaceGlobs(none), undefined);
});

test("an unreadable root manifest refuses nested paths rather than falling back to basename", () => {
  const broken = () => "{ not json";
  const throws = () => { throw new Error("ENOENT"); };
  for (const read of [broken, throws]) {
    assert.equal(declaredWorkspaceGlobs(read), undefined);
    assert.equal(isManifestPath("apps/dashboard/package.json", read), false, "an unreadable declaration is the narrow direction");
    assert.equal(isManifestPath("package.json", read), true, "a ROOT path needs no declaration");
  }
});

test("omitting the reader entirely refuses nested paths", () => {
  assert.equal(isManifestPath("apps/dashboard/package.json"), false);
  assert.equal(isManifestPath("package.json"), true);
});

// ── The glob forms npm actually supports, and nothing else ───────────────────────────────────────

test("a workspace glob matches one level only, never a deeper path", () => {
  assert.equal(isManifestPath("apps/dashboard/nested/package.json", ROOT), false, "apps/* is one level");
  assert.equal(isManifestPath("apps/dashboard/package.json", ROOT), true);
});

test("a plain directory entry is honoured and an unsupported glob matches nothing", () => {
  assert.equal(isManifestPath("tools/cli/package.json", () => JSON.stringify({ workspaces: ["tools/cli"] })), true);
  // A glob this predicate does not understand must match NOTHING — admitting too much is the
  // failure that matters here, so an unparsed pattern fails closed rather than open.
  assert.equal(isManifestPath("anything/deep/package.json", () => JSON.stringify({ workspaces: ["**"] })), false);
});

test("the yarn object form of workspaces is read", () => {
  const yarnish = () => JSON.stringify({ workspaces: { packages: ["apps/*"] } });
  assert.deepEqual(declaredWorkspaceGlobs(yarnish), ["apps/*"]);
  assert.equal(isManifestPath("apps/dashboard/package.json", yarnish), true);
});
