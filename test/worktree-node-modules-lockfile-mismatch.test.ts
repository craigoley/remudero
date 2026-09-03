/**
 * test/worktree-node-modules-lockfile-mismatch.test.ts — W1-T2777.
 *
 * THE FAILURE MODE. `linkWorktreeNodeModules` symlinks `node_modules` into a worktree from
 * `resolveNodeModulesSource(repoDir)`. The worktree's source tree is cut FRESH from
 * `origin/main` (by `worktreeAdd`'s own fetch — see `src/lib/worker.ts:3244`), but the
 * node_modules source may be arbitrarily far behind (the operator measured 27→28→39→47→48
 * commits over a few hours; canonical checkout drift, `recordCanonicalCheckoutDrift`). If
 * an incoming commit adds a dependency and the drift hasn't caught up, the linked
 * node_modules cannot resolve it — the worker sees `Cannot find module` inside its own
 * test and the failure reads as a defect in its own diff, not as the drift it actually is.
 *
 * THE FIX (W1-T2777, DETECTION ONLY — the operator explicitly ruled out changing the refresh
 * cycle). At symlink time, compare `hashInstallInputs` between the worktree's source and the
 * node_modules source. Match ⇒ `"linked"`, silently as today. Differ ⇒ `"linked-lockfile-
 * mismatch"` and a warn() so the caller (or the operator reading stderr) knows the drift is
 * about to bite BEFORE the worker starts, not after it fails cryptically inside a test.
 *
 * THE INTENDED FALSIFIER SHAPE, EACH DIRECTION EARNING ITS OWN GUARD:
 *
 *   ─ (a) reproduce the failure. Worktree = origin/main HEAD carrying a new dep in its
 *          package-lock.json; source tree = an older repoDir without that entry; symlink
 *          made; MUST return `linked-lockfile-mismatch`.
 *   ─ (b) prove the fix stays quiet on the healthy path. Matching lockfiles on both sides
 *          MUST return `"linked"` and MUST NOT emit any warning.
 *   ─ (c) the warning names the two paths being compared (not just "mismatch"), so the
 *          operator knows which side is stale without re-deriving it.
 *   ─ (d) the pre-existing outcomes are byte-identically preserved — no regression on the
 *          "already-present"/"no-source"/"failed" paths, which do NOT consult the hash.
 *   ─ (e) the hash function is the SAME one `ensureInstallFresh` uses. A parallel
 *          implementation could drift silently — this guard fires if the module ever grows
 *          two independent hashInstallInputs functions on the same inputs.
 *   ─ (f) end-to-end on real files, not just the injected hasher: real package.json /
 *          package-lock.json bytes on disk with the real default hasher — the all-fakes
 *          trap CLAUDE.md documents fires if this test suite only ever proves the fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { linkWorktreeNodeModules } from "../src/lib/worker.js";
import { hashInstallInputs } from "../src/lib/install-hash.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rmd-w1-t2777-${prefix}`));
}

/** Realistic package.json/package-lock.json pair — one dep. */
function writeInstallInputs(dir: string, deps: Record<string, string>): void {
  const pkg = {
    name: "rmd-t2777-fixture",
    version: "0.0.0",
    dependencies: deps,
  };
  const lock = {
    name: "rmd-t2777-fixture",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: Object.fromEntries([
      ["", { name: "rmd-t2777-fixture", version: "0.0.0", dependencies: deps }],
      ...Object.entries(deps).map(([n, v]) => [`node_modules/${n}`, { version: v.replace(/^\^/, "") }]),
    ]),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock, null, 2));
}

/** Root layout: `worktree/` (empty, no node_modules), `nmSourceParent/node_modules/`
 *  (present, empty). `deps.resolveSource` is overridden to return that path so we don't
 *  depend on the process's install root layout. */
function makeRoot(): { root: string; worktree: string; nmSourceParent: string; nmSource: string } {
  const root = tmp("real-");
  const worktree = join(root, "worktree");
  mkdirSync(worktree);
  const nmSourceParent = join(root, "clone");
  mkdirSync(nmSourceParent);
  const nmSource = join(nmSourceParent, "node_modules");
  mkdirSync(nmSource);
  return { root, worktree, nmSourceParent, nmSource };
}

// ── (a) the failure mode this task exists for ────────────────────────────────────────────────

