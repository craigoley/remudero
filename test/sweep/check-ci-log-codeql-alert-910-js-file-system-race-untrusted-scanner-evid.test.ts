import assert from "node:assert/strict";
import { test } from "node:test";
import { withCodeqlAlertEvidence } from "#src/lib/sweep.js";

const alert = (ruleId: string) => ({ alertNumber: 910, ruleId, severity: "high", path: "src/x.ts", line: 3, message: "m" });
const run = (ruleId: string) => withCodeqlAlertEvidence(
  { headSha: "abc", codeqlHeadAlerts: { headSha: "abc", alerts: [alert(ruleId)] } } as never,
  [{ name: "CodeQL", logTail: "" }] as never,
)[0]!.logTail as string;

test("W1-T10394: check:ci-log:codeql-alert-910-js-file-system-race:untrusted-scanner-evidence-the-codeql-check-failed-at-this-p is prevented, not retried", () => {
  const tail = run("js/file-system-race");
  assert.match(tail, /UNTRUSTED SCANNER EVIDENCE/);
  assert.match(tail, /do not test a path and then use it/);
  assert.doesNotMatch(run("js/other-rule"), /js\/file-system-race\): do not/);
});
