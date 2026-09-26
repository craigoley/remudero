// W1-T4566: apps/dashboard was a third console that nothing served after W1-T4563 retired the
// /console/* mount, yet every PR still typechecked, tested and bundled it. It is deleted with every
// place that ran it. Each assertion reads the shipped file, so a half-removal (a job gone but its
// parity row kept, a workspace gone but its script kept) is named here rather than left to red in CI.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CI_PARITY_TABLE, parseCiJobNames } from "../src/lib/ci-parity.js";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const DASHBOARD_SCRIPTS = ["dashboard:ci", "build:console", "test:dashboard", "typecheck:dashboard"];

test("W1-T4566: no CI job or parity entry runs the retired dashboard", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.equal(parseCiJobNames(ci).includes("dashboard"), false, "ci.yml has no dashboard job");
  for (const script of DASHBOARD_SCRIPTS) assert.equal(ci.includes(script), false, `ci.yml runs no ${script}`);
  assert.equal(/steps\.dashboard\b/.test(ci), false, "no step reports a dashboard outcome");
  assert.equal(CI_PARITY_TABLE.some((entry) => entry.job === "dashboard"), false, "no CI_PARITY_TABLE row for dashboard");
  assert.equal(read(".github/workflows/ci-gate.yml").includes('"dashboard"'), false, "ci-gate.yml lists no dashboard check");
  assert.equal(read("src/lib/gate-posture.ts").includes('"ci:dashboard"'), false, "gate-posture declares no ci:dashboard");
  for (const path of ["deploy/Dockerfile", "deploy/entrypoint.sh", "deploy/serve-container.sh"]) {
    const text = read(path);
    assert.equal(text.includes("build:console") || text.includes("RMD_CONSOLE_BUILD_ROOT"), false, `${path} builds no console`);
  }
});

test("W1-T4566: the workspace set no longer names apps", () => {
  const manifest = JSON.parse(read("package.json")) as { workspaces: string[]; scripts: Record<string, string> };
  assert.deepEqual(manifest.workspaces, ["packages/*"]);
  for (const script of DASHBOARD_SCRIPTS) assert.equal(script in manifest.scripts, false, `package.json has no ${script}`);
  assert.equal(existsSync(join(ROOT, "apps", "dashboard", "package.json")), false, "apps/dashboard is deleted");
  const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { workspaces?: string[] }> };
  assert.deepEqual(lock.packages[""]?.workspaces, ["packages/*"], "the lockfile's root declares the same workspaces");
  assert.deepEqual(
    Object.keys(lock.packages).filter((key) => key.startsWith("apps/") || key === "node_modules/@remudero/dashboard"),
    [],
    "the lockfile carries no apps/ entry and no link to one",
  );
});
