// test/console-shell-unknowns.test.ts — W1-T2218.
//
// THE DEFECT (two client-side labels, no server behaviour touched — plan_refs W1-T281/W1-T282/
// W1-T262/W1-T2219). `updateGithubBanner` (src/lib/serve.ts) used to stamp `new Date()` into a
// client-module variable the first time any task carried `indeterminate: true` and render
// "GitHub unreachable since <t>" — the BROWSER's clock at first paint, never the instant a read
// actually began failing and never a server fact (measured 17s off the real
// `board_gateway.fetch_ok`, task rationale (2)). And `renderGlanceStrip`'s own doc comment states
// the rule it only half-applies: merged-today/spend-today/spend-this-week guard with `"…"`
// (unknown, never a fabricated 0) until the first real snapshot lands, but `glance-running` was a
// bare `tasks.filter((t) => t.phase).length` — indistinguishable from a genuinely empty/measured
// zero.
//
// Both functions are extracted VERBATIM from the REAL served script (the SAME `new Function`
// extraction discipline test/control-status-daemon-liveness.test.ts and test/serve.test.ts already
// use for pure client-side render logic), never a reimplementation of the logic under test —
// learnings#probe-must-exercise-the-real-consuming-client: a hand-copied stand-in would prove
// nothing about what the shell actually ships.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderShellHtml } from "../src/lib/serve.js";

const HTML = renderShellHtml();

function clientFn(name: string): string {
  const re = new RegExp("function " + name + "\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}()`);
  return src as string;
}

/** The same verbatim-extraction discipline for a top-level `const` the extracted functions read. */
function clientConst(name: string): string {
  const re = new RegExp("const " + name + " =[\\s\\S]*?;\\n");
  const src = HTML.match(re)?.[0];
  assert.ok(src, `the shell's inline script must define ${name}`);
  return src as string;
}

// ── (i)/(ii) THE BANNER: re-worded, not deleted — asserts only what THIS page load can see ──────

interface BannerEl {
  hidden: boolean;
  textContent: string;
}

/** Builds a fresh sandbox around the REAL updateGithubBanner, over a stub DOM -- mirrors
 *  test/control-status-daemon-liveness.test.ts's harness() for applyControlStatus. */
function bannerHarness() {
  const banner: BannerEl = { hidden: true, textContent: "" };
  const elements: Record<string, unknown> = { "gh-unreachable-banner": banner };
  const factory = new Function(
    "elements",
    [
      "var document = { getElementById: function (id) { return elements[id] === undefined ? null : elements[id]; } };",
      // THE BANNER'S OWN COLLABORATORS, EXTRACTED VERBATIM TOO. `updateGithubBanner` renders its
      // page-load clock through the shell's real `formatTimestamp`/`formatRelative` over the real
      // `PAGE_LOADED_ISO` constant, so a sandbox holding only `updateGithubBanner` throws
      // `formatTimestamp is not defined` before any assertion below can run. Pulling them from the
      // SAME served script keeps this file's stated discipline -- never a reimplementation -- and
      // means the exact string the operator sees is what gets asserted on.
      clientConst("PAGE_LOADED_ISO"),
      clientFn("formatRelative"),
      clientFn("formatTimestamp"),
      clientFn("updateGithubBanner"),
      "return { updateGithubBanner: updateGithubBanner };",
    ].join("\n"),
  ) as (els: unknown) => { updateGithubBanner: (tasks: unknown[]) => void };
  const built = factory(elements);
  return { update: (tasks: unknown[]) => built.updateGithubBanner(tasks), banner };
}

test("W1-T2218: a page load with no completed GitHub read renders a label about THIS page load, never a fabricated outage-start timestamp", () => {
  const h = bannerHarness();
  h.update([{ taskId: "W1-T1", indeterminate: true }]);
  assert.equal(h.banner.hidden, false);
  assert.match(h.banner.textContent, /no GitHub read has completed since this page loaded/);
  // THE FALSIFIER THIS TASK NAMES, AND IT DISCRIMINATES RATHER THAN BANNING DIGITS. The defect was
  // a clock presented AS THE OUTAGE START ("GitHub unreachable since 6:47 PM") -- a fact the page
  // never observed. A clock presented as THIS PAGE LOAD's navigation start is the opposite: a fact
  // the page holds about itself, and W1-T183 REQUIRES it, because every time cell must carry both
  // a local clock reading and a relative one and this banner is a time cell. A blanket
  // `/\d{1,2}:\d{2}/` ban forbade both and so forbade the very thing W1-T183 mandates; these three
  // assertions forbid only the first.
  assert.doesNotMatch(h.banner.textContent, /since \d/i, "must never claim a stamped outage-start instant");
  assert.doesNotMatch(h.banner.textContent, /GitHub unreachable since \d/, "the discarded outage-start sentence must never return");
  // The page-load reading is the ONE clock this label may carry, and it is parenthesised. Outside
  // those parentheses no clock literal belongs -- which still fails the old sentence, whose clock
  // sat bare in the prose.
  const outsidePageLoadReading = h.banner.textContent.replace(/\([^)]*\)/g, "");
  assert.doesNotMatch(outsidePageLoadReading, /\d{1,2}:\d{2}/, "no clock-time literal belongs outside the page-load reading");

  // PROVEN TO DISCRIMINATE, not merely claimed: the discarded label must still fail every predicate
  // above. Without this, a later widening could quietly admit the outage-start shape again.
  const discardedLabel = "GitHub unreachable since 6:47:40 PM EDT — statuses may be stale";
  assert.match(discardedLabel, /since \d/i, "control: the discarded label is what these predicates must reject");
  assert.match(discardedLabel, /GitHub unreachable since \d/);
  assert.match(discardedLabel.replace(/\([^)]*\)/g, ""), /\d{1,2}:\d{2}/);
});

