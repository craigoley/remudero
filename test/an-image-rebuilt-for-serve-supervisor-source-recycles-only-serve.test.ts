/**
 * test/an-image-rebuilt-for-serve-supervisor-source-recycles-only-serve.test.ts — W1-T9094.
 *
 * Core recycled 11 times in 24 h on 2026-10-12/13, and 13 of the 14 merges that rebuilt the image
 * touched only BAKED_RUNTIME_SOURCE_PATHS — source the image-resident SERVE supervisor executes. A
 * daemon (`build`) container runs its daemon and workers from mounted checkouts, so such a commit
 * never makes its image stale. The deploy cycle counts image drift per role: `build` counts only the
 * image inputs it executes, `serve` and an unknown role keep the full baked list.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { BAKED_RUNTIME_SOURCE_PATHS } from "../src/lib/baked-runtime-inputs.js";
import { BUILD_ROLE_IMAGE_BAKED_PATHS, imageBakedPathsForRole } from "../src/lib/deploy-judge.js";
import {
  IMAGE_BAKED_PATHS,
  IMAGE_DRIFT_SCOPED_STEP,
  bakedPathCommitsBehind,
  realDeployDeps,
  roleScopedBakedCommitsBehind,
} from "../src/lib/deployer.js";

const IMAGE_SHA = "a".repeat(40);
const LEDGER_ONLY = ["src/lib/ledger.ts"];
const DOCKERFILE = ["deploy/Dockerfile"];

/** A fake `git` over the commits origin/main has past the image sha: path-limited `rev-list --count`
 *  and `log --name-only` answer exactly as git would for that history. */
