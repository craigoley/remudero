/**
 * W1-T3318 — REPAIR, ROUTE, OR CLOSE: BLOCKED IS NOT A RESTING STATE.
 *
 * This is a decision-record task, so the production artifact is the attributable ruling in
 * DECISIONS.md. The test pins the distinctions that later gate conversions are allowed to cite;
 * it does not pretend that recording the ruling changes a gate by itself.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const decisions = readFileSync(new URL("../DECISIONS.md", import.meta.url), "utf8");
const sectionStart = decisions.indexOf("## 2026-09-10 — OPERATOR RULING (W1-T3318)");
const sectionEnd = decisions.indexOf("\n## ", sectionStart + 1);
const ruling = sectionStart < 0 ? "" : decisions.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);

test("W1-T3318: the record attributes and quotes the operator's direction", () => {
  assert.notEqual(sectionStart, -1, "DECISIONS.md must contain the W1-T3318 ruling");
  assert.match(ruling, /Operator-ruled, recorded at the operator's instruction/);
  assert.match(ruling, /the goal should never be to block prs/);
  assert.match(ruling, /The goal should be to fix them and get them\s+through the system or spin off follow-up tasks/i);
  assert.match(ruling, /the only\s+time to block is if it is truly a bad change, a malicious change, or something that is going to\s+really negatively regress rmd in a meaningful way/);
  assert.match(ruling, /in which case it should be closed\s+anyway/);
});

test("W1-T3318: REPAIR, ROUTE, and CLOSE are terminal, and blocked is not a resting state", () => {
  assert.match(ruling, /REPAIR, ROUTE, CLOSE/);
  assert.match(ruling, /REPAIR[\s\S]*remedy is computable[\s\S]*change lands/);
  assert.match(ruling, /ROUTE[\s\S]*change lands[\s\S]*follow-up is filed/);
  assert.match(ruling, /CLOSE[\s\S]*bad, malicious, or a meaningful regression[\s\S]*close the PR/i);
  assert.match(ruling, /blocked is not a resting state/i);
  assert.match(ruling, /There is no fourth outcome/i);
});

test("W1-T3318: incompleteness is not harm, and the record carries the measured cost", () => {
  assert.match(ruling, /INCOMPLETENESS IS NOT HARM/);
  assert.match(ruling, /four daemon crashes\s+against zero defects/i);
  assert.match(ruling, /two blocked operator pushes/i);
});

test("W1-T3318: a repairing gate must be idempotent and byte-identical when healthy", () => {
  assert.match(ruling, /writes to the tree it checks/);
  assert.match(ruling, /idempotent and byte-identical when healthy/);
  assert.match(ruling, /Rollback:/);
});
