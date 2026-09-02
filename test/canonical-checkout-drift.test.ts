import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  measureCanonicalCheckoutDrift,
  recordCanonicalCheckoutDrift,
  worktreeAdd,
} from "../src/lib/worker.js";

// W1-T2618: `linkWorktreeNodeModules` (src/lib/worker.ts) symlinks EVERY worker worktree's
// `node_modules` onto the CANONICAL CHECKOUT's real tree — but a worktree's CODE is cut
// fresh from `origin/main` (worktreeAdd's own `git fetch` + `worktree add -b ... base`),
// while its DEPS come from whatever commit the canonical checkout's own HEAD happens to sit
// at. MASTER-PLAN.md:3418 records that checkout drifting ~100 commits behind `origin/main`
// per cycle, and nothing measured that distance at the one moment the system already knows
// the coupling exists. These tests pin the measurement this task adds: OBSERVED (never
// assumed), NAMED when behind, SILENT when current, and NEVER capable of failing worktree
// creation — the same best-effort return-value contract `linkWorktreeNodeModules` itself
// carries.

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function commit(clone: string, file: string, message: string): void {
  writeFileSync(join(clone, file), `${message}\n`);
  execFileSync("git", ["-C", clone, "add", "-A"]);
  execFileSync("git", ["-C", clone, "commit", "--no-verify", "--quiet", "-m", message]);
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "--quiet", "--initial-branch", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "probe@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "probe"]);
}

// ---------------------------------------------------------------------------------------
// measureCanonicalCheckoutDrift — pure branches, driven by an injected revListCount so no
// second real remote is needed for the current/behind/unknown shapes.
// ---------------------------------------------------------------------------------------

test("measureCanonicalCheckoutDrift reports current when the checkout's HEAD equals origin/<ref>", () => {
  const result = measureCanonicalCheckoutDrift("/canonical", "main", {
    revListCount: () => "0\n",
  });
  assert.deepEqual(result, { status: "current" });
});

test("measureCanonicalCheckoutDrift NAMES the measured distance when the checkout is behind", () => {
  const result = measureCanonicalCheckoutDrift("/canonical", "main", {
    revListCount: () => "137\n",
  });
  assert.deepEqual(result, { status: "behind", commits: 137 });
});

test("measureCanonicalCheckoutDrift degrades to unknown, never throws, when the count is unreadable", () => {
  assert.doesNotThrow(() => {
    const result = measureCanonicalCheckoutDrift("/canonical", "main", {
      revListCount: () => {
        throw new Error("fatal: not a git repository");
      },
    });
    assert.equal(result.status, "unknown");
    assert.match((result as { reason: string }).reason, /not a git repository/);
  });
});

test("measureCanonicalCheckoutDrift degrades to unknown, never throws, on unparseable rev-list output", () => {
  assert.doesNotThrow(() => {
    const result = measureCanonicalCheckoutDrift("/canonical", "main", {
      revListCount: () => "not-a-number\n",
    });
    assert.equal(result.status, "unknown");
  });
});

// ---------------------------------------------------------------------------------------
// measureCanonicalCheckoutDrift — real git, no injection, proving the DEFAULT read runs
// ONLY `git rev-list` (no fetch, no package manager, no install) and gets the count right.
// ---------------------------------------------------------------------------------------