function fakeGit(commits: readonly (readonly string[])[], opts: { logThrows?: string } = {}) {
  return (args: readonly string[]): string => {
    const dash = args.indexOf("--");
    const paths = dash === -1 ? [] : args.slice(dash + 1);
    const touching = commits.filter((files) => files.some((f) => paths.includes(f)));
    if (args[0] === "rev-list" && args[1] === "--count" && args[2] === `${IMAGE_SHA}..origin/main`) {
      return `${touching.length}\n`;
    }
    if (args[0] === "log" && args.includes("--name-only") && args.includes(`${IMAGE_SHA}..origin/main`)) {
      if (opts.logThrows) throw new Error(opts.logThrows);
      return touching.flatMap((files) => ["", ...files.filter((f) => paths.includes(f))]).join("\n") + "\n";
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

function collectLog() {
  const rows: { step: string; data?: Record<string, unknown> }[] = [];
  return { rows, log: (step: string, data?: Record<string, unknown>) => void rows.push({ step, data }) };
}

test("W1-T9094: a build container ignores a serve-supervisor-only commit", () => {
  // The build role's list is the full list minus the serve supervisor's source, nothing else.
  assert.deepEqual(
    [...BUILD_ROLE_IMAGE_BAKED_PATHS].sort(),
    [".dockerignore", "deploy/Dockerfile", "deploy/codex-requirements.toml", "deploy/entrypoint.sh",
      "deploy/package-lock.json", "deploy/package.json"],
  );
  for (const src of BAKED_RUNTIME_SOURCE_PATHS) assert.equal(imageBakedPathsForRole("build").includes(src), false, src);

  const git = fakeGit([LEDGER_ONLY]);
  assert.equal(bakedPathCommitsBehind(IMAGE_SHA, git, "build"), 0);

  // The withheld recycle is ledgered: both counts and the files that would have recycled core.
  const { rows, log } = collectLog();
  assert.equal(roleScopedBakedCommitsBehind(IMAGE_SHA, git, "build", log), 0);
  assert.deepEqual(rows, [
    { step: IMAGE_DRIFT_SCOPED_STEP, data: { role: "build", behind_all: 1, behind_role: 0, files: ["src/lib/ledger.ts"] } },
  ]);
  assert.equal(IMAGE_DRIFT_SCOPED_STEP, "deploy.image_drift_scoped");

  // The real deploy cycle's producer reads the role the watchdog launcher sets (RMD_RESOURCE_POLICY_ROLE=build).
  const saved = process.env.RMD_RESOURCE_POLICY_ROLE;
  process.env.RMD_RESOURCE_POLICY_ROLE = "build";
  try {
    const real = collectLog();
    const deps = realDeployDeps({
      installPath: "/repo",
      stateRoot: "/state",
      daemonLabel: "com.remudero.daemon",
      serveLabel: "com.remudero.serve",
      servePort: 4317,
      uid: 502,
      ledgerPath: "/state/ledger.ndjson",
      log: real.log,
      sleep: () => {},
      execFile: (cmd: string, args: string[]): string => {
        if (cmd === "docker") return `${IMAGE_SHA}\n`;
        if (cmd !== "git") throw new Error(`unexpected exec ${cmd}`);
        const gitArgs = args.slice(2); // drop `-C /repo`
        // W1-T10366: the dependency fingerprint reads the root lockfile + manifest at the image sha
        // and origin/main; both refs carry the same inputs here, so no dependency drift.
        if (gitArgs[0] === "show") {
          return String(gitArgs[1]).endsWith(":package-lock.json")
            ? JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fixture" } } }) : "{}";
        }
        return git(gitArgs);
      },
    });
    assert.equal(deps.imageBakedCommitsBehind?.(), 0, "core is not stale for a ledger.ts-only commit");
    assert.deepEqual(real.rows.filter((r) => r.step === IMAGE_DRIFT_SCOPED_STEP).map((r) => r.data?.behind_all), [1]);
  } finally {
    if (saved === undefined) delete process.env.RMD_RESOURCE_POLICY_ROLE;
    else process.env.RMD_RESOURCE_POLICY_ROLE = saved;
  }
});

test("W1-T9094: serve still counts it and a Dockerfile change counts for both", () => {
  const ledgerOnly = fakeGit([LEDGER_ONLY]);
  const { rows, log } = collectLog();
  assert.equal(roleScopedBakedCommitsBehind(IMAGE_SHA, ledgerOnly, "serve", log), 1);
  assert.equal(imageBakedPathsForRole("serve"), IMAGE_BAKED_PATHS);

  const withDockerfile = fakeGit([DOCKERFILE, LEDGER_ONLY]);
  assert.equal(roleScopedBakedCommitsBehind(IMAGE_SHA, withDockerfile, "serve", log), 2);
  assert.equal(roleScopedBakedCommitsBehind(IMAGE_SHA, fakeGit([DOCKERFILE]), "build", log), 1);
  // No scoped row while the two counts agree; the serve role never writes one.
  assert.deepEqual(rows, []);

  // Dockerfile plus serve source: build counts only the Dockerfile commit, and says what it withheld.
  assert.equal(roleScopedBakedCommitsBehind(IMAGE_SHA, withDockerfile, "build", log), 1);
  assert.deepEqual(rows, [
    { step: IMAGE_DRIFT_SCOPED_STEP, data: { role: "build", behind_all: 2, behind_role: 1, files: ["src/lib/ledger.ts"] } },
  ]);

  // An unreadable withheld-files walk still records the counts, and names why files is empty.
  const broken = collectLog();
  assert.equal(roleScopedBakedCommitsBehind(IMAGE_SHA, fakeGit([LEDGER_ONLY], { logThrows: "log exploded" }), "build", broken.log), 0);
  assert.deepEqual(broken.rows, [
    {
      step: IMAGE_DRIFT_SCOPED_STEP,
      data: { role: "build", behind_all: 1, behind_role: 0, files: [], files_error: "log exploded" },
    },
  ]);
});

test("W1-T9094: an unknown role keeps the full baked list", () => {
  for (const role of [undefined, "", "worker"]) {
    assert.equal(imageBakedPathsForRole(role), IMAGE_BAKED_PATHS, String(role));
    const { rows, log } = collectLog();
    assert.equal(roleScopedBakedCommitsBehind(IMAGE_SHA, fakeGit([LEDGER_ONLY]), role, log), 1, String(role));
    assert.deepEqual(rows, []);
  }
  assert.equal(bakedPathCommitsBehind(IMAGE_SHA, fakeGit([LEDGER_ONLY])), 1);
  // UNKNOWN stays unknown for every role: no image sha is never "current".
  assert.equal(roleScopedBakedCommitsBehind(undefined, fakeGit([LEDGER_ONLY]), "build", () => {}), undefined);
});
