import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

test("W1-T9903: osv-scanner.toml carries no ignore for GHSA-frvp-7c67-39w9 and no lockfile holds @hono/node-server below 2.0.5", () => {
  assert.doesNotMatch(readFileSync(join(REPO_ROOT, "osv-scanner.toml"), "utf8"), /GHSA-frvp-7c67-39w9/);

  const lockfiles = execFileSync("git", ["ls-files", "-z", "--", "package-lock.json", "**/package-lock.json"], {
    cwd: REPO_ROOT, encoding: "utf8",
  }).split("\0").filter(Boolean).sort();
  assert.ok(lockfiles.includes("package-lock.json"), "the root lockfile must be checked");
  assert.ok(lockfiles.includes("deploy/package-lock.json"), "the deploy lockfile must be checked");

  let rootMatches = 0;
  for (const path of lockfiles) {
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.endsWith("node_modules/@hono/node-server")) continue;
      if (path === "package-lock.json") rootMatches += 1;
      const version = entry.version ?? "";
      const parts = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.*)?$/.exec(version);
      assert.ok(parts, `${path}: ${key} must have a numeric semver, got ${version}`);
      const [major, minor, patch] = parts.slice(1, 4).map(Number);
      const aboveFixed = major > 2 || (major === 2 && (minor > 0 || patch > 5));
      const fixedRelease = major === 2 && minor === 0 && patch === 5 && !parts[4];
      assert.ok(aboveFixed || fixedRelease, `${path}: ${key}@${version} is below 2.0.5`);
    }
  }
  assert.ok(rootMatches > 0, "the root lockfile must contain @hono/node-server as a non-empty control");
});
