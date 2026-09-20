/**
 * test/the-sweep-entrypoint-supplies-the-pr-body-writer.test.ts — W1-T3869.
 *
 * MEASURED ON A LIVE SWEEP (feedback fb-1789380725522-726d15, 2026-09-14): PR #5505 was
 * classified blocked-fixable, `repairMissingTaskTrailer` awaited `updatePrBodyImpl`, and
 * `requiredSweepRuntime`'s stub threw `buildSweepEffects requires updatePrBodyImpl from its
 * entrypoint adapter` — the production `buildSweepEffectsFromLib({ ... })` call in
 * `src/run-task.ts` never named the field.
 *
 * This suite drives the PRODUCTION ADAPTER — `buildSweepEffects` imported from
 * "../src/run-task.js", never `buildSweepEffectsFromLib` directly — with deps objects that
 * deliberately never set `updatePrBodyImpl` themselves. A test that injected the writer at the
 * library seam would prove only that `src/lib/sweep.ts`'s effect body works, which was never in
 * doubt and would have passed unmodified on the day #5505 failed
 * (`test/build-sweep-effects-takes-one-deps-object.test.ts`'s own
 * "W1-T3283 EFFECT: repairMissingTaskTrailer …" already does exactly that, and is left
 * untouched here).
 *
 * No real `gh` call: a PATH shim (`test/helpers/gh-shim.ts`) answers the REST PATCH the wired
 * writer sends, and the omitted-writer control never reaches a transport at all — the refusal
 * throws before anything is spawned.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Config } from "../src/lib/config.js";
import type { Plan } from "../src/lib/plan.js";
import { buildSweepEffects as buildSweepEffectsFromLib, type MissingTaskTrailerRepair } from "../src/lib/sweep.js";
import { buildSweepEffects, type BuildSweepEffectsDeps } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

const REPAIR: MissingTaskTrailerRepair = {
  taskId: "W1-T3869",
  trailer: "Remudero-Task: W1-T3869",
  repairedBody: "## Summary\n\nfixes the wiring\n\nRemudero-Task: W1-T3869\n",
  reason: "derived from branch",
  scopeOverrunPaths: [],
  refireEvent: "pull_request.edited",
  rerunFailedJobs: false,
};

const PR = {
  prNumber: 5505,
  prUrl: "https://github.com/craigoley/remudero/pull/5505",
  headSha: "966f29d",
} as never;

/** Minimal deps for the PRODUCTION entrypoint's `buildSweepEffects` — never sets
 *  `updatePrBodyImpl`, so a completed repair proves the entrypoint's OWN default wired it. */
function entrypointDeps(root: string, log: (step: string, extra?: Record<string, unknown>) => void): BuildSweepEffectsDeps {
  return {
    owner: "craigoley",
    repo: "remudero",
    config: { root, claudeBin: "/bin/true" } as Config,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    runId: "SWEEP-W1-T3869",
    plan: { tasks: [], byId: new Map() } as unknown as Plan,
    log,
  };
}

test("W1-T3869: production entrypoint trailer repair completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t3869-completes-"));
  const shim = ghShim([{ when: "api -X PATCH", stdout: "{}" }], { kind: "w1-t3869-completes" });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const deps = entrypointDeps(root, () => {});
    assert.ok(!("updatePrBodyImpl" in deps), "the test must never inject the writer itself");

    const effects = buildSweepEffects(deps);
    await assert.doesNotReject(
      async () => {
        await effects.repairMissingTaskTrailer!(PR, REPAIR);
      },
      "the production entrypoint must supply updatePrBodyImpl so the repair reaches the write, " +
        "not the `buildSweepEffects requires updatePrBodyImpl from its entrypoint adapter` refusal",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T3869: trailer repair uses the entrypoint effect surface", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t3869-surface-"));
  const shim = ghShim([{ when: "api -X PATCH", stdout: "{}" }], { kind: "w1-t3869-surface" });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const deps = entrypointDeps(root, () => {});
    assert.ok(!("updatePrBodyImpl" in deps), "the test must never inject the writer itself");

    // THE CONTRAST: the SAME deps object, unmodified, handed to the LIBRARY builder directly
    // (never done in production — `src/run-task.ts` is the one production adapter) still
    // refuses, because the library never receives the entrypoint's own default. Only the
    // entrypoint path — the one this suite's OWN subject drives below — completes.
    const libEffects = buildSweepEffectsFromLib(deps);
    await assert.rejects(
      async () => {
        await libEffects.repairMissingTaskTrailer!(PR, REPAIR);
      },
      /buildSweepEffects requires updatePrBodyImpl from its entrypoint adapter/,
      "the raw library seam must still refuse this exact deps object",
    );
    assert.deepEqual(shim.calls(), [], "the library-seam control must never reach a transport");

    const effects = buildSweepEffects(deps);
    await effects.repairMissingTaskTrailer!(PR, REPAIR);
    assert.ok(
      shim.calls().some((c) => c.includes("api -X PATCH")),
      "the entrypoint-built effect surface must be the one that actually reaches the writer",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T3869: wired writer targets the named PR over REST", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t3869-rest-"));
  const shim = ghShim([{ when: "api -X PATCH", stdout: "{}" }], { kind: "w1-t3869-rest" });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const effects = buildSweepEffects(entrypointDeps(root, () => {}));

    await effects.repairMissingTaskTrailer!(PR, REPAIR);

    // `ghShim` logs the raw joined "$*" with one `printf` line per NEWLINE inside it, so a
    // multi-line PR body (this one is) legitimately spans several lines of the call log — join
    // them back before asserting rather than assuming one shim line is one invocation.
    const joined = shim.calls().join("\n");
    assert.equal(
      (joined.match(/\bapi -X PATCH\b/g) ?? []).length,
      1,
      "exactly one write, no live network call",
    );
    assert.match(joined, /\bapi -X PATCH repos\/craigoley\/remudero\/pulls\/5505\b/, "the PR named by the repair, over the REST pulls endpoint");
    assert.match(joined, /body=## Summary/, "carrying the repaired body, not the original");
    assert.match(joined, /Remudero-Task: W1-T3869/, "with the trailer the repair derived");
  } finally {
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T3869: omitted writer still raises explicit refusal while production entrypoint supplies the writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-w1-t3869-refusal-"));
  const shim = ghShim([{ when: "api -X PATCH", stdout: "{}" }], { kind: "w1-t3869-refusal-production-control" });
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${shim.dir}:${oldPath}`;
    const productionEffects = buildSweepEffects(entrypointDeps(root, () => {}));
    await assert.doesNotReject(
      async () => productionEffects.repairMissingTaskTrailer!(PR, REPAIR),
      "the same omitted-writer deps must succeed through the production entrypoint",
    );
    const deps: BuildSweepEffectsDeps = {
      owner: "craigoley",
      repo: "remudero",
      config: { root, claudeBin: "/bin/true" } as Config,
      ledgerPath: join(root, "state", "ledger.ndjson"),
      runId: "SWEEP-W1-T3869-omitted",
      plan: { tasks: [], byId: new Map() } as unknown as Plan,
      log: () => {},
      // updatePrBodyImpl deliberately absent — an incomplete adapter must stay explicit-refusal,
      // never a silent no-op or a default installed inside src/lib/sweep.ts itself.
    };

    const effects = buildSweepEffectsFromLib(deps);

    await assert.rejects(
      async () => {
        await effects.repairMissingTaskTrailer!(PR, REPAIR);
      },
      /buildSweepEffects requires updatePrBodyImpl from its entrypoint adapter/,
      "the library's own required-runtime refusal must survive this task untouched",
    );
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
