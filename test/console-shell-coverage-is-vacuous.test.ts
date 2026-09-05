import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderShellHtml } from "../src/lib/serve.js";
import {
  acceptanceRowHtml, acceptedSummaryText, askTypeFromEscalationTitle, cardIssueLinkHtml,
  cmpByAge, cmpById, cmpByRecency, cmpMissingLast, consoleShellScriptHelperNames, costLabel,
  decisionSummaryHtml, depChainHtml, draftedTasksHtml, escapeHtml, facetValueMatches, formatAgo,
  formatBytes, formatClock, formatElapsed, formatRelative, formatTimestamp, fuzzyScore,
  isBlockedRow, isSameLocalDay, journeyGraphSvg, journeyHtml, journeyRunHtml, journeyTaskHtml,
  liveSpendHtml, mailboxEscalationClass, mailboxMarkRead, mailboxMarkResolved, mailboxThreadKey,
  mailboxUnreadCount, mailboxVisibleThreads, mergeHoldConfirmationText, needsMeSummaryText,
  nowSummaryText, oldestAgoText, parseSseFrame, planSectionRowHtml, recentPrLinkHtml,
  recentSpendHtml, recentSummaryText, renderConsoleShellScript, restSummaryText, rowChevronHtml,
  rowDetailSkeletonHtml, runRowHtml, searchHaystack, selfMeasurementFigure, selfMeasurementRowHtml,
  statusColorKey, taskWorkstream, upNextSummaryText, usageWindowLabel, withoutVolatile,
  workerStateHtml,
} from "../src/lib/console-shell-script.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * test/console-shell-coverage-is-vacuous.test.ts — W1-T2731.
 *
 * MEASURED AT origin/main WITH THE COVERAGE INSTRUMENT ITSELF. `renderShellHtml` returned ONE
 * template literal of ~4,200 lines and every line of it scored hits the moment the function was
 * called: of the DA records inside the template, ZERO had zero hits and 4,838 read exactly the call
 * count, while 915 of the 1,992 records elsewhere in the SAME file were genuinely uncovered. The
 * instrument worked; the contrast was the finding. `diff-coverage` — which blocks a PR on ONE added
 * line with no covering test — could therefore never fire inside that region.
 *
 * This suite holds the fix at three points: the code is a real module (criterion 1), a line of it
 * that no test exercises really does read ZERO in lcov (criterion 2), and the shell actually CALLS
 * the module rather than keeping a second copy inline (criterion 3).
 */

// ── criterion 1: a real module, imported and called — no regex, no template slicing ────────────

test("W1-T2731 (acceptance 1): the shell's client helpers are imported and called directly — no <script> regex, no eval", () => {
  // If this file needed a regex to reach them, this test could not be written at all.
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.equal(formatElapsed(3_725_000), "1h2m");
  assert.deepEqual(parseSseFrame("event: tick\ndata: 1"), { event: "tick", data: "1" });
  assert.match(journeyHtml({ direction: "forward" }), /direction: forward/);
});

test("W1-T2731: the emitted script runs standalone — every helper resolves with NO module scope in reach", () => {
  // A `.toString()` body carries no closure. A helper that referenced an import or a module-level
  // constant would be a ReferenceError in the browser and nowhere else; this is the check that
  // makes that a test failure instead of a console error an operator finds later.
  const names = consoleShellScriptHelperNames();
  const api = new Function(`${renderConsoleShellScript()}\nreturn {${names.join(",")}};`)() as Record<string, unknown>;
  assert.equal(Object.keys(api).length, names.length, "every declared helper is defined by the emitted text");
  for (const n of names) assert.equal(typeof api[n], "function", `${n} must be callable in the browser's scope`);

  // DEFINED IS NOT ENOUGH — and this half is here because the version without it did NOT redden
  // when a helper was deliberately made to close over a module-level constant. A `.toString()` body
  // carries no closure, so such a reference is a ReferenceError in the browser and nowhere else;
  // a test that only checks `typeof` never executes the line that would throw. So CALL each one.
  // Arity is unknown here, so any TypeError/RangeError from missing arguments is expected and
  // ignored; ONLY a ReferenceError is a verdict, and it means exactly one thing: the emitted text
  // reaches for a name the browser does not have.
  for (const n of names) {
    try {
      (api[n] as (...a: unknown[]) => unknown)();
    } catch (err) {
      assert.ok(
        !(err instanceof ReferenceError),
        `${n} referenced a name that does not exist in the emitted script: ${String(err)} — a helper may close over NOTHING`,
      );
    }
  }
  // and it really is the same behaviour, not merely the same names:
  const browserEscape = api.escapeHtml as (s: unknown) => string;
  assert.equal(browserEscape('<a href="x">&'), escapeHtml('<a href="x">&'));
});

