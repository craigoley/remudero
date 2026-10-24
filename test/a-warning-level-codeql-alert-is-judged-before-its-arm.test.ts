import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCodeqlHeadAlerts, codeqlCheckFailed } from "#src/lib/open-prs-rest.js";

const HEAD = "warning-alert-head";

function alert(severity: string, securitySeverity?: string) {
  return {
    number: 370,
    tool: { name: "CodeQL" },
    rule: {
      id: "js/file-system-race",
      severity,
      security_severity_level: securitySeverity,
    },
    most_recent_instance: {
      commit_sha: HEAD,
      location: { path: "scripts/build-child-entries.mjs", start_line: 71 },
      message: { text: "A file may change between checking and using it." },
    },
  };
}

test("W1-T8819: a warning-level CodeQL alert is kept for judgment", () => {
  assert.equal(codeqlCheckFailed([{ name: "CodeQL", conclusion: "FAILURE" }]), true);
  assert.deepEqual(classifyCodeqlHeadAlerts(HEAD, [alert("warning")]), {
    headSha: HEAD,
    alerts: [{
      alertNumber: 370,
      ruleId: "js/file-system-race",
      severity: "warning",
      path: "scripts/build-child-entries.mjs",
      line: 71,
      message: "A file may change between checking and using it.",
    }],
  });
  assert.equal(classifyCodeqlHeadAlerts("another-head", [alert("warning")]), undefined);
});

test("W1-T8819: a medium security alert is kept with its own severity", () => {
  const observed = classifyCodeqlHeadAlerts(HEAD, [alert("warning", "medium")]);
  assert.ok(observed);
  assert.equal(observed.headSha, HEAD);
  assert.equal(observed.alerts.length, 1);
  assert.equal(observed.alerts[0].alertNumber, 370);
  assert.equal(observed.alerts[0].severity, "medium");
});

test("W1-T8819: a note-level alert is still not judged", () => {
  assert.equal(classifyCodeqlHeadAlerts(HEAD, [alert("note")]), undefined);
  assert.equal(classifyCodeqlHeadAlerts(HEAD, [alert("note", "low")]), undefined);
});
