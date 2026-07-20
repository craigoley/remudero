import assert from "node:assert/strict";
import { test } from "node:test";
import type { FeedbackEntry, TraceChain } from "../packages/api-client/src/client.js";
import { renderInbox, renderTraceGraph } from "../apps/dashboard/src/main.js";

// ── W3-T6 (MASTER-PLAN §7B), acceptance criterion 2: "the panel renders the plan→task→PR
// graph and allows accept/reject of a proposal" ─────────────────────────────────────────────
//
// apps/dashboard/src/main.ts's render functions are PURE (root.innerHTML in, nothing else) --
// same split render()/applyUpdate() (W3-T2) already established -- so they're directly
// unit-testable with a minimal `{ innerHTML: "" }` stand-in for a real HTMLElement, no DOM/
// jsdom dependency required. This is the "the panel renders..." half of the criterion; the
// "accepting a proposal is ledgered with the panel bearer as origin" half is proven end-to-end
// against the REAL daemon routes in test/panel-graph.test.ts.

/** A minimal HTMLElement stand-in: only `.innerHTML` is read/written by the functions under test. */
function fakeRoot(): HTMLElement {
  return { innerHTML: "" } as unknown as HTMLElement;
}

function feedbackEntry(over: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: "fb-1000-abc123",
    ts: "2026-07-20T00:00:00.000Z",
    raw: "the drain retry banner overlaps the status pill",
    attachments: [],
    origin: "ui",
    status: "new",
    proposal_pr: null,
    ...over,
  };
}

// ── renderInbox ──────────────────────────────────────────────────────────────

test("renderInbox: an empty inbox says so, rather than an empty list", () => {
  const root = fakeRoot();
  renderInbox(root, []);
  assert.match(root.innerHTML, /inbox is empty/);
});

test("renderInbox: a `proposed` entry renders its id/status/origin/raw/proposal-PR-link and Accept/Reject actions", () => {
  const root = fakeRoot();
  const entry = feedbackEntry({ status: "proposed", proposal_pr: "https://github.com/craigoley/remudero/pull/9001" });
  renderInbox(root, [entry]);
  assert.match(root.innerHTML, /fb-1000-abc123/);
  assert.match(root.innerHTML, /proposed/);
  assert.match(root.innerHTML, /origin=ui/);
  assert.match(root.innerHTML, /the drain retry banner overlaps the status pill/);
  assert.match(root.innerHTML, /href="https:\/\/github\.com\/craigoley\/remudero\/pull\/9001"/);
  assert.match(root.innerHTML, /class="decide-accept" data-id="fb-1000-abc123"/);
  assert.match(root.innerHTML, /class="decide-reject" data-id="fb-1000-abc123"/);
  assert.doesNotMatch(root.innerHTML, /answer-grill/);
});

test("renderInbox: a `grilling` entry renders an Answer action, no Accept/Reject", () => {
  const root = fakeRoot();
  renderInbox(root, [feedbackEntry({ status: "grilling" })]);
  assert.match(root.innerHTML, /class="answer-grill" data-id="fb-1000-abc123"/);
  assert.doesNotMatch(root.innerHTML, /decide-accept|decide-reject/);
});

test("renderInbox: a `new` entry renders no action buttons at all", () => {
  const root = fakeRoot();
  renderInbox(root, [feedbackEntry({ status: "new" })]);
  assert.doesNotMatch(root.innerHTML, /decide-accept|decide-reject|answer-grill/);
});

test("renderInbox: untrusted `raw` text is HTML-escaped, never injected verbatim", () => {
  const root = fakeRoot();
  renderInbox(root, [feedbackEntry({ raw: "<script>alert(1)</script>" })]);
  assert.doesNotMatch(root.innerHTML, /<script>/);
  assert.match(root.innerHTML, /&lt;script&gt;/);
});

// ── renderTraceGraph ─────────────────────────────────────────────────────────

/** A full feedback→proposal→task→PR chain, mirroring exactly what GET /v1/trace returns (test/panel-graph.test.ts's own FORWARD-chain fixture). */
function fullChain(): TraceChain {
  return {
    direction: "forward",
    feedback: {
      id: "fb-1000-abc123",
      raw: "the drain retry banner overlaps the status pill",
      ts: "2026-07-20T00:00:00.000Z",
      origin: "ui",
      status: "proposed",
      proposalPr: "https://github.com/craigoley/remudero/pull/9001",
    },
    tasks: [
      {
        id: "W9-T900",
        title: "fix the retry banner overlap",
        origin: "feedback#fb-1000-abc123",
        runs: [
          {
            runId: "W9-T900-1000",
            verdict: "merged",
            prUrl: "https://github.com/craigoley/remudero/pull/9002",
            prState: "MERGED",
            mergeSha: "deadbeef",
          },
        ],
      },
    ],
  };
}

test("renderTraceGraph: renders the FULL feedback -> proposal PR -> task -> run -> PR chain (the graph view)", () => {
  const root = fakeRoot();
  renderTraceGraph(root, fullChain());
  const html = root.innerHTML;
  assert.match(html, /direction: forward/);
  // feedback -> proposal PR
  assert.match(html, /feedback#fb-1000-abc123/);
  assert.match(html, /proposed/);
  assert.match(html, /href="https:\/\/github\.com\/craigoley\/remudero\/pull\/9001"/);
  // -> task
  assert.match(html, /task W9-T900: fix the retry banner overlap/);
  assert.match(html, /origin: feedback#fb-1000-abc123/);
  // -> run -> PR
  assert.match(html, /run W9-T900-1000: verdict=merged/);
  assert.match(html, /href="https:\/\/github\.com\/craigoley\/remudero\/pull\/9002"/);
  assert.match(html, /MERGED/);
  assert.match(html, /deadbeef/);

  // Ordering: feedback appears before its task, which appears before its run/PR -- a chain, not
  // an unordered bag of facts.
  const feedbackAt = html.indexOf("feedback#fb-1000-abc123");
  const taskAt = html.indexOf("task W9-T900");
  const runAt = html.indexOf("run W9-T900-1000");
  const prAt = html.indexOf("pull/9002");
  assert.ok(feedbackAt < taskAt && taskAt < runAt && runAt < prAt, "chain must render feedback -> task -> run -> PR in order");
});

test("renderTraceGraph: an undispatched task (no runs) says so rather than an empty list", () => {
  const root = fakeRoot();
  const chain: TraceChain = { direction: "reverse", tasks: [{ id: "W9-T901", title: "undispatched", runs: [] }] };
  renderTraceGraph(root, chain);
  assert.match(root.innerHTML, /no runs yet/);
});

test("renderTraceGraph: a REVERSE chain with no resolved feedback renders the task alone", () => {
  const root = fakeRoot();
  const chain: TraceChain = { direction: "reverse", tasks: [{ id: "W9-T902", title: "architect-originated", runs: [] }] };
  renderTraceGraph(root, chain);
  assert.match(root.innerHTML, /direction: reverse/);
  assert.match(root.innerHTML, /task W9-T902/);
  assert.doesNotMatch(root.innerHTML, /feedback#/);
});
