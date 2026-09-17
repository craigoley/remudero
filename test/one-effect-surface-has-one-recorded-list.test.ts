import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import {
  buildSweepEffects as buildLibSweepEffects,
  DEFAULT_SWEEP_POLICY,
  SWEEP_EFFECT_SURFACE,
  type BuildSweepEffectsDeps,
} from "../src/lib/sweep.js";
import { buildSweepEffects as buildEntrypointSweepEffects } from "../src/run-task.js";

/**
 * test/one-effect-surface-has-one-recorded-list.test.ts — W1-T3654.
 *
 * MEASURED ON #5725, 2026-09-16 (see the rationale on that task, and `SWEEP_EFFECT_SURFACE`'s own
 * doc in `src/lib/sweep.ts`): `buildSweepEffects`' member list used to be transcribed BY HAND into
 * two separately-ordered `EFFECT_KEYS` constants, one per surface suite. A member added to the
 * surface and declared in only one of those two hand copies turned a real regression (W1-T2890's
 * lib-vs-entrypoint invariant, broken) into what looked like a plain bookkeeping mismatch, because
 * the failing job only ever named the copy that was stale.
 *
 * This suite pins the fix directly:
 *   1. both surface suites read ONE recorded list (`SWEEP_EFFECT_SURFACE`), so a member declared
 *      there is automatically what both builders are checked against;
 *   2. the lib-vs-entrypoint comparison W1-T2890 added still runs, unweakened;
 *   3. a member present on one builder and missing from the other still fails — and the failure
 *      NAMES which side is missing it, rather than reading as two unrelated mismatches; and
 *   4. re-introducing a second hand-copied list is refused, not merely undetected.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRYPOINT_SUITE = "test/build-sweep-effects-takes-one-deps-object.test.ts";
const LIB_SUITE = "test/sweep-orchestration-lives-in-lib.test.ts";

function baseDeps(root: string): BuildSweepEffectsDeps {
  return {
    owner: "craigoley",
    repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T3654",
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log: () => {},
    policy: DEFAULT_SWEEP_POLICY,
    reviewRunner: async () => 0,
    issuesImpl: { create: () => "https://github.com/craigoley/remudero/issues/3654" },
    stallNotice: () => {},
    armImpl: () => "armed",
    armSessionPrsOverride: false,
    updateBranchImpl: async () => "updated",
    captureRepairFeedbackImpl: () => {},
    ghRunImpl: () => {},
    spawnWallClockBoundMsOverride: 1,
    reclaimWorkerImpl: () => {},
    disarmImpl: () => undefined,
    readJsonImpl: async () => ({}),
    updatePrBodyImpl: async () => {},
    registeredWorktreeOwnerImpl: () => undefined,
  };
}

/** git grep, scoped to a small file set — never a read of the whole tree; see
 *  test/a-wall-clock-bound-declares-itself.test.ts for why that discipline matters here too. */