test("W1-T2218: the banner is re-worded rather than removed — the indeterminate signal still reaches the operator, and clears the instant no task reports it", () => {
  const h = bannerHarness();
  h.update([{ taskId: "W1-T1", indeterminate: true }]);
  assert.equal(h.banner.hidden, false, "the signal must still surface -- this is a reword, not a deletion");
  assert.notEqual(h.banner.textContent, "", "a visible banner must carry real text");

  // A later render with nothing indeterminate clears it -- unchanged behaviour, re-derived fresh
  // every call rather than a latched string a later success forgets to clear.
  h.update([{ taskId: "W1-T1", indeterminate: false }]);
  assert.equal(h.banner.hidden, true);
  assert.equal(h.banner.textContent, "");
});

test("W1-T2218: updateGithubBanner no longer stamps a Date into a client-module variable -- the discarded outage-start model is gone from the shell, not merely hidden behind new text", () => {
  assert.doesNotMatch(HTML, /githubUnreachableSince/, "the client-module variable that re-armed on every reload must be gone");
});

// ── (iii) THE GLANCE STRIP: running falls back to "…", using the guard already three lines
// below it for spend -- a fabricated number is never the fallback ───────────────────────────────

interface GlanceEl {
  textContent: string;
}

function fakeGlanceEl(): GlanceEl {
  return { textContent: "…" };
}

/** Builds a fresh sandbox around the REAL renderGlanceStrip (+ its real setGlanceValue/
 *  isBlockedRow/costLabel helpers, extracted verbatim), over stub DOM + module state -- mirrors
 *  bannerHarness above and test/control-status-daemon-liveness.test.ts's harness(). */
function glanceHarness(opts: { tasksSnapshotKnown: boolean; latestSpend?: unknown; latestNeedsMeRows?: unknown[] }) {
  const elements: Record<string, GlanceEl> = {
    "glance-running": fakeGlanceEl(),
    "glance-needs-me": fakeGlanceEl(),
    "glance-blocked": fakeGlanceEl(),
    "glance-queued": fakeGlanceEl(),
    "glance-merged-today": fakeGlanceEl(),
    "glance-spend-today": fakeGlanceEl(),
    "glance-spend-week": fakeGlanceEl(),
  };
  const factory = new Function(
    "elements",
    "opts",
    [
      "var document = { getElementById: function (id) { return elements[id] === undefined ? null : elements[id]; } };",
      "var tasksSnapshotKnown = opts.tasksSnapshotKnown;",
      "var latestSpend = opts.latestSpend === undefined ? null : opts.latestSpend;",
      "var latestNeedsMeRows = opts.latestNeedsMeRows || [];",
      clientFn("setGlanceValue"),
      clientFn("isBlockedRow"),
      clientFn("costLabel"),
      clientFn("renderGlanceStrip"),
      "return { renderGlanceStrip: renderGlanceStrip };",
    ].join("\n"),
  ) as (els: unknown, opts: unknown) => { renderGlanceStrip: (tasks: unknown[]) => void };
  const built = factory(elements, opts);
  return { render: (tasks: unknown[]) => built.renderGlanceStrip(tasks), elements };
}