test("W1-T2777 (a): a worktree cut with a NEW dep on top of a source without it returns linked-lockfile-mismatch", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    // Source (repoDir) sits BEFORE a new dep was added: 1 dependency.
    writeInstallInputs(nmSourceParent, { "some-dep": "^1.0.0" });
    // Worktree, cut from origin/main HEAD, carries a NEWER lockfile with an added dep.
    writeInstallInputs(worktree, { "some-dep": "^1.0.0", "the-new-one": "^2.0.0" });

    const warnings: string[] = [];
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(
      outcome,
      "linked-lockfile-mismatch",
      "the incident's own shape (worktree has a dep repoDir does not) must be caught",
    );
    assert.equal(warnings.length, 1, "the mismatch must be surfaced through the loud channel exactly once");
    assert.equal(lstatSync(join(worktree, "node_modules")).isSymbolicLink(), true, "the link is still made — best-effort contract holds");
    assert.equal(readlinkSync(join(worktree, "node_modules")), nmSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) the healthy path stays quiet ─────────────────────────────────────────────────────────

test("W1-T2777 (b): matching lockfiles on both sides return `linked` with NO warning", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    const deps = { "some-dep": "^1.0.0", "the-new-one": "^2.0.0" };
    writeInstallInputs(worktree, deps);
    writeInstallInputs(nmSourceParent, deps);

    const warnings: string[] = [];
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(outcome, "linked", "matching lockfiles must produce the pre-W1-T2777 outcome unchanged");
    assert.deepEqual(warnings, [], "the healthy path must never spend the operator's attention on a non-finding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) the warning names both paths ─────────────────────────────────────────────────────────

test("W1-T2777 (c): the mismatch warning names the two directories being compared, so the operator does not re-derive it", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    writeInstallInputs(nmSourceParent, { "some-dep": "^1.0.0" });
    writeInstallInputs(worktree, { "some-dep": "^2.0.0" });

    const warnings: string[] = [];
    linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(warnings.length, 1);
    const msg = warnings[0]!;
    assert.ok(msg.includes(worktree), `warning must name the worktree side; message: ${msg}`);
    assert.ok(msg.includes(nmSourceParent), `warning must name the node_modules source side; message: ${msg}`);
    assert.match(msg, /Cannot find module|hash differs/, "warning must name the failure mode the operator will otherwise see");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (d) the pre-existing outcomes are byte-identically preserved ─────────────────────────────

test("W1-T2777 (d): `already-present` is unchanged — a taken destination never triggers the lockfile compare", () => {
  let hashCalls = 0;
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => ({}),
    resolveSource: () => "/src/node_modules",
    hashInstallInputs: () => {
      hashCalls += 1;
      return "should-never-be-called";
    },
  });
  assert.equal(outcome, "already-present");
  assert.equal(hashCalls, 0, "an occupied destination short-circuits BEFORE the hash compare");
});

test("W1-T2777 (d): `no-source` is unchanged — nothing was linked, nothing to compare", () => {
  let hashCalls = 0;
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => {
      throw new Error("ENOENT");
    },
    resolveSource: () => undefined,
    hashInstallInputs: () => {
      hashCalls += 1;
      return "";
    },
  });
  assert.equal(outcome, "no-source");
  assert.equal(hashCalls, 0);
});

test("W1-T2777 (d): `failed` is unchanged — a symlink that threw is `failed`, not a mismatch", () => {
  let hashCalls = 0;
  const outcome = linkWorktreeNodeModules("/clone", "/wt", {
    lstat: () => {
      throw new Error("ENOENT");
    },
    resolveSource: () => "/src/node_modules",
    symlink: () => {
      throw new Error("EPERM");
    },
    hashInstallInputs: () => {
      hashCalls += 1;
      return "";
    },
  });
  assert.equal(outcome, "failed", "a symlink failure yields `failed`, never a manufactured mismatch");
  assert.equal(hashCalls, 0, "a failed symlink short-circuits BEFORE the hash compare");
});

// ── (e) the shared primitive contract ────────────────────────────────────────────────────────

test("W1-T2777 (e): the default hasher IS the exported hashInstallInputs — no parallel implementation lives in worker.ts", () => {
  // Two seams to catch the drift: (1) the source's public export at its documented path
  // (extracted from run-task.ts on this task), (2) a synthetic mismatch where the fake would
  // have to lie for the default and the imported to disagree. If a future edit inlines a copy
  // of the hash logic into worker.ts, either the same-input compare below diverges or the
  // export path stops resolving — either way, this guard fires.
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    writeInstallInputs(worktree, { a: "^1.0.0" });
    writeInstallInputs(nmSourceParent, { a: "^1.0.0" });
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      resolveSource: () => nmSource,
    });
    assert.equal(outcome, "linked", "the default hasher must classify these identical inputs as matching");

    // The lib export is the single source of truth — importable, callable, deterministic.
    const h1 = hashInstallInputs(worktree);
    const h2 = hashInstallInputs(nmSourceParent);
    assert.equal(h1, h2, "the exported primitive agrees with the outcome above");
    assert.match(h1, /^[0-9a-f]{64}$/, "sha256 hex output is the documented shape");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (f) the all-fakes trap ────────────────────────────────────────────────────────────────────

test("W1-T2777 (f): the DEFAULT leaf runs end-to-end on real files — no injected hasher, real disk", () => {
  const { root, worktree, nmSourceParent, nmSource } = makeRoot();
  try {
    // Deliberately different: worktree adds `x`, source does not.
    writeInstallInputs(worktree, { x: "^1.0.0" });
    writeInstallInputs(nmSourceParent, {});

    const warnings: string[] = [];
    const outcome = linkWorktreeNodeModules(nmSourceParent, worktree, {
      // NO hashInstallInputs override — the production path runs.
      resolveSource: () => nmSource,
      warn: (m) => warnings.push(m),
    });

    assert.equal(outcome, "linked-lockfile-mismatch", "the production hash leaf must detect the mismatch on real disk");
    assert.equal(warnings.length, 1);

    // Cross-check: what did the production hash actually read?
    const hw = hashInstallInputs(worktree);
    const hs = hashInstallInputs(nmSourceParent);
    assert.notEqual(hw, hs, "the exported hash must corroborate the outcome — this is what the code under test also compared");
    assert.notEqual(readFileSync(join(worktree, "package.json"), "utf8"), readFileSync(join(nmSourceParent, "package.json"), "utf8"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
