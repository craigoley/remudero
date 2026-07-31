import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveRunMounts } from "../src/run-task.js";

// ── THE DEFECT ────────────────────────────────────────────────────────────────────────
// The RECON spawn passed neither `model` nor `effort`. Both are optional on SpawnWorkerArgs
// (lib/worker.ts's `if (args.model)` / `if (args.effort)` guards), so the spawn silently took the
// SDK default — while the IMPLEMENT spawn ~100 lines below passes mount.model/mount.effort under a
// comment reading "never a hardcoded literal".
//
// `.remudero/mounts.yaml` has carried a fully-specified `recon:` route the whole time. NOTHING
// READ IT: `resolveMountForClass` was called exactly once, for implement. Measured over the
// ledger unioned across all 661 rotations — 413 `recon.done` rows, model label "default" on every
// one, never a routed model.
//
// Same class as the `#781 architect:` row CLAUDE.md records: a mounts.yaml row that looks
// configured and has no reader.

const SRC = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");
const REPO_ROOT = new URL("..", import.meta.url).pathname;

/**
 * A mounts.yaml fixture. The HEADER (tiers/efforts/architect/judge) is taken verbatim from the
 * committed table rather than hand-written, so the fixture cannot drift from what `validateMounts`
 * accepts — an earlier revision of this test hand-rolled `tiers` as a list and was rejected by the
 * loader before it ever reached the code under test. Only `routes:` is substituted, which is the
 * one thing these tests actually vary.
 */
function fixtureRepo(routesYaml: string): string {
  const real = readFileSync(new URL("../.remudero/mounts.yaml", import.meta.url), "utf8");
  const header = real.slice(0, real.indexOf("\nroutes:"));
  const dir = mkdtempSync(join(tmpdir(), "rmd-bp-mounts-"));
  mkdirSync(join(dir, ".remudero"), { recursive: true });
  writeFileSync(join(dir, ".remudero", "mounts.yaml"), `${header}\nroutes:\n${routesYaml}`);
  return dir;
}

/** Every row the loader validates, minus recon — used by the inertness lock. */
const CELL = "{ model: sonnet, effort: high, max_turns: 400, context_budget: 120000 }";
const ROWS_WITHOUT_RECON = `  implement:
    high:
      src: ${CELL}
  reviewer:
    high:
      src: ${CELL}
  fix:
    high:
      src: ${CELL}
`;

// ── 1: the committed table routes recon, and the values come from the ROW ───────────
test("the recon stage resolves a mount from the recon row rather than running on the SDK default", () => {
  const logged: Array<{ step: string }> = [];

  const r = resolveRunMounts(REPO_ROOT, { type: "implement", risk: "high", files: ["src/x.ts"] }, (step) =>
    logged.push({ step }),
  );

  assert.ok(r.reconMount, "the committed .remudero/mounts.yaml routes recon — this was undefined before impl-BP");
  assert.equal(r.reconMount?.model, "sonnet", "recon.high.src's model, read from the row");
  assert.equal(r.reconMount?.effort, "high", "recon.high.src's effort, read from the row");
  assert.equal(logged.filter((l) => l.step === "mount.recon_unrouted").length, 0, "no unrouted line on the real table");
});

// ── 2: THE INERTNESS LOCK — recon runs on EVERY dispatch ────────────────────────────
test("INERTNESS LOCK: a mounts table with NO recon row degrades to today's behaviour and never throws", () => {
  const dir = fixtureRepo(ROWS_WITHOUT_RECON);
  const logged: Array<{ step: string; extra?: Record<string, unknown> }> = [];

  // Must NOT throw. resolveMountForClass throws MountsError on a missing row, and recon runs on
  // every dispatch — an uncaught throw here would break ALL dispatch, not one lane.
  const r = resolveRunMounts(dir, { type: "implement", risk: "high", files: ["src/x.ts"] }, (step, extra) =>
    logged.push({ step, extra }),
  );

  assert.equal(r.reconMount, undefined, "no recon row ⇒ undefined, which makes the spawn omit both knobs");
  assert.equal(r.mount.model, "sonnet", "and the rest of the resolution is untouched — implement still routes");
  assert.ok(r.reviewerMount && r.fixMount, "reviewer and fix still resolve");
  const line = logged.find((l) => l.step === "mount.recon_unrouted");
  assert.ok(line, "the degradation is LEDGERED, never silent");
  assert.match(String(line?.extra?.reason), /no route for task_type 'recon'/, "and names why");
  rmSync(dir, { recursive: true, force: true });
});

test("INERTNESS LOCK: undefined is a SUPPORTED spawn value — worker.ts leaves the option unset", () => {
  const worker = readFileSync(new URL("../src/lib/worker.ts", import.meta.url), "utf8");

  assert.match(worker, /if \(args\.model\) options\.model = args\.model;/, "model is only set when truthy");
  assert.match(worker, /if \(args\.effort\) options\.effort = args\.effort/, "effort is only set when truthy");
});

// ── 3: the spawn actually receives the resolved values ──────────────────────────────
test("the recon spawn passes the mount's model and effort, and the implement spawn is unchanged", () => {
  const recon = SRC.slice(SRC.indexOf("renderReconPrompt(planIndexBlock, operatorNotesBlock)") - 1400);
  const reconCall = recon.slice(0, recon.indexOf("renderReconPrompt(planIndexBlock, operatorNotesBlock)"));

  assert.match(reconCall, /model:\s*reconMount\?\.model/, "recon passes the mount's model");
  assert.match(reconCall, /effort:\s*reconMount\?\.effort/, "recon passes the mount's effort");
  assert.match(SRC, /model:\s*mount\.model/, "the implement spawn still passes mount.model, untouched");
  assert.match(SRC, /effort:\s*mount\.effort/, "and mount.effort");
});

// ── 4: maxTurns — the code keeps 8, and the ROW now AGREES (operator ruling, impl-BS) ──
test("maxTurns on the recon spawn is the deliberate bounded 8, and every recon row cell now agrees", () => {
  const recon = SRC.slice(SRC.indexOf("renderReconPrompt(planIndexBlock, operatorNotesBlock)") - 1400);
  const reconCall = recon.slice(0, recon.indexOf("renderReconPrompt(planIndexBlock, operatorNotesBlock)"));
  const mounts = readFileSync(new URL("../.remudero/mounts.yaml", import.meta.url), "utf8");
  const reconRow = mounts.slice(mounts.indexOf("\n  recon:"), mounts.indexOf("\n  implement:"));

  assert.match(reconCall, /maxTurns:\s*8,/, "the bounded cap is preserved verbatim");
  assert.doesNotMatch(reconCall, /maxTurns:\s*reconMount/, "turns are deliberately NOT taken from the mount");
  // impl-BP pinned a CONTRADICTION here: the row said 400, the code said 8. The operator ruled
  // the ROW moves rather than the code — a table asserting one thing while the code does another
  // is exactly the class this lineage is closing (#781 architect:, #992 recon:). The code's bound
  // is untouched; both halves are pinned so neither can drift back.
  assert.doesNotMatch(reconRow, /max_turns:\s*400/, "no recon cell may still claim the old 400");
  const cells = reconRow.match(/max_turns:\s*\d+/g) ?? [];
  assert.ok(cells.length >= 7, `every recon cell must carry max_turns, found ${cells.length}`);
  for (const cell of cells) {
    assert.match(cell, /max_turns:\s*8$/, `every recon cell must read 8 to match the spawn, saw: ${cell}`);
  }
});