// ── criterion 3: the shell CALLS it, rather than keeping a second copy inline ──────────────────

test("W1-T2731 (acceptance 3): renderShellHtml calls the module, and the emitted helpers reach the shipped page", () => {
  const src = readFileSync(join(REPO_ROOT, "src", "lib", "serve.ts"), "utf8");
  assert.match(src, /\$\{renderConsoleShellScript\(\)\}/, "the template SPLICES the module in — an unwired module is dead code");

  const html = renderShellHtml();
  for (const n of consoleShellScriptHelperNames()) {
    assert.ok(html.includes(`function ${n}(`), `the shipped shell must define ${n} — emitted, not merely exported`);
  }
  // AND THE FALSIFIER FOR "a second copy left beside a still-inline original": each helper is
  // defined EXACTLY ONCE in the page. A stale inline duplicate would shadow the emitted one
  // depending on order, and nothing else in this repo would notice.
  for (const n of consoleShellScriptHelperNames()) {
    const occurrences = html.split(`function ${n}(`).length - 1;
    assert.equal(occurrences, 1, `${n} is defined ${occurrences} times in the shipped page — expected exactly 1`);
  }
});

// ── criterion 2: the coverage instrument can now SEE an unexercised line ───────────────────────

/** Runs one probe file under the SAME instrumentation ci.yml's coverage job uses, and returns the
 *  `DA:<line>,<hits>` records lcov emitted for a given source file. */
