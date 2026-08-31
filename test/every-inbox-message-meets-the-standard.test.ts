import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  checkOperatorMessage,
  operatorMessageFooter,
  OPERATOR_MESSAGE_PARTS,
  type OperatorMessage,
} from "../src/lib/operator-message.js";
import { escalate, toOperatorMessage, type Escalation, type IssueGateway } from "../src/lib/escalate.js";

// W1-T2498: docs/operator-message-standard.md (W1-T2279) is ratified and its own suite asserts
// over the DOCUMENT, but nothing in src/ ever checked a message anything actually produced
// (SURFACE 2/3: consumers = 0, suites over a real message = 0). This suite proves
// operator-message.ts's four-part presence check, and escalate.ts's wiring into it, satisfy
// every acceptance claim on W1-T2498's own task record.

const __dirname = dirname(fileURLToPath(import.meta.url));
const escalateSrc = readFileSync(join(__dirname, "..", "src", "lib", "escalate.ts"), "utf8");
const containmentSrc = readFileSync(join(__dirname, "..", "src", "lib", "containment.ts"), "utf8");

// The exact turns-exhausted verdict string docs/operator-message-standard.md itself quotes
// verbatim (and its own suite proves still exists in containment.ts). Reused here, byte-for-byte,
// as a stand-in for "a message the standard's own suite quotes" — proving THIS task's checker
// never reworded it either.
const CONTAINMENT_VERDICT =
  "turns-exhausted — the probe ran out of its turn budget before an OS-denial for the outside-cwd " +
  "write could be observed; this is NOT the same fact as an unattempted write and containment stays UNPROVEN";

test("containment.ts's turns-exhausted verdict this suite reuses verbatim still exists in the real source", () => {
  assert.match(
    containmentSrc,
    /this is NOT the same fact as an unattempted write and containment stays UNPROVEN/,
    "if this ever fails, CONTAINMENT_VERDICT above has drifted from the real exhibit and must be re-copied, not reworded",
  );
});

function fullMessage(over: Partial<OperatorMessage> = {}): OperatorMessage {
  return {
    speaker: "BLOCKED",
    whatHappened: "the diagnose-armed retry still failed CI",
    whatIsAsked: "retry once more, or abandon and re-plan",
    consequenceOfInaction: "the PR sits blocked and CI keeps burning the retry budget",
    ...over,
  };
}

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-operator-message-")), "ledger.ndjson");
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
    taskId: "W1-T9101",
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

function readLedgerLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── CLAIM 1: a message carrying all four parts passes the checker ──────────────────────────────

