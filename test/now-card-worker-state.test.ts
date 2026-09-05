// test/now-card-worker-state.test.ts — W1-T944 (fb-1785237627858-ffafd9's render half): the NOW
// row shows ELAPSED and SPEND but cannot say whether the worker is ALIVE. This is the falsifier
// for the fix: `deriveRunState`/`deriveStatus` (status.ts) gain the run's newest `worker.state`
// (W1-T942's ledger sensor), `computeBoardSnapshot`/`BoardRow` (board.ts) carry it through with NO
// second ledger scan, and the NOW row's client script (serve.ts) renders it as TEXT beside spend,
// with `quiet` rendered as a DURATION that ages on the SAME 1s tick `elapsed` already uses.
//
// Four acceptance bars (plan/tasks.d/W1-T944-now-card-renders-worker-state.yaml):
//   1. the NOW row renders worker state beside spend; quiet ages as a duration on elapsed's tick.
//   2. no worker.state row -> "state unknown", never blank, never a healthy-looking default.
//   3. a non-running row (isRunningRow false) carries NO worker state — no lingering last state.
//   4. the state rides the SAME served read model as phase/elapsed/spend — no second ledger scan,
//      no client-side re-derivation (grep: workerState in src/lib/board.ts, checked separately).
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workerStateHtml } from "../src/lib/console-shell-script.js";
import { deriveStatus, type GitHub, type PrRef } from "../src/lib/status.js";
import { computeBoardSnapshot, isRunningRow, type BoardDeps } from "../src/lib/board.js";
import { renderShellHtml } from "../src/lib/serve.js";
import type { Plan, Task } from "../src/lib/plan.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "W1-TX",
    title: "t",
    repo: "remudero",
    depends_on: [],
    type: "implement",
    risk: "medium",
    verify: "auto",
    status: "queued", // decorative — deriveStatus must NOT trust this
    attempts: 0,
    ...over,
  };
}

function planOf(tasks: Task[]): Plan {
  return { tasks, byId: new Map(tasks.map((t) => [t.id, t])) };
}

function fakeGitHub(byRef: Record<string, PrRef> = {}): GitHub {
  return {
    prByRef: (ref) => byRef[String(ref)] ?? null,
    findMergedByTrailer: () => null,
    headRefName: () => undefined,
    prBody: () => undefined,
  };
}

function ledgerFile(lines: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-worker-state-"));
  const p = join(dir, "ledger.ndjson");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  return p;
}

function appendLine(path: string, line: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify(line) + "\n");
}

// ── (1)/(2)/(3) status.ts: deriveStatus gains workerState off the SAME ledger scan as phase ──

test("W1-T944: an in-flight run's newest worker.state row surfaces as workerState, beside phase/elapsed — one scan, one model", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-08-17T10:00:03.000Z", run_id: "r1", task_id: "W1-TX", step: "worker.state", state: "working" },
    { ts: "2026-08-17T10:00:07.000Z", run_id: "r1", task_id: "W1-TX", step: "worker.state", state: "tool-executing" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-08-17T10:00:10.000Z") });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "recon");
  assert.ok(typeof proj.elapsedMs === "number", "elapsed still rides the same projection");
  assert.equal(proj.workerState, "tool-executing", "the NEWEST transition wins, not the first");
});

test("W1-T944: a quiet run carries workerStateSince — the ledger row's OWN ts, the transition moment, for client-side ageing", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-08-17T10:00:03.000Z", run_id: "r1", task_id: "W1-TX", step: "worker.state", state: "working" },
    { ts: "2026-08-17T10:04:03.000Z", run_id: "r1", task_id: "W1-TX", step: "worker.state", state: "quiet" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-08-17T10:15:03.000Z") });
  assert.equal(proj.workerState, "quiet");
  assert.equal(proj.workerStateSince, "2026-08-17T10:04:03.000Z", "since = the transition INTO quiet, not now/elapsed's own startedAt");
});

test("W1-T944: workerStateSince is sparse — omitted while the state is NOT quiet, exactly like needsHuman/armedAwaitingMerge's own sparse convention", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-08-17T10:00:03.000Z", run_id: "r1", task_id: "W1-TX", step: "worker.state", state: "working" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-08-17T10:00:10.000Z") });
  assert.equal(proj.workerState, "working");
  assert.equal(proj.workerStateSince, undefined);
});

test("W1-T944: a run with NO worker.state row yet leaves workerState undefined (the console renders 'state unknown') while still genuinely running", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([{ ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" }]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-08-17T10:00:05.000Z") });
  assert.equal(proj.status, "running");
  assert.ok(proj.phase, "the row IS running — this is the 'unknown, not absent-because-finished' case");
  assert.equal(proj.workerState, undefined);
});