test("W1-T2218: the running value renders as unknown ('…') before any snapshot has landed, and never as a number", () => {
  const h = glanceHarness({ tasksSnapshotKnown: false });
  // Even a non-empty tasks array must not leak a real count before the flag says a snapshot landed.
  h.render([{ taskId: "W1-T1", phase: "implement" }]);
  assert.equal(h.elements["glance-running"]!.textContent, "…");
  assert.notEqual(h.elements["glance-running"]!.textContent, "0");
  assert.notEqual(h.elements["glance-running"]!.textContent, "1");
});

test("W1-T2218: a genuinely measured zero still renders as zero, and is distinguishable from the unknown case", () => {
  const known = glanceHarness({ tasksSnapshotKnown: true });
  known.render([{ taskId: "W1-T1", status: "queued" }, { taskId: "W1-T2", status: "queued" }]); // neither carries a phase
  assert.equal(known.elements["glance-running"]!.textContent, "0", "a real snapshot with nothing running is a measured zero");

  const unknown = glanceHarness({ tasksSnapshotKnown: false });
  unknown.render([]);
  assert.equal(unknown.elements["glance-running"]!.textContent, "…");
  assert.notEqual(
    unknown.elements["glance-running"]!.textContent,
    known.elements["glance-running"]!.textContent,
    "the unknown case and the measured-zero case must render distinct text",
  );

  // And a real snapshot that DOES have a running task still renders the true count once known.
  const runningKnown = glanceHarness({ tasksSnapshotKnown: true });
  runningKnown.render([{ taskId: "W1-T1", phase: "implement" }, { taskId: "W1-T2", status: "queued" }]);
  assert.equal(runningKnown.elements["glance-running"]!.textContent, "1");
});

test("W1-T2218: the spend values (merged-today/spend-today/spend-this-week) keep the guard they already have, unaffected by tasksSnapshotKnown", () => {
  const h = glanceHarness({ tasksSnapshotKnown: true, latestSpend: null });
  h.render([]);
  assert.equal(h.elements["glance-merged-today"]!.textContent, "…", "spend guards off latestSpend, never off tasksSnapshotKnown");
  assert.equal(h.elements["glance-spend-today"]!.textContent, "…");
  assert.equal(h.elements["glance-spend-week"]!.textContent, "…");

  const withSpend = glanceHarness({
    tasksSnapshotKnown: false, // deliberately false -- proves spend does not borrow running's flag either
    latestSpend: { mergedToday: 4, spendTodayUsd: 1.5, spendWeekUsd: 3.5 },
  });
  withSpend.render([]);
  assert.equal(withSpend.elements["glance-merged-today"]!.textContent, "4");
  assert.equal(withSpend.elements["glance-spend-today"]!.textContent, "$1.500");
  assert.equal(withSpend.elements["glance-spend-week"]!.textContent, "$3.500");
  // running, meanwhile, is STILL "…" here -- the two guards are independent, never conflated.
  assert.equal(withSpend.elements["glance-running"]!.textContent, "…");
});

// ── Source-level lock: tasksSnapshotKnown is set at the SAME two call sites latestSpend already
// is (paintSnapshot's cache restore, refreshAll's live poll) -- never a third, independently-timed
// toggle that could disagree with the spend guard it mirrors ───────────────────────────────────

test("W1-T2218: tasksSnapshotKnown is written beside latestSpend at both its existing call sites, never invented as a new, independently-timed mechanism", () => {
  assert.match(HTML, /latestSpend = snapshot\.spend \?\? null;\s*\n\s*tasksSnapshotKnown = true;/, "paintSnapshot's cache-restore path");
  assert.match(HTML, /latestSpend = statusSnap\.spend \?\? null;\s*\n\s*tasksSnapshotKnown = true;/, "refreshAll's live-poll path");
});
