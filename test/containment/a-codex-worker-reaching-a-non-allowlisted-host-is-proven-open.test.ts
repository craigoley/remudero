import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EGRESS_BLOCKED_HOST,
  EGRESS_BLOCKED_OUTCOME_FILE,
  EGRESS_RESULT_PREFIX,
  assessEgressContainment,
  defaultExecutor,
  egressProbeCommand,
  egressRefusalObserved,
  probeContainment,
  type ContainmentEvidence,
  type EgressCurlOutcome,
  type ProbeExecResult,
} from "#src/lib/containment.js";
import type { Config } from "#src/lib/config.js";
import type { WorkerResult } from "#src/lib/worker.js";

// W1-T11437: on 2026-11-05 every Codex probe reached example.com at its REAL address while the
// allowlisted control reached api.github.com at another, yet egress read UNPROVEN, because the
// command's own echo and the tripwire's refusal line both matched the refusal pattern.
const BOUND = { timeout: 20_000 };
const REMOTE_BLOCKED = "104.20.23.154";
const REMOTE_CONTROL = "140.82.114.4";
const CONNECT_REFUSAL = "curl: (56) CONNECT tunnel failed, response 403";

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
    egressDenialSeen: false,
    ...over,
  } as ContainmentEvidence;
}

test("a missing blocked request outcome never proves refusal", BOUND, () => {
  assert.equal(egressRefusalObserved(undefined), false);
});

test("a proxy's 403 CONNECT refusal is still read as an egress refusal", BOUND, () => {
  assert.equal(egressRefusalObserved({ exitCode: 56, stderr: CONNECT_REFUSAL }), true);
  assert.equal(egressRefusalObserved({ exitCode: 0, stderr: CONNECT_REFUSAL }), false);
  assert.equal(egressRefusalObserved({ exitCode: 28, stderr: "curl: (28) Operation timed out" }), false);
  assert.equal(egressRefusalObserved({ exitCode: -1, stderr: CONNECT_REFUSAL }), false);
  assert.equal(egressRefusalObserved({ exitCode: 256, stderr: CONNECT_REFUSAL }), false);
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
    egressDenialSeen: egressRefusalObserved({ exitCode: 56, stderr: CONNECT_REFUSAL }),
  }));
  assert.equal(v.contained, true);
});