test("W1-T944: a FINISHED run carries no worker state at all — isRunningRow's phase-gate governs, so a last-known state cannot linger as if current", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-08-17T10:04:00.000Z", run_id: "r1", task_id: "W1-TX", step: "worker.state", state: "quiet" },
    { ts: "2026-08-17T10:10:00.000Z", run_id: "r1", task_id: "W1-TX", step: "verdict", verdict: "not-merged" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-08-17T10:11:00.000Z") });
  assert.equal(proj.phase, undefined, "no fresh run.start followed verdict — the run is over, not in flight");
  assert.equal(proj.workerState, undefined, "the 'quiet' from the finished run must not linger on the row");
  assert.equal(proj.workerStateSince, undefined);
});

test("W1-T944: a stale/EARLIER run's worker.state never leaks into a LATER run's row — a fresh run.start resets it exactly like phase resets to recon", () => {
  const github = fakeGitHub({});
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T09:00:00.000Z", run_id: "r1", task_id: "W1-TX", step: "run.start" },
    { ts: "2026-08-17T09:04:00.000Z", run_id: "r1", task_id: "W1-TX", step: "worker.state", state: "quiet" },
    { ts: "2026-08-17T09:10:00.000Z", run_id: "r1", task_id: "W1-TX", step: "verdict", verdict: "not-merged" },
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r2", task_id: "W1-TX", step: "run.start" },
  ]);
  const proj = deriveStatus(task(), { ledgerPath, github, now: () => Date.parse("2026-08-17T10:00:05.000Z") });
  assert.equal(proj.status, "running");
  assert.equal(proj.phase, "recon", "run r2 is fresh, back at recon");
  assert.equal(proj.workerState, undefined, "r1's stale 'quiet' must not survive into r2's row");
});

// ── (3)/(4) board.ts: BoardRow carries workerState through the SAME snapshot pass as spend ──

test("W1-T944: computeBoardSnapshot carries workerState onto BoardRow, gated by the SAME isRunningRow predicate the header tally uses", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "A", step: "run.start" },
    { ts: "2026-08-17T10:00:03.000Z", run_id: "r1", task_id: "A", step: "worker.state", state: "quiet" },
  ]);
  const now = () => Date.parse("2026-08-17T10:00:30.000Z");
  const deps: BoardDeps = { plan: planOf([task({ id: "A" })]), ledgerPath, github: fakeGitHub(), now };
  const row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "A")!;
  assert.equal(row.workerState, "quiet");
  assert.equal(row.workerStateSince, "2026-08-17T10:00:03.000Z");
  assert.equal(isRunningRow(row), true);
});

test("W1-T944: a finished task's BoardRow carries no workerState — isRunningRow is false, and no last-known state lingers as if current", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "A", step: "run.start" },
    { ts: "2026-08-17T10:00:03.000Z", run_id: "r1", task_id: "A", step: "worker.state", state: "quiet" },
    { ts: "2026-08-17T10:05:00.000Z", run_id: "r1", task_id: "A", step: "verdict", verdict: "not-merged" },
  ]);
  const now = () => Date.parse("2026-08-17T10:06:00.000Z");
  const deps: BoardDeps = { plan: planOf([task({ id: "A" })]), ledgerPath, github: fakeGitHub(), now };
  const row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "A")!;
  assert.equal(isRunningRow(row), false);
  assert.equal(row.workerState, undefined);
  assert.equal(row.workerStateSince, undefined);
});

test("W1-T944: no second ledger read — computeBoardSnapshot's workerState comes from the SAME already-parsed lines projectPlan/deriveStatus consumed, never a fresh readLedgerLines call", () => {
  const ledgerPath = ledgerFile([
    { ts: "2026-08-17T10:00:00.000Z", run_id: "r1", task_id: "A", step: "run.start" },
    { ts: "2026-08-17T10:00:03.000Z", run_id: "r1", task_id: "A", step: "worker.state", state: "working" },
  ]);
  const now = () => Date.parse("2026-08-17T10:00:10.000Z");
  let readCount = 0;
  const deps: BoardDeps = {
    plan: planOf([task({ id: "A" })]),
    ledgerPath,
    github: fakeGitHub(),
    now,
    readLedger: (p) => {
      readCount++;
      // Same shape readLedgerLines would produce — a minimal stand-in so this test proves the
      // CALL COUNT invariant without depending on the real reader's own implementation.
      return readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l: string) => JSON.parse(l));
    },
  };
  const row = computeBoardSnapshot(deps).tasks.find((t) => t.taskId === "A")!;
  assert.equal(row.workerState, "working");
  assert.equal(readCount, 1, "computeBoardSnapshot must read the ledger exactly ONCE — workerState rides the same pass as phase/spend");
});

