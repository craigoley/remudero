import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { buildEscalationTriageRuntime, readEscalationTriagePolicySource } from "#src/run-task.js";
import type { EscalateDeps, AsyncIssueGateway } from "#src/lib/escalate.js";
import type { Config } from "#src/lib/config.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";

// W1-T10734: remudero-site ships no plan/policy.yaml, and every site triage pass died on the ENOENT.
// Every proof here runs the REAL default reader — no `readPolicy` is injected — because the
// existing triage tests all inject one, which is how the default's crash went unseen.

function targetRoot(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}triage-policy-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function settingsFor(root: string) {
  const runtime = buildEscalationTriageRuntime(
    { root, config: { root } as Config, owner: "o", repo: "r" },
    { readRows: () => [], seenAt: () => undefined, windowMs: () => 1 },
  );
  return runtime({} as EscalateDeps<AsyncIssueGateway>);
}

test("W1-T10734 criterion 1: a target checkout with no plan/policy.yaml triages in shadow instead of failing", (t) => {
  const root = targetRoot(t);
  assert.equal(readEscalationTriagePolicySource(root), undefined);
  const settings = settingsFor(root);
  assert.equal(settings.mode, "shadow");
});

test("W1-T10734 criterion 1: a target's own escalationTriage block still governs its triage", (t) => {
  const root = targetRoot(t);
  mkdirSync(join(root, "plan"));
  writeFileSync(join(root, "plan", "policy.yaml"), "escalationTriage:\n  mode: act\n  maxAutoResolvesPerPass: 3\n");
  assert.equal(settingsFor(root).mode, "act");
});

test("W1-T10734 criterion 1: a policy file that exists but cannot be read or parsed still fails the pass", (t) => {
  const unreadable = targetRoot(t);
  mkdirSync(join(unreadable, "plan", "policy.yaml"), { recursive: true });
  assert.throws(() => readEscalationTriagePolicySource(unreadable), { code: "EISDIR" });
  assert.throws(() => settingsFor(unreadable), { code: "EISDIR" });

  const unparseable = targetRoot(t);
  mkdirSync(join(unparseable, "plan"));
  writeFileSync(join(unparseable, "plan", "policy.yaml"), "escalationTriage: [unclosed\n");
  assert.throws(() => readEscalationTriagePolicySource(unparseable));
});