async function runProbe(blockedIp: string, controlIp: string, over: Partial<ProbeExecResult> = {}) {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exec = (token: string): Promise<ProbeExecResult> => Promise.resolve({
    transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\n${probeTranscript}`,
    outsideWriteCreated: false,
    insideWriteCreated: true,
    egressBlockedReached: true,
    egressAllowedReached: true,
    egressBlockedRemoteIp: blockedIp,
    egressAllowedRemoteIp: controlIp,
    egressBlockedCurlOutcome: { exitCode: 0, stderr: "" },
    costUsd: 0,
    ...over,
  } as ProbeExecResult);
  const res = await probeContainment({ settingsFile: settingsFile(), exec, token: "w1t11437", log: (step, extra) => rows.push({ step, extra }) });
  return { res, rows };
}

for (const [label, unrelatedText] of [["echo and hook refusal", probeTranscript], ["unrelated CONNECT error", `${probeTranscript}\n${CONNECT_REFUSAL}`]]) {
  test(`${label} cannot suppress remote egress evidence`, BOUND, async () => {
    const { res, rows } = await runProbe(REMOTE_BLOCKED, REMOTE_CONTROL, {
      transcript: `w1t11437: Operation not permitted\n${unrelatedText}`,
    });
    assert.equal(res.evidence.egressDenialSeen, false);
    assert.match(assessEgressContainment(res.evidence).reason, /^egress PROVEN-BROKEN/);
    assert.equal(rows.filter((r) => r.step === "containment.egress_proven_open").length, 1);
  });
}

for (const outcome of [undefined, { exitCode: 28, stderr: "curl: (28) Operation timed out" }, { exitCode: 0, stderr: CONNECT_REFUSAL }]) {
  test(`unrelated CONNECT refusal cannot certify containment with outcome ${JSON.stringify(outcome)}`, BOUND, async () => {
    const { res } = await runProbe("", REMOTE_CONTROL, {
      transcript: `w1t11437: Operation not permitted\n${probeTranscript}\n${CONNECT_REFUSAL}`,
      egressBlockedReached: false,
      egressBlockedRemoteIp: undefined,
      egressBlockedCurlOutcome: outcome,
    });
    const egress = assessEgressContainment(res.evidence);
    assert.equal(egress.contained, false);
    assert.match(egress.reason, /UNPROVEN/);
  });
}

async function executeCommand(outcome: EgressCurlOutcome, outcomeFile?: string | null) {
  const root = mkdtempSync(join(tmpdir(), "rmd-egress-outcome-"));
  const settings = settingsFile();
  try {
    const curl = join(root, "curl");
    writeFileSync(curl, `#!/bin/sh\ncase "$*" in\n*https://${EGRESS_BLOCKED_HOST}*)\nprintf '${REMOTE_BLOCKED}'\nprintf '%s' '${outcome.stderr}' >&2\nexit ${outcome.exitCode};;\n*)\nprintf '${REMOTE_CONTROL}'\nprintf '%s' '${CONNECT_REFUSAL}' >&2\nexit 0;;\nesac\n`);
    chmodSync(curl, 0o755);
    const executor = defaultExecutor(settings, { root } as Config, undefined, async (args) => {
      const command = egressProbeCommand("api.github.com").replace(/\s{2,}\(.*$/s, "");
      const stdout = execFileSync("sh", ["-e", "-c", command], {
        cwd: args.cwd, encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ""}` },
      });
      assert.equal(readFileSync(join(args.cwd, EGRESS_BLOCKED_OUTCOME_FILE), "utf8"), `${outcome.exitCode}\n${outcome.stderr}\n`);
      if (outcomeFile === null) rmSync(join(args.cwd, EGRESS_BLOCKED_OUTCOME_FILE));
      else if (outcomeFile !== undefined) writeFileSync(join(args.cwd, EGRESS_BLOCKED_OUTCOME_FILE), outcomeFile);
      return { text: `${stdout}\n${probeTranscript}\n${CONNECT_REFUSAL}`, blocks: [], stderr: "", costUsd: 0 } as unknown as WorkerResult;
    }, () => {});
    const result = await executor("outcome");
    const { res } = await runProbe(REMOTE_BLOCKED, REMOTE_CONTROL, {
      ...result, transcript: `w1t11437: Operation not permitted\n${result.transcript}`,
    });
    return res;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the real egress command and executor preserve the blocked curl exit code and stderr", BOUND, async () => {
  const res = await executeCommand({ exitCode: 56, stderr: CONNECT_REFUSAL });
  assert.equal(res.evidence.egressBlockedReached, false);
  assert.equal(res.evidence.egressAllowedReached, true);
  assert.equal(res.evidence.egressDenialSeen, true);
  assert.equal(assessEgressContainment(res.evidence).contained, true);
});

test("a successful blocked curl stays proven open despite errors from the control and transcript", BOUND, async () => {
  const res = await executeCommand({ exitCode: 0, stderr: "" });
  assert.equal(res.evidence.egressBlockedRemoteIp, REMOTE_BLOCKED);
  assert.equal(res.evidence.egressAllowedRemoteIp, REMOTE_CONTROL);
  assert.equal(res.evidence.egressDenialSeen, false);
  assert.match(assessEgressContainment(res.evidence).reason, /^egress PROVEN-BROKEN/);
});

for (const outcomeFile of [null, "", `not-a-status\n${CONNECT_REFUSAL}`, `256\n${CONNECT_REFUSAL}`]) {
  test(`missing or malformed blocked curl evidence stays unproven: ${JSON.stringify(outcomeFile)}`, BOUND, async () => {
    const res = await executeCommand({ exitCode: 56, stderr: CONNECT_REFUSAL }, outcomeFile);
    assert.equal(res.evidence.egressDenialSeen, undefined);
    assert.equal(assessEgressContainment(res.evidence).contained, false);
    assert.match(assessEgressContainment(res.evidence).reason, /UNPROVEN/);
  });
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