test("measureCanonicalCheckoutDrift's real default read counts exactly the commits the checkout is behind", () => {
  const root = tmp("rmd-drift-behind-");
  const upstream = join(root, "upstream");
  const canonical = join(root, "canonical");
  try {
    initRepo(upstream);
    commit(upstream, "seed.txt", "chore: seed");
    execFileSync("git", ["clone", "--quiet", upstream, canonical]);
    execFileSync("git", ["-C", canonical, "config", "user.email", "probe@example.invalid"]);
    execFileSync("git", ["-C", canonical, "config", "user.name", "probe"]);
    // The canonical checkout is cloned once, then upstream moves on without it -- exactly
    // the shape MASTER-PLAN:3418 describes.
    commit(upstream, "a.txt", "chore: a");
    commit(upstream, "b.txt", "chore: b");
    commit(upstream, "c.txt", "chore: c");
    execFileSync("git", ["-C", canonical, "fetch", "origin", "--quiet"]);

    const result = measureCanonicalCheckoutDrift(canonical, "main");

    assert.deepEqual(result, { status: "behind", commits: 3 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measureCanonicalCheckoutDrift's real default read reports current for an up-to-date checkout", () => {
  const root = tmp("rmd-drift-current-");
  const upstream = join(root, "upstream");
  const canonical = join(root, "canonical");
  try {
    initRepo(upstream);
    commit(upstream, "seed.txt", "chore: seed");
    execFileSync("git", ["clone", "--quiet", upstream, canonical]);
    execFileSync("git", ["-C", canonical, "fetch", "origin", "--quiet"]);

    const result = measureCanonicalCheckoutDrift(canonical, "main");

    assert.deepEqual(result, { status: "current" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measureCanonicalCheckoutDrift's real default read runs no package manager and installs nothing", () => {
  // The 2026-07-29/08-05/08-11 outage class this repo keeps re-learning: an `npm ci` (or
  // any install) run against the shared canonical tree. A `postinstall` sentinel here would
  // only fire if something other than `git rev-list` ran against this checkout.
  const root = tmp("rmd-drift-no-install-");
  const upstream = join(root, "upstream");
  const canonical = join(root, "canonical");
  const sentinel = join(root, "sentinel-if-npm-ran.txt");
  try {
    initRepo(upstream);
    writeFileSync(
      join(upstream, "package.json"),
      JSON.stringify({
        name: "drift-probe",
        version: "0.0.0",
        scripts: { postinstall: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')"` },
      }),
    );
    commit(upstream, "seed.txt", "chore: seed");
    execFileSync("git", ["clone", "--quiet", upstream, canonical]);
    execFileSync("git", ["-C", canonical, "fetch", "origin", "--quiet"]);

    measureCanonicalCheckoutDrift(canonical, "main");

    assert.equal(
      existsSync(sentinel),
      false,
      "no install/package-manager subprocess must ever run as part of the measurement",
    );
    assert.equal(
      existsSync(join(canonical, "node_modules")),
      false,
      "the measurement must not create a node_modules of its own",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------
// recordCanonicalCheckoutDrift — the reporting wrapper wired into worktreeAdd: NAMES a
// behind checkout, stays silent when current, and never throws either way.
// ---------------------------------------------------------------------------------------

test("recordCanonicalCheckoutDrift NAMES the checkout and its distance when behind", () => {
  const warnings: string[] = [];
  const result = recordCanonicalCheckoutDrift("/canonical/checkout", "main", {
    measure: () => ({ status: "behind", commits: 42 }),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(result, { status: "behind", commits: 42 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /\/canonical\/checkout/);
  assert.match(warnings[0]!, /42/);
  assert.match(warnings[0]!, /main/);
});

test("recordCanonicalCheckoutDrift stays SILENT when the checkout is current -- a detector, not a permanent red", () => {
  const warnings: string[] = [];
  const result = recordCanonicalCheckoutDrift("/canonical/checkout", "main", {
    measure: () => ({ status: "current" }),
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(result, { status: "current" });
  assert.equal(warnings.length, 0, "an up-to-date checkout must record no fault");
});

test("recordCanonicalCheckoutDrift stays silent on unknown too -- unmeasurable is not the same as behind", () => {
  const warnings: string[] = [];
  recordCanonicalCheckoutDrift("/canonical/checkout", "main", {
    measure: () => ({ status: "unknown", reason: "not a git repository" }),
    warn: (m) => warnings.push(m),
  });
  assert.equal(warnings.length, 0);
});

test("recordCanonicalCheckoutDrift NEVER THROWS -- a stale deps source must never fail worktree creation", () => {
  assert.doesNotThrow(() =>
    recordCanonicalCheckoutDrift("/canonical/checkout", "main", {
      measure: () => ({ status: "behind", commits: 999 }),
    }),
  );
  assert.doesNotThrow(() =>
    recordCanonicalCheckoutDrift("/canonical/checkout", "main", {
      measure: () => ({ status: "current" }),
    }),
  );
});

// ---------------------------------------------------------------------------------------
// worktreeAdd wiring — the real dispatch path: a behind canonical checkout is named AND the
// symlink still proceeds; worktree creation itself never fails because of it.
// ---------------------------------------------------------------------------------------

test("worktreeAdd proceeds and NAMES the drift when its own repoDir is behind origin/<ref>", () => {
  const root = tmp("rmd-drift-wiring-behind-");
  const upstream = join(root, "upstream");
  const canonical = join(root, "canonical");
  const wt = join(root, "wt");
  try {
    initRepo(upstream);
    commit(upstream, "seed.txt", "chore: seed");
    execFileSync("git", ["-C", root, "clone", "--quiet", upstream, canonical]);
    execFileSync("git", ["-C", canonical, "config", "user.email", "probe@example.invalid"]);
    execFileSync("git", ["-C", canonical, "config", "user.name", "probe"]);
    // Upstream moves on two commits without the canonical checkout's own HEAD moving --
    // exactly the coupling W1-T2618 targets: worktreeAdd cuts the WORKTREE from the fresh
    // origin/main below, but repoDir's own tree (the node_modules symlink SOURCE) stays put.
    commit(upstream, "a.txt", "chore: a");
    commit(upstream, "b.txt", "chore: b");

    const warnings: string[] = [];
    assert.doesNotThrow(() =>
      worktreeAdd(canonical, wt, "run-drift-probe", "origin/main", {
        warn: (m) => warnings.push(m),
      }),
    );

    // The worktree really was created -- a stale deps source never blocks dispatch.
    const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.match(head, /^[0-9a-f]{40}$/);

    const driftWarnings = warnings.filter((w) => w.includes("canonical checkout drift"));
    assert.equal(driftWarnings.length, 1, "the drift must be named exactly once");
    assert.match(driftWarnings[0]!, /2 commit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktreeAdd stays silent about drift when repoDir is already current -- no false positive", () => {
  const root = tmp("rmd-drift-wiring-current-");
  const clone = join(root, "clone");
  const wt = join(root, "wt");
  try {
    initRepo(clone);
    commit(clone, "seed.txt", "chore: seed");
    // Self-referencing origin, same convention as the sibling worktreeAdd test suites: the
    // fetch below is a local no-op and repoDir's own HEAD is always current relative to it.
    execFileSync("git", ["-C", clone, "remote", "add", "origin", clone]);
    execFileSync("git", ["-C", clone, "fetch", "origin", "--quiet"]);

    const warnings: string[] = [];
    worktreeAdd(clone, wt, "run-drift-current-probe", "origin/main", {
      warn: (m) => warnings.push(m),
    });

    const driftWarnings = warnings.filter((w) => w.includes("canonical checkout drift"));
    assert.equal(driftWarnings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
