import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildReplay,
  resolveReplayLedgerLines,
  type ReplayLedgerLine,
} from "../src/lib/ledger-replay.js";
import type { LedgerGrepFsDeps } from "../src/lib/ledger-grep.js";

// ── W1-T2296 — "an incident is reconstructed by hand every time" ───────────────────────────────
//
// `buildReplay` narrates a WINDOW of ledger rows as one ordered, deterministic, absent-says-absent
// plain-text account — the operation every hand-joined incident reconstruction in the record has
// performed by hand (filter a window, order by timestamp, read the reason fields). Modeled on
// `buildReceipt`'s discipline (src/lib/receipt.ts): pure generator, no clock reads, no
// fabrication. `resolveReplayLedgerLines` reads the corpus through `resolveLedgerUnion`
// (ledger-grep.ts), refusing on partial coverage exactly as `resolveReceiptLedgerLines` does.

const SINCE = "2026-08-25T10:40:00.000Z";
const UNTIL = "2026-08-25T11:20:00.000Z";

// ── claim: "a window of ledger rows renders as one ordered narration carrying each row's own
//    reason" ──────────────────────────────────────────────────────────────────────────────────

test("a window of ledger rows renders as one ordered narration, each line carrying its own reason", () => {
  const lines: ReplayLedgerLine[] = [
    {
      ts: "2026-08-25T11:05:00.000Z",
      run_id: "RUN-B",
      task_id: "W1-T2244",
      step: "automerge.arm_skipped",
      outcome: "skipped",
      reason: "dependabot PR — the dep-review lane owns arming for these",
    },
    {
      ts: "2026-08-25T10:41:03.000Z",
      run_id: "RUN-A",
      task_id: "W1-T2245",
      step: "automerge.armed",
      outcome: "armed",
      reason: "verdict is a full PASS",
    },
  ];
  const narration = buildReplay(lines, { since: SINCE, until: UNTIL });
  const rendered = narration.split("\n");

  assert.equal(rendered[0], "rmd replay 2026-08-25T10:40:00.000Z..2026-08-25T11:20:00.000Z: 2 ledger row(s), ordered by timestamp");
  // Ordered by ts ascending — the 10:41 row (RUN-A) narrates BEFORE the 11:05 row (RUN-B), even
  // though RUN-B was listed first in the input array.
  assert.match(rendered[1], /^2026-08-25T10:41:03\.000Z\s+run=RUN-A\s+task=W1-T2245\s+step=automerge\.armed\s+outcome=armed\s+reason=verdict is a full PASS$/);
  assert.match(rendered[2], /^2026-08-25T11:05:00\.000Z\s+run=RUN-B\s+task=W1-T2244\s+step=automerge\.arm_skipped\s+outcome=skipped\s+reason=dependabot PR/);
});

// ── claim: "identical rows in produce byte-identical narration out" ────────────────────────────

test("buildReplay is deterministic — byte-identical narration across two calls over the identical rows", () => {
  const lines: ReplayLedgerLine[] = [
    { ts: "2026-08-25T10:45:00.000Z", run_id: "RUN-A", task_id: "W1-T71", step: "run.start" },
    { ts: "2026-08-25T10:41:03.000Z", run_id: "RUN-A", task_id: "W1-T2245", step: "automerge.armed", outcome: "armed" },
    { ts: "2026-08-25T10:41:03.000Z", run_id: "RUN-B", task_id: "W1-T444", step: "review.posted", reviewer_outcome: "reviewer_completed" },
  ];
  const first = buildReplay(lines, { since: SINCE, until: UNTIL });
  const second = buildReplay(lines, { since: SINCE, until: UNTIL });
  assert.equal(first, second);
  // Two rows share the identical ts (10:41:03.000Z) — the run_id tie-break must keep the order
  // stable rather than depending on incidental array position, so a third call over the SAME
  // rows in a freshly-cloned array still narrates identically.
  const third = buildReplay(JSON.parse(JSON.stringify(lines)), { since: SINCE, until: UNTIL });
  assert.equal(first, third);
});

// ── claim: "a row with no reason field narrates as absent rather than invented" ────────────────

test("a row with no reason field narrates as absent, never invented", () => {
  const lines: ReplayLedgerLine[] = [
    // The canonical pre-#981 shape (design (iii)): an automerge.armed row recording no reason.
    { ts: "2026-08-25T10:50:00.000Z", run_id: "RUN-C", task_id: "W1-T71", step: "automerge.armed", outcome: "armed" },
  ];
  const narration = buildReplay(lines, { since: SINCE, until: UNTIL });
  assert.match(narration, /reason=absent \(no "reason" field on this row\)/);
  // The row DID carry an outcome — that must still print as-is, not also collapse to absent.
  assert.match(narration, /outcome=armed/);
});