// ── (1)/(2) serve.ts: the client script renders workerState as TEXT beside spend, ages quiet ──
// on the SAME tick elapsed uses. This is a STRUCTURAL/static assertion against renderShellHtml's
// own output, the SAME proof shape test/serve.test.ts already uses for this client script (e.g.
// "renderShellHtml is pure and matches what GET / serves", the row-chevron/row-detail wiring
// checks) rather than a live-browser harness — the client script is plain embedded JS, not a
// separately-built bundle, so its SOURCE is directly inspectable.

test("W1-T944: the NOW row renders a worker-state span beside the spend span, in nowRowHtml's own markup", () => {
  const html = renderShellHtml();
  assert.match(html, /function workerStateHtml\(t\)/, "a dedicated render function, not inlined ad hoc");
  assert.match(html, /workerStateHtml\(t\)\}\$\{liveSpendHtml\(t\)\}/, "worker state sits directly beside spend in nowRowHtml's own template");
});

// W1-T2731: `workerStateHtml` is a real export now, so the two tests below assert its OUTPUT
// rather than its source text inside the rendered HTML. That is not a workaround — it is stronger.
// The emitted script is produced by tsx/esbuild, which MINIFIES and ASCII-ESCAPES it: the shipped
// bytes read `quiet \u2026`, not `quiet …`, and `function workerStateHtml(t){` with no space or
// two-space-indented brace. Runtime output is byte-identical (the browser decodes the escapes),
// which is exactly why asserting on behaviour survives a transpiler change and asserting on
// source text does not. The remaining source-text assertions in this file target functions that
// are STILL inline in the template and so are unaffected.
test("W1-T944: quiet renders as a DURATION span carrying its transition timestamp as a data attribute, never a frozen number", () => {
  const html = workerStateHtml({ taskId: "W1-T1", workerState: "quiet", workerStateSince: "2026-01-01T00:00:00Z" });
  assert.match(html, /class="worker-state worker-quiet" data-worker-since="2026-01-01T00:00:00Z"/);
  assert.match(html, />quiet …</, "the initial paint text — a real word, not blank");
  // AND THE WIRING, so this can never pass over a module the shell does not actually ship:
  assert.match(renderShellHtml(), /function workerStateHtml\(t\)/, "the shell really emits it");
});

test("W1-T944: quiet ages on the SAME 1s tick elapsed already uses (tickElapsed), never a second setInterval", () => {
  const html = renderShellHtml();
  const tickElapsedBody = /function tickElapsed\(\)\s*\{([\s\S]*?)\n  \}/.exec(html);
  assert.ok(tickElapsedBody, "tickElapsed() must exist and be extractable");
  assert.match(tickElapsedBody![1], /\.worker-quiet\[data-worker-since\]/, "the quiet-ageing scan lives INSIDE tickElapsed, not a sibling timer");
  assert.match(tickElapsedBody![1], /quiet \$\{formatElapsed\(quietMs\)\}/, "reuses formatElapsed — the exact function .elapsed already ages with");
  // The quiet-ageing scan folds into the EXISTING tick function body — it must not itself spin up
  // a fresh timer (that would be exactly the "second clock" design note ii forbids).
  assert.doesNotMatch(tickElapsedBody![1], /setInterval\(/, "worker-state ageing must not introduce its own timer inside tickElapsed");
});

test("W1-T944: no worker.state row renders 'state unknown' as a real word — never blank, never a healthy-looking default", () => {
  const html = renderShellHtml();
  assert.match(html, /class="worker-state worker-unknown">state unknown</);
});

test("W1-T944: every worker-state branch renders TEXT (never colour alone) — working/tool-executing/quiet/unknown are each a literal word in the same span shape", () => {
  // Every branch, by its OUTPUT — see the note above. A branch that rendered colour alone would
  // produce a span with no text between its tags, which each assertion below refuses directly.
  assert.match(workerStateHtml({ taskId: "x", workerState: "working" }), /class="worker-state">working</, "working renders its own name as text");
  assert.match(workerStateHtml({ taskId: "x", workerState: "tool-executing" }), /class="worker-state">tool-executing</);
  assert.match(workerStateHtml({ taskId: "x", workerState: "quiet", workerStateSince: "T" }), /quiet …/);
  assert.match(workerStateHtml({ taskId: "x" }), /state unknown/);
  // No branch returns bare markup with only a class and no text content — every return above is
  // itself the proof (each carries a word between its span tags).
});