function gitGrepCount(pattern: string, files: readonly string[]): number {
  try {
    const out = execFileSync("git", ["grep", "-c", "-E", pattern, "--", ...files], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out
      .split("\n")
      .filter(Boolean)
      .reduce((sum, line) => sum + Number(line.split(":").pop()), 0);
  } catch (e) {
    const err = e as { status?: number };
    if (err.status === 1) return 0; // git grep exits 1 on no match — not an error here.
    throw e;
  }
}

// ── (1) one recorded list is enough to pin BOTH surfaces ─────────────────────────────────────────

test("W1-T3654: one recorded list (SWEEP_EFFECT_SURFACE) validates both the lib and the entrypoint surface", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-one-effect-surface-"));
  try {
    const deps = baseDeps(root);
    const libEffects = buildLibSweepEffects(deps);
    const entrypointEffects = buildEntrypointSweepEffects(deps);

    assert.ok(SWEEP_EFFECT_SURFACE.length > 0, "the recorded list must be a real population");
    assert.deepEqual(Object.keys(libEffects).sort(), [...SWEEP_EFFECT_SURFACE].sort());
    assert.deepEqual(Object.keys(entrypointEffects).sort(), [...SWEEP_EFFECT_SURFACE].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (2) the lib-vs-entrypoint comparison W1-T2890 added still runs ───────────────────────────────

test("W1-T2890's invariant survives: the lib-built and entrypoint-built surfaces are still compared to each other", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-one-effect-surface-invariant-"));
  try {
    const deps = baseDeps(root);
    const libEffects = buildLibSweepEffects(deps);
    const entrypointEffects = buildEntrypointSweepEffects(deps);

    // Not just "both match the recorded list" (proven above) — the two BUILDERS are compared
    // directly to each other, which is the assertion that caught #5725's real regression and
    // that a symmetric "both match the list" check alone would not.
    assert.deepEqual(
      Object.keys(libEffects).sort(),
      Object.keys(entrypointEffects).sort(),
      "the lib and entrypoint builders must expose the identical effect surface",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the lib-vs-entrypoint suite still imports and compares both builders", () => {
  // A grep-based confirmation that the OTHER suite's comparison is still wired, not weakened into
  // "only compares against the recorded list" — the failure mode the design explicitly forbids
  // ("collapsing them would lose the second [assertion], which is the one that caught #5725's
  // real defect"). Scoped to test/ files, never a src/ path — outside the source-text ratchet's
  // population (test/source-text-assertion-census.test.ts counts only `readFileSync` reads of
  // `src/` text) and this uses `git grep`, not `readFileSync`, regardless.
  assert.ok(
    gitGrepCount("buildEntrypointSweepEffects", [LIB_SUITE]) > 0,
    `${LIB_SUITE} must still import the entrypoint builder`,
  );
  assert.ok(
    gitGrepCount("assertSameEffectSurface\\(Object\\.keys\\(libEffects\\)", [LIB_SUITE]) > 0,
    `${LIB_SUITE} must still compare the lib and entrypoint surfaces to each other`,
  );
});

// ── (3) a member on one builder and not the other still fails, and names which side ─────────────

/** The same directional split `sweep-orchestration-lives-in-lib.test.ts` uses: two one-way checks
 *  instead of one symmetric `deepEqual`, so exactly the side that is short a member is the one
 *  whose assertion fires. */
function assertSameEffectSurface(libKeys: readonly string[], entrypointKeys: readonly string[]): void {
  const missingFromLib = entrypointKeys.filter((k) => !libKeys.includes(k));
  const missingFromEntrypoint = libKeys.filter((k) => !entrypointKeys.includes(k));
  assert.deepEqual(missingFromLib, [], `the lib-built sweep effects are missing: ${missingFromLib.join(", ")}`);
  assert.deepEqual(
    missingFromEntrypoint,
    [],
    `the entrypoint-built sweep effects are missing: ${missingFromEntrypoint.join(", ")}`,
  );
}

test("a member present on the entrypoint builder only fails exactly one assertion, and it names the lib side", () => {
  const lib = [...SWEEP_EFFECT_SURFACE];
  // Replay #5725: the entrypoint builder gains a member the lib builder does not have.
  const entrypoint = [...SWEEP_EFFECT_SURFACE, "aNewEntrypointOnlyMember"];

  assert.throws(
    () => assertSameEffectSurface(lib, entrypoint),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /lib-built sweep effects are missing/);
      assert.match(error.message, /aNewEntrypointOnlyMember/);
      return true;
    },
  );

  // And that is the ONLY assertion that fires — the other direction has nothing missing.
  assert.doesNotThrow(() =>
    assert.deepEqual(
      lib.filter((k) => !entrypoint.includes(k)),
      [],
    ),
  );
});

test("a member present on the lib builder only fails exactly one assertion, and it names the entrypoint side", () => {
  const lib = [...SWEEP_EFFECT_SURFACE, "aNewLibOnlyMember"];
  const entrypoint = [...SWEEP_EFFECT_SURFACE];

  assert.throws(
    () => assertSameEffectSurface(lib, entrypoint),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /entrypoint-built sweep effects are missing/);
      assert.match(error.message, /aNewLibOnlyMember/);
      return true;
    },
  );

  assert.doesNotThrow(() =>
    assert.deepEqual(
      entrypoint.filter((k) => !lib.includes(k)),
      [],
    ),
  );
});

test("identical surfaces raise neither directional assertion", () => {
  assert.doesNotThrow(() => assertSameEffectSurface([...SWEEP_EFFECT_SURFACE], [...SWEEP_EFFECT_SURFACE]));
});

// ── (4) a second hand-copied list is refused, not merely undetected ──────────────────────────────

test("SWEEP_EFFECT_SURFACE is exported from exactly one place: src/lib/sweep.ts", () => {
  const out = execFileSync("git", ["grep", "-l", "-E", "^export const SWEEP_EFFECT_SURFACE", "--", "src/**/*.ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(out, ["src/lib/sweep.ts"]);
});

test("neither surface suite carries a re-introduced hand-copied list of surface members", () => {
  // Canaries are DERIVED from the live recorded list, not hard-coded, so a future member added to
  // SWEEP_EFFECT_SURFACE is covered by this guard automatically. Distinctive (long) names only —
  // short members risk colliding with unrelated text.
  const canaries = SWEEP_EFFECT_SURFACE.filter((k) => k.length >= 18);
  assert.ok(canaries.length >= 3, "the recorded list must yield enough distinctive canaries to be a real check");

  // Positive control FIRST: the grep mechanism must actually find a canary where one truly is —
  // in its one recorded home — before a zero elsewhere can be trusted as "absent" rather than
  // "the search never worked".
  for (const canary of canaries) {
    assert.ok(
      gitGrepCount(`["']${canary}["']`, ["src/lib/sweep.ts"]) > 0,
      `sanity: "${canary}" must be found as a quoted literal in its one recorded home`,
    );
  }

  // The real guard: neither surface suite hand-quotes a canary member as a string literal. Both
  // suites reference the surface only through the imported identifier now, never by retyping its
  // members, so a quoted occurrence here means a second local copy came back.
  for (const canary of canaries) {
    assert.equal(
      gitGrepCount(`["']${canary}["']`, [ENTRYPOINT_SUITE, LIB_SUITE]),
      0,
      `"${canary}" was found quoted in a surface suite — a hand-copied list was re-introduced there`,
    );
  }
});

test("both surface suites import SWEEP_EFFECT_SURFACE from the lib module", () => {
  for (const file of [ENTRYPOINT_SUITE, LIB_SUITE]) {
    assert.ok(
      gitGrepCount("SWEEP_EFFECT_SURFACE", [file]) > 0,
      `${file} must import SWEEP_EFFECT_SURFACE rather than declaring its own list`,
    );
  }
});