// ── claim: "rows outside the requested window never appear in the narration" ───────────────────

test("rows outside [since, until] never appear in the narration", () => {
  const inWindow: ReplayLedgerLine = { ts: "2026-08-25T10:50:00.000Z", run_id: "RUN-IN", task_id: "W1-T1", step: "run.start" };
  const before: ReplayLedgerLine = { ts: "2026-08-25T10:39:59.999Z", run_id: "RUN-BEFORE", task_id: "W1-T1", step: "run.start" };
  const after: ReplayLedgerLine = { ts: "2026-08-25T11:20:00.001Z", run_id: "RUN-AFTER", task_id: "W1-T1", step: "run.start" };
  const noTs: ReplayLedgerLine = { run_id: "RUN-NO-TS", task_id: "W1-T1", step: "run.start" };

  const narration = buildReplay([before, inWindow, after, noTs], { since: SINCE, until: UNTIL });
  assert.match(narration, /RUN-IN/);
  assert.doesNotMatch(narration, /RUN-BEFORE/);
  assert.doesNotMatch(narration, /RUN-AFTER/);
  assert.doesNotMatch(narration, /RUN-NO-TS/);
  assert.match(narration, /1 ledger row\(s\)/);

  // The window bounds are INCLUSIVE on both ends.
  const atBounds = buildReplay(
    [
      { ts: SINCE, run_id: "RUN-SINCE", task_id: "W1-T1", step: "run.start" },
      { ts: UNTIL, run_id: "RUN-UNTIL", task_id: "W1-T1", step: "run.start" },
    ],
    { since: SINCE, until: UNTIL },
  );
  assert.match(atBounds, /RUN-SINCE/);
  assert.match(atBounds, /RUN-UNTIL/);
});

test("optional narrowing by task id and by step-family prefix", () => {
  const lines: ReplayLedgerLine[] = [
    { ts: "2026-08-25T10:45:00.000Z", run_id: "RUN-A", task_id: "W1-T2244", step: "automerge.armed" },
    { ts: "2026-08-25T10:46:00.000Z", run_id: "RUN-A", task_id: "W1-T2245", step: "automerge.arm_skipped" },
    { ts: "2026-08-25T10:47:00.000Z", run_id: "RUN-A", task_id: "W1-T2244", step: "review.posted" },
  ];
  const byTask = buildReplay(lines, { since: SINCE, until: UNTIL, taskId: "W1-T2244" });
  assert.match(byTask, /2 ledger row\(s\) for task W1-T2244/);
  assert.match(byTask, /automerge\.armed/);
  assert.match(byTask, /review\.posted/);
  assert.doesNotMatch(byTask, /arm_skipped/);

  const byStep = buildReplay(lines, { since: SINCE, until: UNTIL, stepPrefix: "automerge." });
  assert.match(byStep, /matching step prefix "automerge\."/);
  assert.match(byStep, /automerge\.armed/);
  assert.match(byStep, /automerge\.arm_skipped/);
  assert.doesNotMatch(byStep, /review\.posted/);
});

test("an empty window narrates zero rows, never an invented account", () => {
  const narration = buildReplay([], { since: SINCE, until: UNTIL });
  assert.equal(narration, `rmd replay ${SINCE}..${UNTIL}: 0 ledger row(s)`);
});

// ── claim: "a partial ledger corpus is refused rather than narrated" ───────────────────────────

function fakeFsDeps(files: Record<string, string>, names: string[]): LedgerGrepFsDeps {
  return {
    readdirSync: () => names,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!(p in files)) throw new Error(`ENOENT (fake fs): ${p}`);
      return Buffer.from(files[p], "utf8");
    },
    gunzipSync: (buf) => buf,
  };
}

test("resolveReplayLedgerLines reads the archive union, recovering rows a rotation-emptied live file alone would miss", () => {
  const stateDir = "/fake/state-replay-union";
  const archivePath = join(stateDir, "ledger.2026-08-25T00-00-00-000Z.ndjson");
  const livePath = join(stateDir, "ledger.ndjson");
  const archiveRow = { ts: "2026-08-25T10:41:03.000Z", run_id: "RUN-A", task_id: "W1-T2245", step: "automerge.armed", outcome: "armed" };
  const files = {
    [archivePath]: JSON.stringify(archiveRow) + "\n",
    [livePath]: JSON.stringify({ ts: "2026-08-25T12:00:00.000Z", run_id: "OTHER", task_id: "W1-T1", step: "run.start" }) + "\n",
  };
  const fsDeps = fakeFsDeps(files, ["ledger.2026-08-25T00-00-00-000Z.ndjson", "ledger.ndjson"]);

  const resolved = resolveReplayLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.ok(resolved.lines.some((l) => l.run_id === "RUN-A"), "the archived row must survive the union");

  const narration = buildReplay(resolved.lines, { since: SINCE, until: UNTIL });
  assert.match(narration, /RUN-A/);
});

