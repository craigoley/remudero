import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { heldDependencyRoots } from "../src/lib/held-dependency-roots.js";
import { loadPlanFromYaml, type Plan } from "../src/lib/plan.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { GitHub } from "../src/lib/status.js";
import { buildStatusBoard, renderStatusBoardText, type StatusBoardDeps } from "../src/lib/status-board.js";

// Shapes measured on the live plan at b5c2804: W1-T3762 (verify: human, status: blocked) stalled five
// dependents, some through an intermediate task, and W1-T3570 (verify: human, itself waiting on a
// runnable task) stalled two. A runnable root is ordinary queue order and must never be reported.
function plan(yaml: string): Plan {
  return loadPlanFromYaml(yaml, "held-dependency-roots-fixture");
}

const task = (id: string, extra = "", deps: string[] = [], status = "queued") =>
  `- id: ${id}\n  title: ${id}\n  repo: remudero\n  type: implement\n  depends_on: [${deps.join(", ")}]\n  status: ${status}\n${extra}`;

test("W1-T4192: a dependent stalled behind a human-gated root names that root", () => {
  const p = plan(
    [
      task("H", "  verify: human\n"),
      task("A", "", ["H"]),
      task("B", "", ["A"]),
      task("R"),
      task("C", "", ["R"]),
    ].join(""),
  );
  const roots = heldDependencyRoots(p, () => false);
  assert.deepEqual(roots, [{ rootId: "H", hold: "verify-not-auto", stalled: ["A", "B"] }]);
});

test("W1-T4192: a blocked root is named and a retired one is not", () => {
  const p = plan(
    [
      task("X", "  verify: human\n", [], "blocked"),
      task("D", "", ["X"]),
      task("Z", "  retirement: withdrawn\n", [], "blocked"),
      task("E", "", ["Z"]),
    ].join(""),
  );
  const roots = heldDependencyRoots(p, () => false);
  assert.deepEqual(roots, [{ rootId: "X", hold: "blocked", stalled: ["D"] }], "a retired dependency is excluded, never merged");
});

test("W1-T4192: a released or merged root holds nothing", () => {
  const p = plan([task("H", "  verify: human\n"), task("A", "", ["H"])].join(""));
  assert.deepEqual(heldDependencyRoots(p, () => false, new Set(["H"])), [], "an operator release frees the chain");
  assert.deepEqual(heldDependencyRoots(p, (id) => id === "H"), [], "a merged root frees the chain");
  assert.deepEqual(heldDependencyRoots(p, (id) => id === "A"), [], "a merged dependent is not stalled");
});

test("W1-T4192: roots are ordered by how much they hold", () => {
  const p = plan(
    [
      task("H1", "  verify: human\n"),
      task("A", "", ["H1"]),
      task("H2", "  verify: human\n"),
      task("B", "", ["H2"]),
      task("C", "", ["H2"]),
    ].join(""),
  );
  assert.deepEqual(
    heldDependencyRoots(p, () => false).map((r) => [r.rootId, r.stalled.length]),
    [
      ["H2", 2],
      ["H1", 1],
    ],
  );
});

// ── The board: NEEDS ME is where the operator reads what only a person can decide ──────────────

function boardFor(p: Plan, github: GitHub | undefined) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}held-roots-board-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const ledgerPath = join(root, "ledger.ndjson");
  writeFileSync(ledgerPath, JSON.stringify({ run_id: "R1", task_id: "daemon", ts: "2026-09-23T00:00:00.000Z", step: "run.start" }) + "\n");
  const deps: StatusBoardDeps = {
    queryService: () => ({ running: false, pid: null }),
    repoDir: "/nonexistent/repo/for/tests",
    now: () => Date.parse("2026-09-23T00:05:00.000Z"),
    resolveOriginMainSha: () => undefined,
    isPidAlive: () => true,
    readPushedRunBranches: () => "",
    plan: p,
    ...(github ? { github } : {}),
  };
  return buildStatusBoard(root, ledgerPath, deps);
}

/** Nothing has merged: every projection reads unmerged, the state a live plan's held chains are in. */
const nothingMerged = {
  prByRef: () => null,
  findMergedByTrailer: () => null,
  headRefName: () => undefined,
  prBody: () => undefined,
  listMergedHeadBranches: () => [],
  changedFiles: () => undefined,
} as unknown as GitHub;

test("W1-T4192: the board names a held root under NEEDS ME with what it holds", () => {
  const p = plan([task("H", "  verify: human\n"), task("A", "", ["H"]), task("B", "", ["A"])].join(""));
  const model = boardFor(p, nothingMerged);
  assert.deepEqual(model.needsMe.heldRoots, [{ rootId: "H", hold: "verify-not-auto", stalled: ["A", "B"] }]);
  const text = renderStatusBoardText(model);
  assert.match(text, /held root : H \(verify-not-auto\) holds 2 task\(s\): A, B/);
  assert.doesNotMatch(text, /nothing needs you/, "a board with a held root is not quiet");
});

test("W1-T4192: with merge state unknown the board claims no held roots", () => {
  const p = plan([task("H", "  verify: human\n"), task("A", "", ["H"])].join(""));
  const model = boardFor(p, undefined);
  assert.equal(model.needsMe.heldRoots, undefined, "unknown merge state is not an empty list");
  assert.doesNotMatch(renderStatusBoardText(model), /held root :/);
});
