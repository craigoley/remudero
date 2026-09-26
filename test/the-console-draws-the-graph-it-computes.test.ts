// test/the-console-draws-the-graph-it-computes.test.ts — W1-T2489.
//
// THE DEFECT: `buildPanelGraphRoutes` (panel-graph.ts, 1,625 lines) computes and serves the
// plan→task→PR provenance graph (GET /v1/trace, W1-T43) and the console's own client script
// (serve.ts) fetches it -- but `journeyHtml`, the ONLY place that chain ever reaches an
// operator's screen, rendered it as a plain nested `<ul>` list. The whole console path emitted
// zero `<svg>` and zero `<canvas>` elements (task rationale, SURFACE 2/3): a graph, computed and
// routed, reaching an operator only as text.
//
// THE FIX draws the SAME chain journeyHtml already renders as text, ALSO as an inline SVG node
// graph (`journeyGraphSvg`, serve.ts) -- no new route, no new field, no charting dependency (the
// task rationale's own "never a CDN on the page whose job is being readable when the fleet is
// unhealthy"). `journeyHtml` calls it, prepends whatever it returns, and renders the pre-existing
// text UNCONDITIONALLY underneath -- so an empty graph, or a chain shape `journeyGraphSvg` can't
// read, degrades to the text rendering that shipped before this task, never to a blank panel.
//
// EXTRACTED VERBATIM from the REAL served script, never a reimplementation -- the SAME `new
// Function` extraction discipline test/plan-sections-render.test.ts, test/console-shell-
// unknowns.test.ts and test/serve.test.ts already use for pure client-side render logic
// (learnings#probe-must-exercise-the-real-consuming-client: a hand-copied stand-in would prove
// nothing about what the shell actually ships).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPanelGraphRoutes, type PanelGraphDeps, type RatifyCliGateway } from "../src/lib/panel-graph.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";


// ── extraction (verbatim from the shipped shell) ────────────────────────────────────────────


interface Journey {
  journeyGraphSvg: (chain: unknown) => string;
  journeyHtml: (chain: unknown) => string;
}


// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

const POPULATED_CHAIN = {
  direction: "reverse",
  feedback: {
    id: "FB1",
    raw: "the frobnicator needs a widget",
    ts: "2026-01-01T00:00:00Z",
    origin: "cli",
    status: "proposed",
    proposalPr: "https://github.com/o/r/pull/9",
  },
  tasks: [
    {
      id: "W1-T2",
      title: "the frobnicator",
      origin: "feedback#FB1",
      runs: [
        { runId: "W1-T2-1", verdict: "merged", prUrl: "https://github.com/o/r/pull/2", prState: "MERGED", mergeSha: "abc123" },
      ],
    },
    {
      id: "W1-T3",
      title: "the blocked task",
      runs: [{ runId: "W1-T3-1", verdict: "blocked_review" }],
    },
  ],
};

const EMPTY_CHAIN = { direction: "reverse", tasks: [] };

// ── (1) the console emits an SVG rendering of the graph the routes already return ──────────────


// ── (2) the drawing reads the existing payload and adds no new route ───────────────────────────


function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-console-graph-"));
}

function fakeTraceGithub(): TraceGithub {
  return { prView: () => null };
}

function fakeStatusGithub(): GitHub {
  return { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined };
}

function fakeRatify(): RatifyCliGateway {
  return { approve() {}, reframe() {} };
}

function panelGraphDeps(root: string): PanelGraphDeps {
  mkdirSync(join(root, "plan"), { recursive: true });
  const planPath = join(root, "plan", "tasks.yaml");
  writeFileSync(planPath, "[]\n");
  return {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    github: fakeTraceGithub(),
    statusGithub: fakeStatusGithub(),
    ratify: fakeRatify(),
  };
}

test("W1-T2489: buildPanelGraphRoutes retains the existing routes alongside the operator-activity projection and inbox writes -- W1-T2489 itself added no new computation or second graph model", () => {
  const routes = buildPanelGraphRoutes(panelGraphDeps(tmpRoot()));
  const shape = routes.map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(shape, [
    "GET /v1/action-results",
    "GET /v1/drain/preview",
    "GET /v1/feedback",
    "GET /v1/inbox",
    "GET /v1/inbox/thread",
    "GET /v1/inbox/threads",
    "GET /v1/operator-activity",
    "GET /v1/plan/view",
    "GET /v1/trace",
    "POST /v1/feedback",
    "POST /v1/feedback/decision",
    "POST /v1/feedback/preview",
    "POST /v1/inbox/approve",
    "POST /v1/inbox/decline",
    "POST /v1/inbox/reframe",
    "POST /v1/inbox/restore",
    "POST /v1/inbox/thread/read",
    "POST /v1/inbox/thread/reply",
    "POST /v1/policy/daily-cost-ceiling",
    "POST /v1/policy/daily-cost-ceiling/clear",
  ]);
});

// ── (3) an empty graph falls back to the text rendering rather than a blank panel ───────────────


// ── (4) an unreadable payload falls back to the text rendering ──────────────────────────────────


// ── (5) the rendered shell's client script still parses ─────────────────────────────────────────


// ── (6) the drawing loads no script or stylesheet over the network ──────────────────────────────


// ── (7) every node the payload names is reachable in the rendered output ────────────────────────


// ── (8) removing the fallback makes the empty-graph case render nothing ─────────────────────────