test("a zero-archive union refuses rather than resolving as zero rows found", () => {
  const stateDir = "/fake/state-replay-no-archives";
  const livePath = join(stateDir, "ledger.ndjson");
  const files = { [livePath]: JSON.stringify({ ts: SINCE, run_id: "RUN-A", task_id: "W1-T1", step: "run.start" }) + "\n" };
  const fsDeps = fakeFsDeps(files, ["ledger.ndjson"]); // zero archives on disk

  const resolved = resolveReplayLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /zero ledger archive files matched/);
  // A refusal is a DISTINCT shape from "resolved with zero lines" — `lines` does not exist on
  // this branch, so a caller cannot mistake "refused" for "this window was genuinely empty".
  assert.equal("lines" in resolved, false);
});

test("a partially-unreadable rotation refuses the union rather than narrating a truncated window", () => {
  const stateDir = "/fake/state-replay-partial";
  const goodArchive = join(stateDir, "ledger.2026-08-24T00-00-00-000Z.ndjson");
  const badArchive = join(stateDir, "ledger.2026-08-25T00-00-00-000Z.ndjson.gz");
  const files = { [goodArchive]: JSON.stringify({ ts: SINCE, run_id: "RUN-A", task_id: "W1-T1", step: "run.start" }) + "\n" };
  // badArchive is listed by readdirSync but absent from `files` — readFileSync throws for it,
  // modeling a corrupt/unreadable rotation that WAS found on disk.
  const fsDeps = fakeFsDeps(files, [
    "ledger.2026-08-24T00-00-00-000Z.ndjson",
    "ledger.2026-08-25T00-00-00-000Z.ndjson.gz",
  ]);

  const resolved = resolveReplayLedgerLines(stateDir, fsDeps);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /could not be read/);
  assert.equal("lines" in resolved, false);
});

// ── claim: "the verb wiring calls the pure generator rather than shipping it unreached" ────────
// (proven by grep: `buildReplay(` in src/run-task.ts — see replayCommand below; this test proves
// the CLI-facing behavior that grep alone cannot show: the verb actually narrates, and actually
// refuses on a bad union, exactly like buildReplay/resolveReplayLedgerLines do standalone.)

test("replayCommand prints buildReplay's narration for a resolved window", async () => {
  const { replayCommand } = await import("../src/run-task.js");
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (msg?: unknown) => {
    logs.push(String(msg));
  };
  try {
    const code = replayCommand(SINCE, UNTIL, [], {
      stateDir: "/fake/unused",
      resolveReplayLedgerLines: () => ({
        ok: true,
        lines: [{ ts: "2026-08-25T10:41:03.000Z", run_id: "RUN-A", task_id: "W1-T2245", step: "automerge.armed", outcome: "armed" }],
      }),
    });
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("automerge.armed")));
  } finally {
    console.log = realLog;
  }
});

test("replayCommand exits non-zero and prints no narration when the ledger union is refused", async () => {
  const { replayCommand } = await import("../src/run-task.js");
  const errors: string[] = [];
  const logs: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  console.log = (msg?: unknown) => {
    logs.push(String(msg));
  };
  try {
    const code = replayCommand(SINCE, UNTIL, [], {
      stateDir: "/fake/unused",
      resolveReplayLedgerLines: () => ({ ok: false, reason: "zero ledger archive files matched under /fake/unused" }),
    });
    assert.equal(code, 1);
    assert.equal(logs.length, 0, "a refused union must never print a partial narration");
    assert.ok(errors.some((e) => e.includes("zero ledger archive files matched")));
  } finally {
    console.error = realError;
    console.log = realLog;
  }
});

test("replayCommand rejects an unknown flag before touching the ledger — fail loud", async () => {
  const { replayCommand } = await import("../src/run-task.js");
  const errors: string[] = [];
  const realError = console.error;
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  try {
    let calls = 0;
    const code = replayCommand(SINCE, UNTIL, ["--bogus"], {
      stateDir: "/fake/unused",
      resolveReplayLedgerLines: () => {
        calls++;
        return { ok: true, lines: [] };
      },
    });
    assert.equal(code, 2);
    assert.equal(calls, 0, "an unknown flag must refuse before any ledger read");
    assert.ok(errors.some((e) => e.includes("unexpected argument")));
  } finally {
    console.error = realError;
  }
});
