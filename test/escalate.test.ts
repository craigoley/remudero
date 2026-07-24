import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  NEEDS_HUMAN_LABEL,
  escalate,
  tryEscalate,
  renderIssueBody,
  type Escalation,
  type IssueGateway,
} from "../src/lib/escalate.js";

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-escalate-")), "ledger.ndjson");
}

function fakeIssues(url = "https://github.com/craigoley/remudero/issues/99"): IssueGateway & {
  calls: Array<{ title: string; body: string; labels: string[] }>;
} {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  return {
    calls,
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TX",
    summary: "two strikes exhausted",
    detail: "the diagnose-armed retry still failed CI.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

test("escalate opens a needs-human labeled issue and logs the ledger line", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });

  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.equal(issues.calls.length, 1);
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked"]);
  assert.match(issues.calls[0].title, /^\[BLOCKED\] W1-TX: two strikes exhausted$/);

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].step, "escalation.issue_opened");
  assert.equal(lines[0].task_id, "W1-TX");
  assert.equal(lines[0].class, "BLOCKED");
  assert.equal(lines[0].issue_url, url);
});

test("each escalation class maps to its own label alongside needs-human", () => {
  const issues = fakeIssues();
  escalate(escalation({ class: "MANUAL" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  escalate(escalation({ class: "HARD_STOP" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  escalate(escalation({ class: "GRILL" }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-manual"]);
  assert.deepEqual(issues.calls[1].labels, [NEEDS_HUMAN_LABEL, "escalation-hard-stop"]);
  assert.deepEqual(issues.calls[2].labels, [NEEDS_HUMAN_LABEL, "escalation-grill"]);
});

test("GRILL (the intake triage's async grill, W1-T42) opens a needs-human issue exactly like every other class — no second mechanism", () => {
  const issues = fakeIssues();
  const url = escalate(
    escalation({
      class: "GRILL",
      taskId: "TRIAGE-fb-1",
      summary: "feedback#fb-1 needs a human call: cli flag or config default?",
      options: [
        { label: "cli-flag", detail: "add a --foo flag" },
        { label: "config-default", detail: "add a config default instead" },
      ],
      recommendation: "cli-flag",
    }),
    { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
  );
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.match(issues.calls[0].title, /^\[GRILL\] TRIAGE-fb-1: /);
  assert.match(issues.calls[0].body, /\*\*cli-flag\*\* — add a --foo flag/);
  assert.match(issues.calls[0].body, /## Recommendation\ncli-flag/);
});

test("an escalation with no options is refused — a bare alert is not actionable", () => {
  const issues = fakeIssues();
  assert.throws(() => escalate(escalation({ options: [] }), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" }));
  assert.equal(issues.calls.length, 0);
});

test("renderIssueBody lists every option AND calls out the recommendation", () => {
  const body = renderIssueBody(escalation());
  assert.match(body, /## Options/);
  assert.match(body, /\*\*retry\*\* — resume the run with a fresh worker/);
  assert.match(body, /\*\*abandon\*\* — drop the task and re-plan/);
  assert.match(body, /## Recommendation\nretry/);
});

// ── PAYLOAD (not plumbing): the issue body the gateway RECEIVES from escalate()
// actually carries the OPTIONS + the RECOMMENDATION, for BOTH a BLOCKED and a MANUAL
// escalation, with the needs-human queue label. Criterion 1: "…open labeled issues
// WITH OPTIONS + a recommendation" — the fake records what escalate() truly sends. ──
test("escalate() sends the gateway a body CONTAINING every option + the recommendation (BLOCKED and MANUAL), labelled needs-human", () => {
  for (const cls of ["BLOCKED", "MANUAL"] as const) {
    const issues = fakeIssues();
    escalate(
      escalation({
        class: cls,
        options: [
          { label: "resume", detail: "re-run with a fresh worker" },
          { label: "abandon", detail: "drop the task and re-plan" },
        ],
        recommendation: "resume",
      }),
      { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
    );
    const call = issues.calls[0];
    // the BODY handed to gh (not just the title/labels) carries the actionable payload:
    assert.match(call.body, /\*\*resume\*\* — re-run with a fresh worker/, `${cls}: option 'resume' in body`);
    assert.match(call.body, /\*\*abandon\*\* — drop the task and re-plan/, `${cls}: option 'abandon' in body`);
    assert.match(call.body, /## Recommendation\nresume/, `${cls}: recommendation in body`);
    // the queue label the §4 control panel reads is always present:
    assert.ok(call.labels.includes(NEEDS_HUMAN_LABEL), `${cls}: labels ${call.labels} include ${NEEDS_HUMAN_LABEL}`);
  }
});

// ── tryEscalate: the daemon-survivability contract (R-1) ────────────────────
// `gh issue create` throws on any nonzero exit. Inside `rmd daemon`'s for(;;)
// that throw was uncontained: it ended the PROCESS, launchd's
// KeepAlive{SuccessfulExit:false} read the nonzero exit as a crash, relaunched,
// re-selected the same task, and threw again — one boot per minute, observed
// 2026-07-21 04:02-04:13 (460 daemon.boot lines since Jul 19). These tests pin
// the contract that makes that loop unreachable.

test("tryEscalate: a THROWING gh gateway yields null instead of propagating (the daemon survives)", () => {
  const path = ledgerPath();
  const boom: IssueGateway = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  // FALSIFIER: the pre-fix shape is plain `escalate()`, which DOES propagate —
  // asserted here so the test fails if tryEscalate ever degrades to a re-export.
  assert.throws(() => escalate(escalation(), { issues: boom, ledgerPath: path, runId: "RUN-1" }));

  const url = tryEscalate(escalation(), { issues: boom, ledgerPath: path, runId: "RUN-1" });
  assert.equal(url, null, "an undeliverable escalation returns null rather than throwing");
});

test("tryEscalate: a failed delivery is RECORDED on escalation.failed, never silent", () => {
  const path = ledgerPath();
  const boom: IssueGateway = {
    create() {
      throw new Error("gh: HTTP 403 rate limit exceeded");
    },
  };
  tryEscalate(escalation({ taskId: "W1-TZ" }), { issues: boom, ledgerPath: path, runId: "RUN-9" });

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const failed = lines.filter((l) => l.step === "escalation.failed");
  assert.equal(failed.length, 1, "exactly one escalation.failed line");
  assert.equal(failed[0].task_id, "W1-TZ");
  assert.equal(failed[0].class, "BLOCKED");
  assert.match(failed[0].error, /rate limit/, "the transport error is carried, not swallowed");
  assert.equal(
    lines.filter((l) => l.step === "escalation.issue_opened").length,
    0,
    "a FAILED delivery must never claim issue_opened — that is the claimed-vs-evidenced rule",
  );
});

test("tryEscalate: a SUCCESSFUL delivery is byte-identical to escalate() (no behaviour change on the happy path)", () => {
  const issues = fakeIssues();
  const path = ledgerPath();
  const url = tryEscalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.step === "escalation.issue_opened").length, 1);
  assert.equal(lines.filter((l) => l.step === "escalation.failed").length, 0);
});

// ── ENSURE-LABELS + DEGRADE DON'T LOSE (W1-T99) ─────────────────────────────
// LIVE INCIDENT, 2026-07-17: the first BLOCKED-class escalation ever fired called
// `gh issue create --label escalation-blocked`, and the label had never been
// provisioned on the repo — `gh` failed the create OUTRIGHT, losing the rendered
// question and propagating a throw that killed the whole sweep reconciler.

function fakeIssuesWithLabels(
  ensure: (label: string) => boolean,
  url = "https://github.com/craigoley/remudero/issues/99",
): IssueGateway & { calls: Array<{ title: string; body: string; labels: string[] }>; ensured: string[] } {
  const calls: Array<{ title: string; body: string; labels: string[] }> = [];
  const ensured: string[] = [];
  return {
    calls,
    ensured,
    ensureLabel(label) {
      ensured.push(label);
      return ensure(label);
    },
    create(title, body, labels) {
      calls.push({ title, body, labels });
      return url;
    },
  };
}

test("escalate: ensureLabel is called for every wanted label BEFORE create", () => {
  const issues = fakeIssuesWithLabels(() => true);
  escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.deepEqual(issues.ensured, [NEEDS_HUMAN_LABEL, "escalation-blocked"]);
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked"], "both labels provisioned -> both attached");
});

test("escalate: a gateway with no ensureLabel behaves exactly as before (back-compat)", () => {
  const issues = fakeIssues();
  const url = escalate(escalation(), { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL, "escalation-blocked"]);
});

test("escalate: the canonical 2026-07-17 shape — a label whose provisioning HARD-FAILS degrades, it never loses the escalation", () => {
  const path = ledgerPath();
  const issues = fakeIssuesWithLabels((label) => label !== "escalation-blocked"); // simulate the missing/unprovisionable label
  const url = escalate(escalation(), { issues, ledgerPath: path, runId: "RUN-1" });

  // No throw escaped — the escalation still delivered:
  assert.equal(url, "https://github.com/craigoley/remudero/issues/99");
  assert.equal(issues.calls.length, 1);
  // The degraded label is DROPPED from the attached set, not silently kept:
  assert.deepEqual(issues.calls[0].labels, [NEEDS_HUMAN_LABEL], "the unprovisionable label is left off create()");
  // The drop is noted in the body the human actually reads — the payload survives:
  assert.match(issues.calls[0].body, /Degraded.*escalation-blocked/s);
  // ...and on the ledger line, so it's legible without opening GitHub:
  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const opened = lines.find((l) => l.step === "escalation.issue_opened");
  assert.deepEqual(opened.degraded_labels, ["escalation-blocked"]);
});
