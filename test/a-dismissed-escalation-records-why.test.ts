import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { appendLedger } from "../src/lib/ledger.js";
import type { IssueCloser, PanelActionDeps } from "../src/lib/panel-actions.js";
import { fakeGitHub } from "./helpers/fake-github.js";
import {
  ESCALATION_DISPOSITIONS,
  MIN_SAMPLE_FOR_DEMOTION,
  NEVER_DEMOTE_CLASSES,
  escalationClassPrecision,
  escalationClassSignal,
  escalationClassSignals,
  escalationClassTier,
} from "../src/lib/escalation-precision.js";

// ── W1-T4677: DISMISSING AN ESCALATION RECORDS NOTHING ──────────────────────────────────────────
//
// OBSERVED 2026-09-26..28: 64 false "main is red" escalations fired on #7296 and #7561 alone
// produced five needs-human issues for one PR — every one dismissed by closing the GitHub issue,
// which `panel.escalation_marked_handled` recorded as nothing but `issue_url` (src/lib/panel-
// actions.ts). With no disposition, nothing could ever learn a class was mostly noise.
//
// design (i): mark-handled now REQUIRES a disposition.
// design (ii): escalation-precision.ts computes acted-on precision per class over the ledger.
// design (iii): a class whose precision is low demotes to a board signal (issue -> digest ->
//   board); MANUAL and HARD_STOP never demote.

const READ_TOKEN = "w1-t4677-read-token";
const WRITE_TOKEN = "w1-t4677-write-token";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "rmd-dismissed-escalation-"));
}

function ledgerPathFor(root: string): string {
  return join(root, "state", "ledger.ndjson");
}

function readLedgerLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function fakeIssueCloser(): IssueCloser & { closed: string[] } {
  const closed: string[] = [];
  return {
    closed,
    close(issueUrl: string) {
      closed.push(issueUrl);
    },
  };
}

function depsFor(root: string, issues: IssueCloser = fakeIssueCloser()): PanelActionDeps {
  return { root, ledgerPath: ledgerPathFor(root), issues };
}

/** Same minimal production-shaped assembly test/panel-actions.test.ts uses — real
 *  `buildServeServer`, never a hand-listed route table, so this suite is not blind to
 *  `serve.ts`'s own registration. */
function serveDepsFor(deps: PanelActionDeps): ServeDeps {
  mkdirSync(join(deps.root, "plan"), { recursive: true });
  const planPath = join(deps.root, "plan", "tasks.yaml");
  if (!existsSync(planPath)) writeFileSync(planPath, "[]\n");
  return {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath: deps.ledgerPath, github: fakeGitHub() },
    panelGraph: {
      root: deps.root,
      planPath,
      ledgerPath: deps.ledgerPath,
      github: { prView: () => null },
      statusGithub: fakeGitHub(),
      ratify: { approve: () => {}, reframe: () => {} },
    },
    ledgerPath: deps.ledgerPath,
    issues: deps.issues,
    fleetControlRoot: deps.root,
    questionsRoot: deps.root,
    tokens: { read: READ_TOKEN, write: WRITE_TOKEN },
    pollMs: 50,
    log: () => {},
  };
}