test("a message carrying all four parts passes the checker", () => {
  const result = checkOperatorMessage(fullMessage());
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("an explicit null slot (deliberately nothing to say) counts as present, same as the doc's action-slot rule", () => {
  // docs/operator-message-standard.md, part iii: "the message SAYS there is nothing rather than
  // omitting the part" — `null` is that explicit declaration, and must pass exactly like a
  // populated string.
  const result = checkOperatorMessage(fullMessage({ whatIsAsked: null, consequenceOfInaction: null }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

// ── CLAIM 2: a message missing any one part is reported non-conforming and names which ─────────

for (const part of OPERATOR_MESSAGE_PARTS) {
  test(`a message missing only "${part}" is reported non-conforming and names exactly that part`, () => {
    const result = checkOperatorMessage(fullMessage({ [part]: undefined }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [part]);
  });
}

test("a message missing every part is reported non-conforming and names all four", () => {
  const result = checkOperatorMessage({});
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [...OPERATOR_MESSAGE_PARTS]);
});

test("a whitespace-only slot is treated as missing, not filled", () => {
  const result = checkOperatorMessage(fullMessage({ whatHappened: "   " }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["whatHappened"]);
});

// ── CLAIM 3: a non-conforming message still reaches the operator rather than being dropped ─────

test("a non-conforming message still reaches the operator rather than being dropped", () => {
  const issues = fakeIssues();
  const url = escalate(escalation({ taskId: "W1-T9102", consequence: undefined }), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-1",
  });
  assert.ok(url);
  assert.equal(issues.calls.length, 1);
  assert.match(issues.calls[0].body, /Non-conforming operator message.*missing consequenceOfInaction/s);
});

// ── CLAIM 4: the checker scores no prose quality, tone or length ───────────────────────────────

test("a terse, unlovely message that fills all four slots still passes — no quality scoring", () => {
  const result = checkOperatorMessage({ speaker: "x", whatHappened: "y", whatIsAsked: "z", consequenceOfInaction: "w" });
  assert.equal(result.ok, true);
});

test("a long, well-written message missing one slot still fails — quality never substitutes for presence", () => {
  const result = checkOperatorMessage(
    fullMessage({
      whatHappened:
        "the diagnose-armed retry ran for eleven minutes, exhausted both of its allotted strikes against " +
        "the same failing CI check, and left the PR in a state no further automatic action can resolve",
      consequenceOfInaction: undefined,
    }),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["consequenceOfInaction"]);
});

// ── CLAIM 5: an escalation whose message already conforms is passed through unchanged ──────────

test("an escalation whose message already conforms is passed through unchanged", () => {
  const issues = fakeIssues();
  const detail = "the diagnose-armed retry still failed CI, twice, on the same check.";
  escalate(
    escalation({
      taskId: "W1-T9103",
      detail,
      recommendation: "retry",
      consequence: "the PR stays blocked and the next dispatch tick will just hit the same wall",
    }),
    { issues, ledgerPath: ledgerPath(), runId: "RUN-1" },
  );
  assert.equal(issues.calls.length, 1);
  const body = issues.calls[0].body;
  assert.match(body, new RegExp(detail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(body, /Non-conforming operator message/);
});

// ── CLAIM 6: no message quoted verbatim by the standard's own suite is reworded ─────────────────

test("a message reusing the standard's own suite's verbatim exhibit is never reworded, conforming or not", () => {
  const issues = fakeIssues();
  escalate(escalation({ taskId: "W1-T9104", detail: CONTAINMENT_VERDICT, consequence: undefined }), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-1",
  });
  const body = issues.calls[0].body;
  // The exhibit string appears exactly once, byte-for-byte — never split, never paraphrased, and
  // the non-conforming footer (this exhibit has no consequence slot) is purely ADDITIVE, after it.
  assert.equal(body.split(CONTAINMENT_VERDICT).length - 1, 1);
  assert.match(body, /Non-conforming operator message/);
});

// ── CLAIM 7: a checker failure never prevents the escalation being raised ──────────────────────

test("a checker failure (an escalation field only the checker reads throws when read) never prevents the escalation being raised", () => {
  const issues = fakeIssues();
  const e = escalation({ taskId: "W1-T9105" });
  // `consequence` is read ONLY by `toOperatorMessage` (renderIssueBody never touches it) — a
  // getter that throws on access isolates a checker-only failure from a failure in the escalation
  // body itself, so this proves the CHECKER's own best-effort wrapper degrades silently rather
  // than propagating, not merely that some unrelated field was broken.
  Object.defineProperty(e, "consequence", {
    get() {
      throw new Error("boom: consequence is unreadable");
    },
    enumerable: true,
  });
  const url = escalate(e, { issues, ledgerPath: ledgerPath(), runId: "RUN-1" });
  assert.ok(url);
  assert.equal(issues.calls.length, 1);
});

// ── CLAIM 8: making the checker drop a non-conforming message fails the delivery assertion ─────

test("falsifier: gating delivery on checkOperatorMessage's verdict, instead of merely annotating it, would fail the 'still reaches the operator' assertion", () => {
  const check = checkOperatorMessage(fullMessage({ consequenceOfInaction: undefined }));
  assert.equal(check.ok, false);

  // Control case: a naive alternative that GATES delivery on conformance — exactly the hazard the
  // task rationale names ("a comprehension gate that can swallow one has traded a badly-worded
  // warning for no warning, which is strictly worse").
  const gatedDelivery = (ok: boolean): string | null => (ok ? "issue-url" : null);
  assert.equal(gatedDelivery(check.ok), null); // proves: this alternative fails "reaches the operator"

  // ...whereas the REAL escalate() never gates on it — same non-conforming input, real delivery:
  const issues = fakeIssues();
  const url = escalate(escalation({ taskId: "W1-T9106", consequence: undefined }), {
    issues,
    ledgerPath: ledgerPath(),
    runId: "RUN-1",
  });
  assert.notEqual(url, null);
  assert.equal(issues.calls.length, 1);
});

// ── CLAIM 9: the escalation path calls the checker rather than the checker standing alone ──────

test("escalate.ts's source calls checkOperatorMessage( rather than leaving it standing alone", () => {
  assert.match(escalateSrc, /checkOperatorMessage\(/);
});

test("the escalation path calls the checker, observably: the ledger records operator_message_ok", () => {
  const path = ledgerPath();
  const issues = fakeIssues();
  escalate(escalation({ taskId: "W1-T9107", consequence: "the block persists until a human intervenes" }), {
    issues,
    ledgerPath: path,
    runId: "RUN-1",
  });
  const lines = readLedgerLines(path);
  const opened = lines.find((l) => l.step === "escalation.issue_opened");
  assert.equal(opened?.operator_message_ok, true);

  const path2 = ledgerPath();
  const issues2 = fakeIssues();
  escalate(escalation({ taskId: "W1-T9108", consequence: undefined }), {
    issues: issues2,
    ledgerPath: path2,
    runId: "RUN-2",
  });
  const lines2 = readLedgerLines(path2);
  const opened2 = lines2.find((l) => l.step === "escalation.issue_opened");
  assert.equal(opened2?.operator_message_ok, false);
  assert.deepEqual(opened2?.operator_message_missing, ["consequenceOfInaction"]);
});

// ── Supporting: toOperatorMessage projects an Escalation onto the four slots honestly ───────────

test("toOperatorMessage projects class/detail/recommendation/consequence onto the four slots", () => {
  const e = escalation({
    class: "MANUAL",
    detail: "a secret needs rotating",
    recommendation: "rotate it",
    consequence: "the credential stays exposed",
  });
  assert.deepEqual(toOperatorMessage(e), {
    speaker: "MANUAL",
    whatHappened: "a secret needs rotating",
    whatIsAsked: "rotate it",
    consequenceOfInaction: "the credential stays exposed",
  });
});

test("operatorMessageFooter renders nothing for a conforming result and a named list for a non-conforming one", () => {
  assert.equal(operatorMessageFooter({ ok: true, missing: [] }), undefined);
  const footer = operatorMessageFooter({ ok: false, missing: ["whatIsAsked", "consequenceOfInaction"] });
  assert.match(footer ?? "", /missing whatIsAsked, consequenceOfInaction/);
  assert.match(footer ?? "", /delivered anyway, never dropped or held/);
});