function lcovRecordsFor(probeBody: string, sourceSuffix: string): Array<[number, number]> {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}console-shell-cov-`));
  try {
    const probe = join(dir, "probe.test.ts");
    const lcov = join(dir, "lcov.info");
    writeFileSync(probe, probeBody);
    execFileSync(
      process.execPath,
      [
        "--enable-source-maps",
        "--experimental-test-coverage",
        "--test-reporter=lcov",
        `--test-reporter-destination=${lcov}`,
        "--test",
        "--import",
        "tsx",
        probe,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // `node --test` sets NODE_TEST_CONTEXT on its children, and a nested runner that sees it
        // REFUSES to run — printing "skipping running files" and exiting 0 with no lcov at all.
        // NODE_V8_COVERAGE likewise redirects this child's profile into the PARENT's directory
        // when the outer suite is itself instrumented (ci.yml's coverage job), which would make
        // this measurement answer about the wrong run. Both are cleared, deliberately.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, NODE_V8_COVERAGE: undefined } as NodeJS.ProcessEnv,
      },
    );
    // A missing lcov is an unrun probe, never "no coverage" — say which, or the next reader spends
    // the same twenty minutes on the nested-runner refusal above.
    let text: string;
    try {
      text = readFileSync(lcov, "utf8");
    } catch {
      throw new Error(`the instrumented probe produced no lcov at ${lcov} — it did not run, which is NOT a coverage result`);
    }
    // Slice this file's OWN SF: block — an lcov holds one DA:<line> per FILE, and reading across
    // blocks would answer from a different file's identical line numbers.
    const blocks = text.split("\nSF:").map((b, i) => (i === 0 ? b : "SF:" + b));
    const mine = blocks.find((b) => b.startsWith("SF:") && b.split("\n")[0].endsWith(sourceSuffix));
    assert.ok(mine, `lcov holds no SF: record for ${sourceSuffix} — the measurement would be vacuous`);
    return (mine as string)
      .split("\n")
      .map((l) => /^DA:(\d+),(\d+)$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("W1-T2731 (acceptance 2): a helper no test exercises reads ZERO hits — the instrument can finally see it", () => {
  // The probe calls exactly ONE helper. Everything else in the module is genuinely unexercised, so
  // an honest instrument must say so.
  const records = lcovRecordsFor(
    [
      `import { test } from "node:test";`,
      `import { escapeHtml } from "${join(REPO_ROOT, "src", "lib", "console-shell-script.js")}";`,
      `test("calls exactly one helper", () => { escapeHtml("x"); });`,
    ].join("\n"),
    "src/lib/console-shell-script.ts",
  );

  // CONTROL FIRST — without it a zero here proves nothing (the file could simply not be
  // instrumented, which is the vacuous-pass shape this whole task is about).
  assert.ok(records.length > 50, `expected the module to be instrumented line by line, got ${records.length} DA records`);
  const covered = records.filter(([, hits]) => hits > 0);
  assert.ok(covered.length > 0, "the ONE helper the probe called must read hits — otherwise nothing was measured");

  // THE FINDING: unexercised lines read zero. On origin/main this same client code lived inside
  // renderShellHtml's template literal, where NO line could ever read zero.
  const uncovered = records.filter(([, hits]) => hits === 0);
  assert.ok(
    uncovered.length > 0,
    "not one line of 55 unexercised helpers read zero — the region is credited by the call alone again",
  );
});

test("W1-T2731: the contrast, still measurable — every line of what REMAINS in the template is credited by one call", () => {
  const records = lcovRecordsFor(
    [
      `import { test } from "node:test";`,
      `import { renderShellHtml } from "${join(REPO_ROOT, "src", "lib", "serve.js")}";`,
      `test("one call", () => { renderShellHtml(); });`,
    ].join("\n"),
    "src/lib/serve.ts",
  );
  assert.ok(records.length > 100, "control: serve.ts is instrumented");
  const covered = records.filter(([, hits]) => hits > 0).length;
  assert.ok(covered > 0, "one renderShellHtml call credits the template region");
  // This is the defect restated as a measurement, not a regression guard: the template that stays
  // behind still cannot report an unexercised line, which is exactly why the DOM-driving half is a
  // follow-up rather than something this task pretended to fix.
});

// ── the coverage debt the vacuous gate was hiding, now paid ────────────────────────────────────
//
// EVERY branch of every helper below was, on origin/main, credited as covered by one
// `renderShellHtml()` call while nothing exercised it. `diff-coverage` measured 269 uncovered
// lines across 46 of these the moment they became real module code — that number IS the finding,
// and these tests are what it bought. They assert BEHAVIOUR, not shape: each names the rule the
// helper encodes, so a future edit that changes an answer fails here rather than only moving a
// coverage percentage.

test("W1-T2731: time rendering — every threshold and every non-finite input", () => {
  assert.equal(formatRelative("nope" as unknown as number), "", "a non-number renders nothing, never NaN");
  assert.equal(formatRelative(Number.POSITIVE_INFINITY), "");
  assert.equal(formatRelative(500), "just now");
  assert.equal(formatRelative(5_000), "5s ago");
  assert.equal(formatRelative(5 * 60_000), "5m ago");
  assert.equal(formatRelative(5 * 3_600_000), "5h ago");
  assert.equal(formatRelative(5 * 86_400_000), "5d ago");

  assert.equal(formatElapsed("x" as unknown as number), "");
  assert.equal(formatElapsed(-5_000), "0s", "a negative elapsed clamps to zero rather than rendering backwards");
  assert.equal(formatElapsed(45_000), "45s");
  assert.equal(formatElapsed(125_000), "2m5s");

  assert.equal(formatTimestamp(undefined), "unknown");
  assert.equal(formatTimestamp("not-a-date"), "not-a-date", "an unparseable stamp falls back to the raw string, never swallowed");
  assert.match(formatTimestamp(new Date(Date.now() - 5_000).toISOString()), / · 5s ago$/);
  assert.equal(formatClock("not-a-date"), "not-a-date");
  assert.match(formatClock(new Date().toISOString()), /\d/);

  assert.equal(formatAgo("not-a-date"), "", "an unparseable stamp ages to nothing, never to 'just now'");
  assert.equal(formatAgo(new Date().toISOString()), "just now");
  assert.equal(formatAgo(new Date(Date.now() - 5 * 60_000).toISOString()), "5m ago");
  assert.equal(formatAgo(new Date(Date.now() - 5 * 3_600_000).toISOString()), "5h ago");
  assert.equal(formatAgo(new Date(Date.now() - 3 * 86_400_000).toISOString()), "3d ago");

  assert.equal(formatBytes("x" as unknown as number), "unknown");
  assert.equal(formatBytes(512), "512.0 B");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 ** 5 * 2), "2.0 PB", "the unit table stops at PB rather than running off its end");

  const now = new Date();
  assert.equal(isSameLocalDay(now, new Date(now)), true);
  assert.equal(isSameLocalDay(now, new Date(now.getTime() - 86_400_000 * 40)), false);

  assert.equal(oldestAgoText([], () => "x"), null, "nothing in, null out — not an empty string that renders as a gap");
  assert.equal(oldestAgoText([{ t: undefined }], (i) => i.t), null, "a row with no stamp is skipped, not treated as now");
  assert.equal(oldestAgoText([{ t: "nope" }], (i) => i.t), null, "and neither is an unparseable one");
  assert.equal(
    oldestAgoText(
      [{ t: new Date(Date.now() - 60_000).toISOString() }, { t: new Date(Date.now() - 5 * 3_600_000).toISOString() }],
      (i) => i.t,
    ),
    "5h ago",
    "the OLDEST, not the first",
  );

  assert.equal(costLabel(1.5), "$1.500");
  assert.equal(costLabel(undefined), "—", "an unknown cost is a dash, never $0.000 asserted as fact");
});

test("W1-T2731: classification, search and sorting — every branch of each rule", () => {
  assert.equal(taskWorkstream("W1-T42"), "W1");
  assert.equal(taskWorkstream("noseparator"), "noseparator", "an id with no -T marker is its own workstream");

  assert.equal(statusColorKey({ needsHuman: true, status: "merged" }), "needs-human", "needs-human outranks every other state");
  assert.equal(statusColorKey({ status: "merged" }), "merged");
  assert.equal(statusColorKey({ status: "done" }), "merged");
  assert.equal(statusColorKey({ status: "blocked" }), "blocked");
  assert.equal(statusColorKey({ status: "queued" }), "queued");
  assert.equal(statusColorKey({ status: "anything-else" }), "running");

  assert.equal(searchHaystack({ taskId: "W1-T1" }), "W1-T1 ", "a title-less row still searches by id");
  assert.equal(searchHaystack({ taskId: "W1-T1", title: "t" }), "W1-T1 t");
  assert.equal(isBlockedRow({ status: "blocked" }), true);
  assert.equal(isBlockedRow({ needsHuman: true }), true);
  assert.equal(isBlockedRow({ status: "running" }), false);

  assert.equal(cmpMissingLast(undefined, undefined, "asc"), 0);
  assert.equal(cmpMissingLast(undefined, 1, "asc"), 1, "missing sorts LAST regardless of direction");
  assert.equal(cmpMissingLast(1, undefined, "desc"), -1);
  assert.equal(cmpMissingLast(1, 2, "asc"), -1);
  assert.equal(cmpMissingLast(1, 2, "desc"), 1);

  assert.equal(cmpById({ taskId: "a" }, { taskId: "b" }, "asc"), -1);
  assert.equal(cmpById({ taskId: "b" }, { taskId: "a" }, "asc"), 1);
  assert.equal(cmpById({ taskId: "a" }, { taskId: "a" }, "asc"), 0);
  assert.equal(cmpById({ taskId: "a" }, { taskId: "b" }, "desc"), 1);
  assert.equal(cmpByAge({ elapsedMs: 1 }, { elapsedMs: 2 }, "asc"), -1);
  assert.equal(cmpByRecency({}, {}, "asc"), 0, "two rows with no activity stamp tie rather than throwing");
  // A comparator's contract is the SIGN, not the magnitude — cmpMissingLast returns a difference
  // of parsed timestamps, so asserting -1 here would be asserting an implementation detail that is
  // not true (it is -86_400_000).
  assert.ok(cmpByRecency({ lastActivityAt: "2026-01-02T00:00:00Z" }, { lastActivityAt: "2026-01-01T00:00:00Z" }, "desc") < 0,
    "desc puts the MORE recent row first");
  assert.ok(cmpByRecency({ lastActivityAt: "2026-01-02T00:00:00Z" }, { lastActivityAt: "2026-01-01T00:00:00Z" }, "asc") > 0);
  assert.ok(cmpByRecency({ lastActivityAt: "2026-01-01T00:00:00Z" }, {}, "asc") < 0, "a row with no stamp sorts last");

  assert.equal(fuzzyScore("", "anything"), 0, "an empty query scores 0 — a real score, never null");
  assert.equal(fuzzyScore("zzz", "abc"), null, "no subsequence match is null, which callers filter on");
  assert.equal(fuzzyScore("abc", "abc"), 1 + 3 + 3, "adjacent hits score 3, the first scores 1");
  assert.ok((fuzzyScore("ac", "abc") as number) < (fuzzyScore("ab", "abc") as number), "a tighter run outranks a scattered one");

  const row = { taskId: "W1-T1", status: "queued", risk: "high", prUrl: "u", needsHuman: true } as const;
  assert.equal(facetValueMatches(row, "status", "needs-human"), true);
  assert.equal(facetValueMatches(row, "workstream", "W1"), true);
  assert.equal(facetValueMatches(row, "risk", "high"), true);
  assert.equal(facetValueMatches({ taskId: "x" }, "risk", ""), true, "an absent risk matches the empty facet, not nothing");
  assert.equal(facetValueMatches(row, "hasPr", "ignored"), true);
  assert.equal(facetValueMatches(row, "needsMe", "ignored"), true);
  assert.equal(facetValueMatches(row, "unknown-group", "x"), true, "an unknown facet group filters nothing out");

  assert.deepEqual(withoutVolatile({ taskId: "x", elapsedMs: 1, lastActivityAt: "t", liveSpendUsd: 2, liveTurns: 3, status: "queued" }), {
    taskId: "x",
    status: "queued",
  });

  assert.equal(parseSseFrame("data: 1"), undefined, "a frame with no event names nothing");
  assert.equal(parseSseFrame("event: tick"), undefined, "and one with no data carries nothing");
  assert.deepEqual(parseSseFrame("event: tick\ndata: a\ndata: b"), { event: "tick", data: "a\nb" }, "multi-line data rejoins");

  assert.equal(usageWindowLabel(undefined), "unknown");
  assert.equal(usageWindowLabel(undefined, "too-old"), "unknown (too-old)");
  assert.equal(usageWindowLabel({ percentUsed: 40 }), "40%");
  assert.equal(usageWindowLabel({ percentUsed: 40, resetsAt: "not-a-date" }), "40% · resets not-a-date");
  assert.equal(askTypeFromEscalationTitle("[GRILL] x"), "question");
  assert.equal(askTypeFromEscalationTitle("[MANUAL] x"), "action");
  assert.equal(askTypeFromEscalationTitle("no prefix"), undefined);
  assert.equal(
    mergeHoldConfirmationText("engage", "the whole fleet", "incident freeze"),
    "Confirm ENGAGE automatic-merge hold for the whole fleet — reason: incident freeze?",
  );
});

test("W1-T2731: the mailbox's set algebra — resolved is HIDDEN, never deleted, and nothing mutates its input", () => {
  assert.equal(mailboxEscalationClass("[GRILL] x"), "GRILL");
  assert.equal(mailboxEscalationClass(undefined), "UNKNOWN");
  assert.equal(mailboxThreadKey("W1-T1", "GRILL"), "thread:W1-T1::GRILL::");

  const threads = [{ threadId: "a" }, { threadId: "b" }];
  assert.deepEqual(mailboxVisibleThreads(threads, ["a"], false), [{ threadId: "b" }]);
  assert.deepEqual(mailboxVisibleThreads(threads, ["a"], true), threads, "includeResolved shows everything");
  assert.deepEqual(mailboxVisibleThreads(threads, undefined, false), threads, "no resolved list hides nothing");

  assert.equal(mailboxUnreadCount(threads, ["a"]), 1);
  assert.equal(mailboxUnreadCount(threads, undefined), 2);

  const readIds = ["a"];
  assert.deepEqual(mailboxMarkRead(readIds, "b"), ["a", "b"]);
  assert.deepEqual(readIds, ["a"], "pure — the caller's array is untouched");
  assert.deepEqual(mailboxMarkRead(readIds, "a"), ["a"], "marking an already-read thread is idempotent");
  assert.deepEqual(mailboxMarkRead(undefined, "a"), ["a"]);
  const resolvedIds = ["a"];
  assert.deepEqual(mailboxMarkResolved(resolvedIds, "b"), ["a", "b"]);
  assert.deepEqual(resolvedIds, ["a"]);
  assert.deepEqual(mailboxMarkResolved(undefined, "a"), ["a"]);
});

test("W1-T2731: the summary lines — an empty collection says so in words, never renders a bare zero", () => {
  assert.equal(nowSummaryText([]), "nothing in flight");
  assert.match(nowSummaryText([{ startedAt: new Date(Date.now() - 60_000).toISOString() }]), /^1 running · oldest 1m ago$/);
  assert.equal(nowSummaryText([{}]), "1 running", "a row with no start stamp still counts, with no age clause");

  assert.equal(needsMeSummaryText([]), "nothing needs you");
  assert.match(needsMeSummaryText([{ ts: new Date(Date.now() - 60_000).toISOString() }]), /^1 open · oldest 1m ago$/);
  assert.equal(upNextSummaryText([]), "nothing waiting to gather");
  assert.equal(upNextSummaryText([{ id: "W1-T1" }]), "next: W1-T1");
  assert.equal(upNextSummaryText([{ id: "W1-T1" }, { id: "W1-T2" }]), "next: W1-T1 (+1 more)");

  assert.equal(recentSummaryText([]), "no recent activity yet");
  const nowIso = new Date().toISOString();
  assert.match(recentSummaryText([{ verb: "merged", ts: nowIso }]), /^1 landed today · last just now$/);
  assert.match(recentSummaryText([{ verb: "opened", ts: nowIso }]), /^0 landed today/, "only merges count as landed");

  assert.equal(acceptedSummaryText([]), "nothing accepted yet");
  assert.match(acceptedSummaryText([{ ts: new Date(Date.now() - 60_000).toISOString() }]), /^1 accepted · most recent 1m ago$/);

  assert.equal(restSummaryText([]), "nothing else to show");
  assert.equal(
    restSummaryText([{ taskId: "a", status: "queued" }, { taskId: "b", status: "merged" }, { taskId: "c", status: "running" }]),
    "queued: 1 · merged: 1 · other: 1 (3 total)",
  );
});

test("W1-T2731: self-measurement figures — refused, absent, scalar, nested and never-measured are five DISTINCT renderings", () => {
  assert.deepEqual(selfMeasurementFigure(null), { refused: false, text: "" });
  assert.deepEqual(selfMeasurementFigure(42), { refused: false, text: "42" });
  assert.deepEqual(selfMeasurementFigure([1, 2]), { refused: false, text: "1,2" }, "an array is stringified, not treated as fields");
  assert.deepEqual(selfMeasurementFigure({ status: "refused", refusedReason: "no data" }), { refused: true, text: "no data" });
  assert.deepEqual(selfMeasurementFigure({ status: "refused" }), { refused: true, text: "refused (no reason given)" });
  assert.deepEqual(selfMeasurementFigure({ status: "ok" }), { refused: false, text: "ok" }, "no fields falls back to the status word");
  assert.deepEqual(selfMeasurementFigure({ a: 1, b: null, c: [1, 2, 3], d: { nested: 1 } }), {
    refused: false,
    text: "a: 1, c: 3",
    // b is absent (skipped, not rendered as null); d is a nested shape (SKIPPED, never zeroed).
  });

  const verb = { key: "k", label: "L" };
  assert.match(selfMeasurementRowHtml(verb, []), /never measured/);
  assert.match(selfMeasurementRowHtml(verb, [{ ts: "t", result: {} }]), /never measured/, "a row without this verb's key is not a measurement");
  const one = selfMeasurementRowHtml(verb, [{ ts: new Date().toISOString(), result: { k: 7 } }]);
  assert.match(one, /data-self-measurement-state="measured"/);
  assert.match(one, /7 · as of /);
  assert.doesNotMatch(one, /previously:/, "one reading has no previous to compare against");
  const two = selfMeasurementRowHtml(verb, [
    { ts: new Date().toISOString(), result: { k: 7 } },
    { ts: new Date().toISOString(), result: { k: 5 } },
  ]);
  assert.match(two, / · previously: 5</);
  assert.match(
    selfMeasurementRowHtml(verb, [{ ts: new Date().toISOString(), result: { k: { status: "refused", refusedReason: "why" } } }]),
    /data-self-measurement-state="refused"[\s\S]*refused: why/,
  );
});

test("W1-T2731: the row fragments — every branch, and every one escapes what it interpolates", () => {
  assert.match(rowChevronHtml(), /row-chevron/);
  assert.match(rowDetailSkeletonHtml(), /aria-busy="true"/);
  assert.match(planSectionRowHtml({ heading: "<b>7C</b>", merged: 1, filed: 2 }), /&lt;b&gt;7C&lt;\/b&gt;/);
  assert.match(planSectionRowHtml({ heading: "h", merged: 1, filed: 2 }), /1 of 2 filed tasks merged/);

  assert.equal(liveSpendHtml({ taskId: "x" }), "", "a row with neither spend nor turns renders nothing");
  assert.match(liveSpendHtml({ taskId: "x", liveSpendPending: true }), /no data yet/);
  assert.match(liveSpendHtml({ taskId: "x", liveSpendUsd: 1 }), /\$1\.000$/, "spend with no turns omits the turns clause");
  assert.match(liveSpendHtml({ taskId: "x", liveSpendUsd: 1, liveTurns: 3 }), /\$1\.000 \/ 3 turns$/);

  assert.match(workerStateHtml({ taskId: "x" }), /state unknown/);
  assert.match(workerStateHtml({ taskId: "x", workerState: "working" }), />working</);
  assert.match(workerStateHtml({ taskId: "x", workerState: "tool-executing" }), />tool-executing</);
  assert.match(workerStateHtml({ taskId: "x", workerState: "quiet", workerStateSince: "<t>" }), /data-worker-since="&lt;t&gt;"/);

  assert.equal(draftedTasksHtml(undefined), "");
  assert.equal(draftedTasksHtml([]), "");
  assert.match(draftedTasksHtml([{ id: "W1-T1", title: "<t>" }]), /W1-T1<\/span> &lt;t&gt;/);

  assert.equal(recentPrLinkHtml({}), "", "no PR url renders no link");
  assert.match(recentPrLinkHtml({ prUrl: "u", prNumber: 1, prTitle: "t" }), /#1 — t</);
  assert.match(recentPrLinkHtml({ prUrl: "u", prNumber: 1 }), />#1</, "a number with no title still labels the link");
  assert.match(recentPrLinkHtml({ prUrl: "u", prTitle: "t" }), />t</);
  assert.match(recentPrLinkHtml({ prUrl: "u" }), />u</, "and with neither, the url itself is the label");

  assert.equal(recentSpendHtml({}), "");
  assert.match(recentSpendHtml({ costUsd: 1 }), /\$1\.000<\/span>$/);
  assert.match(recentSpendHtml({ numTurns: 2 }), /— \/ 2 turns/, "turns with no cost still render, with a dash for the unknown cost");

  assert.match(runRowHtml({ runId: "R" }), /no verdict yet/);
  assert.match(runRowHtml({ runId: "R", verdict: "merged", costUsd: 1, prUrl: "u" }), /merged · \$1\.000 · <a href="u"/);
  assert.match(acceptanceRowHtml({ claim: "<c>", proof: "<p>" }), /&lt;c&gt;[\s\S]*proof: &lt;p&gt;/);
  assert.equal(depChainHtml([]), '<p class="empty">no dependencies</p>');
  assert.match(depChainHtml(["W1-T1"]), /data-dep-id="W1-T1"/);
  assert.equal(cardIssueLinkHtml(null), "");
  assert.equal(cardIssueLinkHtml({}), "");
  assert.match(cardIssueLinkHtml({ escalationIssueUrl: "u" }), /href="u"/);

  assert.match(decisionSummaryHtml(null, "<raw/>"), /^<raw\/>$/, "no summary falls back to the raw body unchanged");
  assert.match(decisionSummaryHtml({ summary: { headline: "h", decision: "d", options: [{ label: "a", consequence: "b" }] } }, "<raw/>"), /^<raw\/>$/,
    "fewer than two options is not a decision — the raw body stands");
  const decided = decisionSummaryHtml(
    { summary: { headline: "h", what_happened: "w", decision: "d", options: [{ label: "a", consequence: "b" }, { label: "c", consequence: "e" }] } },
    "<raw/>",
  );
  assert.match(decided, /decision-what-happened/);
  assert.match(decided, /<details class="decision-raw">/, "the raw body is kept behind a disclosure, never dropped");
  assert.doesNotMatch(
    decisionSummaryHtml({ summary: { headline: "h", decision: "d", options: [{ label: "a", consequence: "b" }, { label: "c", consequence: "e" }] } }, "<raw/>"),
    /decision-what-happened/,
    "an absent what_happened renders no empty paragraph",
  );
});

test("W1-T2731: the journey graph — an empty chain draws nothing, and a blocked run is marked exactly once", () => {
  assert.equal(journeyGraphSvg({}), "", "nothing to draw draws nothing, not an empty <svg>");
  const svg = journeyGraphSvg({
    feedback: { id: "FB1", status: "proposed" },
    tasks: [{ id: "W1-T1", title: "t", runs: [{ runId: "R1", verdict: "blocked_ci" }, { runId: "R2" }] }],
  });
  assert.match(svg, /<svg class="journey-graph"/);
  assert.equal(svg.split("journey-graph-fail").length - 1, 1, "exactly one node carries the failing class");
  assert.equal(svg.split("journey-graph-edge").length - 1, 3, "feedback→task and task→each run");
  assert.match(journeyGraphSvg({ tasks: [{ id: "W1-T1" }] }), /<svg/, "a task with no feedback parent still draws");

  assert.match(journeyRunHtml({ runId: "R" }), /no verdict yet/);
  const failing = journeyRunHtml({ runId: "R", verdict: "blocked_ci", prUrl: "u", prState: "OPEN" });
  assert.equal(failing.split("journey-fail").length - 1, 1, "ONE marker per failing run — this file's own note");
  assert.match(failing, /\[OPEN\] — sha \(not merged yet\)/);
  assert.match(journeyRunHtml({ runId: "R", prUrl: "u", mergeSha: "abc" }), /sha abc/);
  assert.match(journeyTaskHtml({ id: "W1-T1", title: "t" }), /\(no runs yet\)/);
  assert.match(journeyTaskHtml({ id: "W1-T1", title: "t", origin: "o", runs: [{ runId: "R" }] }), /\(origin: o\)/);

  assert.match(journeyHtml(null), /direction: unknown/, "an absent chain still reports the direction line");
  assert.match(journeyHtml({}), /\(no tasks yet\)/);
  const full = journeyHtml({ direction: "reverse", feedback: { id: "FB1", status: "proposed", raw: "r", proposalPr: "u" }, tasks: [{ id: "W1-T1", title: "t" }] });
  assert.match(full, /feedback#FB1 \[proposed\] — r/);
  assert.match(full, /proposal PR<\/a>/);
  assert.match(full, /direction: reverse/);
  // DEGRADE, NEVER DISAPPEAR: a task list that throws mid-render must still leave the direction
  // line and the feedback row standing — the guard this function exists for.
  const hostile = journeyHtml({ direction: "d", tasks: [Object.defineProperty({ id: "x" }, "runs", { get() { throw new Error("boom"); } })] });
  assert.match(hostile, /direction: d/, "the direction line survives a hostile task entry");
  assert.match(hostile, /unable to render tasks/, "and says so rather than blanking");
  // The feedback row has its OWN guard, and it is a SEPARATE arm — a suite that exercised only the
  // task-list catch above would leave this one dead, which is exactly what diff-coverage caught.
  const hostileFeedback = journeyHtml({
    direction: "d",
    feedback: Object.defineProperty({ id: "FB1" }, "status", { get() { throw new Error("boom"); } }),
    tasks: [{ id: "W1-T1", title: "t" }],
  });
  assert.match(hostileFeedback, /direction: d/, "the direction line survives an unreadable feedback row");
  assert.doesNotMatch(hostileFeedback, /feedback#/, "the feedback line is DROPPED, not rendered half-formed");
  assert.match(hostileFeedback, /W1-T1/, "and the task list beside it still renders — degrade, never disappear");
});