async function withService<T>(deps: PanelActionDeps, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = buildServeServer(serveDepsFor(deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${WRITE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Seed `count` disposed `panel.escalation_marked_handled` rows for `escalationClass`, `acted`
 *  of them (in [0, count]), the rest `false_positive` — the shape a class's real disposed history
 *  takes across many escalations. */
function seedDisposedHistory(ledgerPath: string, escalationClass: string, count: number, acted: number): void {
  for (let i = 0; i < count; i += 1) {
    appendLedger(ledgerPath, {
      run_id: `SEED-${i}`,
      task_id: `W1-T${9000 + i}`,
      step: "panel.escalation_marked_handled",
      class: escalationClass,
      disposition: i < acted ? "acted" : "false_positive",
      issue_url: `https://github.com/craigoley/remudero/issues/${9000 + i}`,
    });
  }
}

// ── (1) mark-handled records the disposition ────────────────────────────────────────────────────

test("W1-T4677: mark-handled records the disposition", async () => {
  const root = tmpRoot();
  const issues = fakeIssueCloser();
  const deps = depsFor(root, issues);
  const issueUrl = "https://github.com/craigoley/remudero/issues/7561";

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", {
      taskId: "W1-T7561",
      issueUrl,
      class: "BLOCKED",
      disposition: "false_positive",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; disposition: string; class: string };
    assert.equal(body.disposition, "false_positive");
    assert.equal(body.class, "BLOCKED");
  });

  assert.deepEqual(issues.closed, [issueUrl]);
  const lines = readLedgerLines(deps.ledgerPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "panel.escalation_marked_handled");
  assert.equal(lines[0].class, "BLOCKED");
  assert.equal(lines[0].disposition, "false_positive");
  // The bug this task closes: BEFORE this change the ledger line carried only `issue_url` — no
  // reader could ever learn a dismissal was noise versus a real fix. `disposition` now rides
  // beside it on the SAME line, not a second write that could land without the first.
  assert.equal(lines[0].issue_url, issueUrl);
});

test("W1-T4677: mark-handled records EVERY disposition in the closed set, verbatim", async () => {
  for (const disposition of ESCALATION_DISPOSITIONS) {
    const root = tmpRoot();
    const deps = depsFor(root);
    const body: Record<string, unknown> = {
      taskId: "W1-T1",
      issueUrl: "https://github.com/craigoley/remudero/issues/1",
      class: "BLOCKED",
      disposition,
    };
    if (disposition === "snoozed_until") body.snoozedUntil = "2026-10-05T00:00:00.000Z";

    await withService(deps, async (base) => {
      const res = await post(base, "/v1/escalation/mark-handled", body);
      assert.equal(res.status, 200, `disposition ${disposition} must be accepted`);
    });
    const lines = readLedgerLines(deps.ledgerPath);
    assert.equal(lines[0].disposition, disposition);
    if (disposition === "snoozed_until") assert.equal(lines[0].snoozed_until, "2026-10-05T00:00:00.000Z");
  }
});

test("W1-T4677: mark-handled with NO disposition is refused (400) -- the issue is never closed", async () => {
  const root = tmpRoot();
  const issues = fakeIssueCloser();
  const deps = depsFor(root, issues);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", {
      taskId: "W1-T2",
      issueUrl: "https://github.com/craigoley/remudero/issues/2",
      class: "BLOCKED",
      // disposition omitted -- this is the exact shape the pre-W1-T4677 route accepted.
    });
    assert.equal(res.status, 400);
  });
  assert.deepEqual(issues.closed, [], "a disposition-less dismiss must never reach the GitHub close");
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

test("W1-T4677: mark-handled with an unrecognised disposition is refused (400), the closed set is enforced", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", {
      taskId: "W1-T3",
      issueUrl: "https://github.com/craigoley/remudero/issues/3",
      class: "BLOCKED",
      disposition: "ignored", // not one of ESCALATION_DISPOSITIONS
    });
    assert.equal(res.status, 400);
  });
});

test("W1-T4677: mark-handled with disposition snoozed_until but no snoozedUntil is refused (400)", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", {
      taskId: "W1-T4",
      issueUrl: "https://github.com/craigoley/remudero/issues/4",
      class: "BLOCKED",
      disposition: "snoozed_until",
    });
    assert.equal(res.status, 400);
  });
});

test("W1-T4677: snoozedUntil cannot accompany an acted disposition", async () => {
  const root = tmpRoot();
  const issues = fakeIssueCloser();
  const deps = depsFor(root, issues);
  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", {
      taskId: "W1-T5",
      issueUrl: "https://github.com/craigoley/remudero/issues/5",
      class: "BLOCKED",
      disposition: "acted",
      snoozedUntil: "2026-10-05T00:00:00.000Z",
    });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /snoozedUntil is only valid/);
  });
  assert.deepEqual(issues.closed, [], "an invalid disposition pairing cannot close the issue");
  assert.equal(readLedgerLines(deps.ledgerPath).length, 0);
});

// ── (2) escalation-precision.ts's pure arithmetic ───────────────────────────────────────────────

test("W1-T4677: escalationClassPrecision counts acted-on rows over every disposed row for that class", () => {
  const lines = [
    { step: "panel.escalation_marked_handled", class: "BLOCKED", disposition: "acted" },
    { step: "panel.escalation_marked_handled", class: "BLOCKED", disposition: "false_positive" },
    { step: "panel.escalation_marked_handled", class: "BLOCKED", disposition: "duplicate" },
    { step: "panel.escalation_marked_handled", class: "BLOCKED", disposition: "acted" },
    // a different class: must not pollute BLOCKED's count.
    { step: "panel.escalation_marked_handled", class: "MANUAL", disposition: "false_positive" },
    // some other step entirely: must be ignored.
    { step: "panel.pause_requested", class: "BLOCKED", disposition: "acted" },
  ];
  const precision = escalationClassPrecision(lines, "BLOCKED");
  assert.equal(precision.sampleSize, 4);
  assert.equal(precision.actedCount, 2);
  assert.equal(precision.precision, 0.5);
});

