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
import { renderShellHtml } from "../src/lib/serve.js";
import type { GitHub } from "../src/lib/status.js";
import type { TraceGithub } from "../src/lib/trace.js";

const HTML = renderShellHtml();

// ── extraction (verbatim from the shipped shell) ────────────────────────────────────────────

function clientFn(name: string): string {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}()`);
  return src as string;
}

interface Journey {
  journeyGraphSvg: (chain: unknown) => string;
  journeyHtml: (chain: unknown) => string;
}

/** A fresh sandbox around the REAL journeyGraphSvg/journeyHtml + their real collaborators
 *  (escapeHtml, journeyRunHtml, journeyTaskHtml), extracted verbatim -- mirrors
 *  test/console-shell-unknowns.test.ts's bannerHarness for the same reason: a sandbox holding
 *  only journeyHtml throws "escapeHtml is not defined" before any assertion below can run. */
function journeyHarness(): Journey {
  const factory = new Function(
    [
      clientFn("escapeHtml"),
      clientFn("journeyGraphSvg"),
      clientFn("journeyRunHtml"),
      clientFn("journeyTaskHtml"),
      clientFn("journeyHtml"),
      "return { journeyGraphSvg: journeyGraphSvg, journeyHtml: journeyHtml };",
    ].join("\n"),
  ) as () => Journey;
  return factory();
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

test("W1-T2489: journeyHtml draws the populated chain as an inline <svg> node graph, alongside the existing text rendering", () => {
  const { journeyHtml } = journeyHarness();
  const html = journeyHtml(POPULATED_CHAIN);
  assert.match(html, /<svg[^>]*class="journey-graph"/, "the populated chain must draw an inline SVG");
  assert.match(html, /role="img"/, "the graph must be an accessible image, not decoration only");
  // the pre-existing text rendering (W1-T222) still renders too -- this is an addition, not a
  // replacement (see criterion 3/4/8 below for why the text is unconditional).
  assert.match(html, /direction: reverse/);
  assert.match(html, /journey-task-link/);
});

// ── (2) the drawing reads the existing payload and adds no new route ───────────────────────────

test("W1-T2489: journeyGraphSvg draws from the SAME { feedback, tasks } shape journeyHtml already receives off GET /v1/trace -- no second fetch, no new field", () => {
  const { journeyGraphSvg } = journeyHarness();
  // the exact fixture shape TraceChain (lib/trace.ts) already carries -- nothing this function
  // reads is absent from what buildTraceRoute (panel-graph.ts) already returns today.
  const svg = journeyGraphSvg({ feedback: POPULATED_CHAIN.feedback, tasks: POPULATED_CHAIN.tasks });
  assert.match(svg, /<svg/);
});

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

test("W1-T2489: buildPanelGraphRoutes still returns exactly its pre-existing 12 routes plus W1-T2604's later POST /v1/inbox/decline -- W1-T2489 itself added no route, no new computation, no second graph model", () => {
  const routes = buildPanelGraphRoutes(panelGraphDeps(tmpRoot()));
  const shape = routes.map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(shape, [
    "GET /v1/drain/preview",
    "GET /v1/feedback",
    "GET /v1/inbox",
    "GET /v1/plan/view",
    "GET /v1/trace",
    "POST /v1/feedback",
    "POST /v1/feedback/decision",
    "POST /v1/feedback/preview",
    "POST /v1/inbox/approve",
    "POST /v1/inbox/decline",
    "POST /v1/inbox/reframe",
    "POST /v1/policy/daily-cost-ceiling",
    "POST /v1/policy/daily-cost-ceiling/clear",
  ]);
});

// ── (3) an empty graph falls back to the text rendering rather than a blank panel ───────────────

test("W1-T2489: an empty graph (no feedback, no tasks) draws no <svg> at all -- journeyHtml falls back to the pre-existing text rendering, never a blank panel", () => {
  const { journeyHtml } = journeyHarness();
  const html = journeyHtml(EMPTY_CHAIN);
  assert.doesNotMatch(html, /<svg/, "nothing to draw -- no empty <svg> shell either");
  assert.match(html, /direction: reverse/);
  assert.match(html, /\(no tasks yet\)/, "the SAME text fallback W1-T222 shipped");
  assert.notEqual(html.trim(), "", "the panel must never render blank");
});

// ── (4) an unreadable payload falls back to the text rendering ──────────────────────────────────

test("W1-T2489: a chain shape journeyGraphSvg cannot read (tasks not an array, feedback not an object, or the whole chain malformed) still renders the text fallback, never throws, never blanks", () => {
  const { journeyHtml } = journeyHarness();
  const malformed = [
    { direction: "reverse", tasks: "not-an-array", feedback: 42 },
    { direction: "reverse", tasks: [{ id: "W1-T9", title: "ok", runs: "not-an-array" }] },
    null,
    "a bare string, not even an object",
    undefined,
  ];
  for (const bad of malformed) {
    let html = "";
    assert.doesNotThrow(() => {
      html = journeyHtml(bad);
    }, `journeyHtml must never throw on an unreadable payload: ${JSON.stringify(bad)}`);
    assert.notEqual(html.trim(), "", "an unreadable payload must degrade to text, never render blank");
    assert.match(html, /direction:/, "the text fallback (direction: ...) must still be present");
  }
});

// ── (5) the rendered shell's client script still parses ─────────────────────────────────────────

test("W1-T2489: the rendered shell's entire inline <script> still parses -- the backtick/${} hazard this file's own rationale names (a stray backtick or unescaped ${} in SVG markup terminates the outer template literal and breaks the build)", () => {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(HTML)?.[1];
  assert.ok(script, "the shell must still emit its inline <script>");
  assert.doesNotThrow(() => new Function(script as string), "the full client script must remain syntactically valid JS");
});

// ── (6) the drawing loads no script or stylesheet over the network ──────────────────────────────

test("W1-T2489: the graph is inline SVG in the SAME markup/stylesheet the shell already ships -- no <script src> or external <link rel=stylesheet> was added", () => {
  assert.doesNotMatch(HTML, /<script\s[^>]*\bsrc=/i, "no externally-loaded script");
  assert.doesNotMatch(HTML, /<link[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=/i, "no externally-loaded stylesheet");
  const { journeyGraphSvg } = journeyHarness();
  const svg = journeyGraphSvg({ feedback: POPULATED_CHAIN.feedback, tasks: POPULATED_CHAIN.tasks });
  assert.doesNotMatch(svg, /<image\b/i, "no <image> element (a network-loadable resource)");
  assert.doesNotMatch(svg, /https?:\/\//i, "no remote reference of any kind inside the drawing itself");
});

// ── (7) every node the payload names is reachable in the rendered output ────────────────────────

test("W1-T2489: every feedback/task/run id the chain names is reachable inside the drawn <svg>", () => {
  const { journeyGraphSvg } = journeyHarness();
  const svg = journeyGraphSvg({ feedback: POPULATED_CHAIN.feedback, tasks: POPULATED_CHAIN.tasks });
  assert.match(svg, /FB1/, "the feedback node");
  assert.match(svg, /W1-T2\b/, "the first task node");
  assert.match(svg, /W1-T3\b/, "the second task node");
  assert.match(svg, /W1-T2-1/, "the first run node");
  assert.match(svg, /W1-T3-1/, "the second run node");
  // the failing run is visually distinguished too (mirrors journeyRunHtml's own .journey-fail,
  // under its own class so the two never collide in a caller's element count).
  assert.match(svg, /journey-graph-fail/);
});

// ── (8) removing the fallback makes the empty-graph case render nothing ─────────────────────────

test("W1-T2489: journeyGraphSvg called on its OWN (no journeyHtml wrapper) renders NOTHING for an empty graph -- proving the text fallback in journeyHtml, not journeyGraphSvg itself, is what keeps the panel non-blank", () => {
  const { journeyGraphSvg } = journeyHarness();
  assert.equal(journeyGraphSvg({ feedback: null, tasks: [] }), "", "no wrapper, no fallback: an empty graph draws literally nothing");
  assert.equal(journeyGraphSvg({}), "", "same for a chain shape carrying neither field at all");
});
