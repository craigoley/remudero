import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EGRESS_BLOCKED_HOST,
  EGRESS_RESULT_PREFIX,
  assessEgressContainment,
  egressRefusalObserved,
  probeContainment,
  type ContainmentEvidence,
  type ProbeExecResult,
} from "#src/lib/containment.js";

// W1-T11437: on 2026-11-05 every Codex probe reached example.com at its REAL address while the
// allowlisted control reached api.github.com at another, yet egress read UNPROVEN, because the
// command's own echo and the tripwire's refusal line both matched the refusal pattern.
const BOUND = { timeout: 20_000 };
const REMOTE_BLOCKED = "104.20.23.154";
const REMOTE_CONTROL = "140.82.114.4";

const probeTranscript = [
  `${EGRESS_RESULT_PREFIX} blocked=reached`,
  `${EGRESS_RESULT_PREFIX} allowed=reached`,
  "tripwire: Command blocked by PreToolUse hook: deny-floor: blocked — FORBIDDEN_PROBE path.",
].join("\n");

function settingsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1-t11437-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify({
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      network: { allowedDomains: ["github.com", "api.github.com"] } },
    permissions: { deny: [], allow: [], ask: [] },
  }));
  return path;
}

function reachedEvidence(over: Partial<ContainmentEvidence>): ContainmentEvidence {
  return {
    outsideWriteCreated: false, osDenialSeen: true, insideWriteCreated: true,
    egressBlockedReached: true, egressAllowedReached: true,
    egressDenialSeen: egressRefusalObserved(probeTranscript),
    ...over,
  } as ContainmentEvidence;
}

test("the probe's own EGRESS-RESULT echo and the tripwire refusal are not an egress refusal", BOUND, () => {
  assert.equal(egressRefusalObserved(probeTranscript), false);
});

test("a proxy's 403 CONNECT refusal is still read as an egress refusal", BOUND, () => {
  assert.equal(egressRefusalObserved(`curl: (56) CONNECT tunnel failed, response 403\n${probeTranscript}`), true);
});

test("a non-allowlisted host answered at a remote address other than the control's is PROVEN-BROKEN", BOUND, () => {
  const v = assessEgressContainment(reachedEvidence({
    egressBlockedRemoteIp: REMOTE_BLOCKED, egressAllowedRemoteIp: REMOTE_CONTROL,
  }));
  assert.equal(v.contained, false);
  assert.match(v.reason, /^egress PROVEN-BROKEN/);
  assert.match(v.reason, new RegExp(EGRESS_BLOCKED_HOST.replace(/\./g, "\\.")));
});

test("both requests answered by the local allowlist proxy stays UNPROVEN, never PROVEN-BROKEN", BOUND, () => {
  const v = assessEgressContainment(reachedEvidence({ egressBlockedRemoteIp: "::1", egressAllowedRemoteIp: "::1" }));
  assert.match(v.reason, /UNPROVEN/);
  assert.doesNotMatch(v.reason, /PROVEN-BROKEN/);
});

test("a proxy-refused blocked request beside a reached control is contained", BOUND, () => {
  const v = assessEgressContainment(reachedEvidence({
    egressBlockedReached: false,
    egressDenialSeen: egressRefusalObserved(`curl: (56) CONNECT tunnel failed, response 403\n${probeTranscript}`),
  }));
  assert.equal(v.contained, true);
});

async function runProbe(blockedIp: string, controlIp: string) {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exec = (token: string): Promise<ProbeExecResult> => Promise.resolve({
    transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\n${probeTranscript}`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    egressBlockedReached: true,
    egressAllowedReached: true,
    egressBlockedRemoteIp: blockedIp,
    egressAllowedRemoteIp: controlIp,
    costUsd: 0,
  } as ProbeExecResult);
  const res = await probeContainment({ settingsFile: settingsFile(), exec, token: "w1t11437", log: (step, extra) => rows.push({ step, extra }) });
  return { res, rows };
}

test("W1-T11437 criterion 3: a proven-open egress verdict writes a shadow row and never changes the containment verdict", BOUND, async () => {
  const { res, rows } = await runProbe(REMOTE_BLOCKED, REMOTE_CONTROL);
  const open = rows.filter((r) => r.step === "containment.egress_proven_open");
  assert.equal(open.length, 1, "one shadow row per proven-open probe");
  assert.equal(open[0]?.extra?.shadow, true);
  assert.equal(open[0]?.extra?.egress_blocked_remote_ip, REMOTE_BLOCKED);
  assert.equal(res.contained, true, "shadow: the filesystem verdict still decides, so no build stops on this row");
});

test("W1-T11437 criterion 3: a probe answered by the local proxy writes no proven-open row", BOUND, async () => {
  const { rows } = await runProbe("::1", "::1");
  assert.equal(rows.filter((r) => r.step === "containment.egress_proven_open").length, 0);
  assert.equal(rows.filter((r) => r.step === "containment.probe").length, 1, "positive control: the probe did run and log");
});