test("W1-T4677: escalationClassPrecision reads null, not zero, when a class has no disposed history", () => {
  const precision = escalationClassPrecision([], "BLOCKED");
  assert.equal(precision.sampleSize, 0);
  assert.equal(precision.precision, null, "no evidence must never read as 'zero precision'");
});

test("W1-T4677: an issue closed by hand (no disposition on the ledger row) is 'unrecorded', not counted either way", () => {
  const lines = [
    { step: "panel.escalation_marked_handled", class: "BLOCKED", issue_url: "https://x/1" }, // no disposition
    { step: "panel.escalation_marked_handled", class: "BLOCKED", disposition: "acted" },
  ];
  const precision = escalationClassPrecision(lines, "BLOCKED");
  assert.equal(precision.sampleSize, 1, "the disposition-less row must not inflate the denominator");
  assert.equal(precision.actedCount, 1);
});

// ── (3) a class with low acted-on precision is demoted to a board signal ───────────────────────

test("W1-T4677: a class with low acted-on precision is demoted to a board signal", async () => {
  const root = tmpRoot();
  const deps = depsFor(root);
  // A #7296-shaped history: every prior dismissal of BLOCKED was noise.
  seedDisposedHistory(deps.ledgerPath, "BLOCKED", MIN_SAMPLE_FOR_DEMOTION, 0);

  await withService(deps, async (base) => {
    const res = await post(base, "/v1/escalation/mark-handled", {
      taskId: "W1-T7296",
      issueUrl: "https://github.com/craigoley/remudero/issues/7296",
      class: "BLOCKED",
      disposition: "false_positive",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tier: string; precision: number };
    assert.equal(body.tier, "board", "a fully-noise class over the minimum sample must demote to a board signal");
    assert.equal(body.precision, 0);
  });
});

test("W1-T4677: too little disposed history stays at 'issue' rather than demoting off a guess", () => {
  const precision = escalationClassPrecision(
    [{ step: "panel.escalation_marked_handled", class: "BLOCKED", disposition: "false_positive" }],
    "BLOCKED",
  );
  assert.ok(precision.sampleSize < MIN_SAMPLE_FOR_DEMOTION);
  assert.equal(escalationClassTier("BLOCKED", precision), "issue");
});

test("W1-T4677: a mid-precision class demotes to the digest tier, not straight to board", () => {
  const lines: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 10; i += 1) {
    lines.push({ step: "panel.escalation_marked_handled", class: "BLOCKED", disposition: i < 5 ? "acted" : "duplicate" });
  }
  const signal = escalationClassSignal(lines, "BLOCKED");
  assert.equal(signal.precision.precision, 0.5);
  assert.equal(signal.tier, "digest");
});

test("W1-T4677: MANUAL and HARD_STOP never demote, however low their acted-on precision", () => {
  for (const escalationClass of NEVER_DEMOTE_CLASSES) {
    const lines: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push({ step: "panel.escalation_marked_handled", class: escalationClass, disposition: "false_positive" });
    }
    const precision = escalationClassPrecision(lines, escalationClass);
    assert.equal(precision.precision, 0, `${escalationClass} fixture must genuinely be zero-precision`);
    assert.equal(escalationClassTier(escalationClass, precision), "issue", `${escalationClass} must never demote`);
  }
});

test("W1-T4677: escalationClassSignals walks every disposed class in the ledger, not a hardcoded list", () => {
  const lines: Array<Record<string, unknown>> = [
    ...Array.from({ length: MIN_SAMPLE_FOR_DEMOTION }, () => ({
      step: "panel.escalation_marked_handled",
      class: "BLOCKED",
      disposition: "false_positive",
    })),
    ...Array.from({ length: MIN_SAMPLE_FOR_DEMOTION }, () => ({
      step: "panel.escalation_marked_handled",
      class: "GRILL",
      disposition: "acted",
    })),
  ];
  const signals = escalationClassSignals(lines);
  assert.deepEqual(
    signals.map((s) => s.class),
    ["BLOCKED", "GRILL"],
  );
  assert.equal(signals.find((s) => s.class === "BLOCKED")!.tier, "board");
  assert.equal(signals.find((s) => s.class === "GRILL")!.tier, "issue");
});

// ── falsifier: this task's own claim ─────────────────────────────────────────────────────────────
// Remove the disposition requirement (or the precision/tier module) and the first test in this
// file fails: the response never carries `disposition`, and the ledger line never carries `class`
// or `disposition` either.
