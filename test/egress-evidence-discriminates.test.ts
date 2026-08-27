// W1-T2271 — THE EGRESS ARM REPORTS A PROVEN BREACH FROM A CHECK THAT CANNOT SEE ONE.
//
// `egressProbeCommand` runs `curl -sS -m 10 -o /dev/null https://example.com && touch
// <marker>` — no `--fail`, no status-code test, and `-o /dev/null` discards the body, so
// curl exits 0 on ANY http response (200, 403, 407, a proxy-synthesised block page) and
// non-zero only on a TRANSPORT failure (DNS, refused connection, timeout). The old
// `assessEgressContainment` converted that one boolean straight into "egress
// PROVEN-BROKEN — the allowlist did not hold", a cause the evidence never carried, and
// the short-circuit outranked contrary evidence (`egressDenialSeen`) the same probe run
// already held. 90 of 97 recorded verdicts read PROVEN-BROKEN under this flawed check.
//
// This file pins the seven acceptance criteria the task rationale names:
//   1. a response with no discriminating detail reads UNPROVEN, never a proven breach.
//   2. a refusal observed alongside a response is not outranked by the response.
//   3. the evidence can tell a served page from a proxy answer, and the verdict names it.
//   4. the probe still discards the response body — no check reads what a third party served.
//   5. the turn cap stays derived from the numbered command count, never a literal.
//   6. the egress arm stays observational and never throws — the filesystem arm still gates.
//   7. no new destination is contacted and the allowlist is unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EGRESS_ALLOWED_HOST_FALLBACK,
  EGRESS_ALLOWED_MARKER,
  EGRESS_ALLOWED_REMOTE_IP_FILE,
  EGRESS_BLOCKED_HOST,
  EGRESS_BLOCKED_MARKER,
  EGRESS_BLOCKED_REMOTE_IP_FILE,
  PROBE_TURN_ALLOWANCE,
  allowedHostFromSettings,
  assessEgressContainment,
  containmentProbePrompt,
  defaultExecutor,
  egressProbeCommand,
  probeCommandCount,
  probeContainment,
  probeTurnBudget,
  type ContainmentEvidence,
  type ProbeExecResult,
} from "../src/lib/containment.js";
import type { Config } from "../src/lib/config.js";
import type { SpawnWorkerArgs, WorkerResult } from "../src/lib/worker.js";

function settingsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-egress-evidence-test-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const ENABLED = {
  sandbox: { enabled: true, failIfUnavailable: true },
  permissions: { deny: [], allow: [], ask: [] },
};

/** Evidence with the filesystem arm already holding, so only egress is under test —
 *  the same fixture shape test/containment.test.ts's own egress tests use. */
function egressEvidence(over: Partial<ContainmentEvidence>): ContainmentEvidence {
  return {
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
    ...over,
  };
}

// ── Criterion 1 — a bare response is UNPROVEN, never a proven breach ───────────────

test("acceptance 1: a response with no discriminating detail reads UNPROVEN, not a proven breach", () => {
  const v = assessEgressContainment(
    egressEvidence({ egressBlockedReached: true, egressAllowedReached: true, egressDenialSeen: false }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /no discriminating detail/);
  assert.ok(!/PROVEN-BROKEN/.test(v.reason), "a bare response must never assert a proven breach");
});

test("acceptance 1: the same bare response stays UNPROVEN even with remote-ip fields entirely absent (a pre-existing executor)", () => {
  const v = assessEgressContainment(
    egressEvidence({
      egressBlockedReached: true,
      egressAllowedReached: true,
      egressDenialSeen: false,
      egressBlockedRemoteIp: undefined,
      egressAllowedRemoteIp: undefined,
    }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
});

// ── Criterion 2 — a refusal is not outranked by a response ─────────────────────────

test("acceptance 2: a refusal observed alongside a response is not outranked by the response", () => {
  const v = assessEgressContainment(
    egressEvidence({ egressBlockedReached: true, egressAllowedReached: true, egressDenialSeen: true }),
  );
  assert.equal(v.contained, false, "contrary evidence must not be silently promoted to proven-holding either");
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /refusal was ALSO observed/);
  assert.ok(!/PROVEN-BROKEN/.test(v.reason));
});

test("acceptance 2: the refusal-not-outranked branch fires even when a discriminating remote-ip mismatch is ALSO present", () => {
  // The denial check runs BEFORE the remote-ip discriminator — contrary evidence the
  // probe already holds must win regardless of what the transport facts also show.
  const v = assessEgressContainment(
    egressEvidence({
      egressBlockedReached: true,
      egressAllowedReached: true,
      egressDenialSeen: true,
      egressBlockedRemoteIp: "93.184.216.34",
      egressAllowedRemoteIp: "140.82.112.3",
    }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /refusal was ALSO observed/);
});

// ── Criterion 3 — a served page is told apart from a proxy answer, and named ───────

test("acceptance 3: the SAME remote address on both requests reads UNPROVEN and names the shared-proxy address", () => {
  const v = assessEgressContainment(
    egressEvidence({
      egressBlockedReached: true,
      egressAllowedReached: true,
      egressDenialSeen: false,
      egressBlockedRemoteIp: "127.0.0.1",
      egressAllowedRemoteIp: "127.0.0.1",
    }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /UNPROVEN/);
  assert.match(v.reason, /SAME remote address/);
  assert.match(v.reason, /127\.0\.0\.1/);
  assert.ok(!/PROVEN-BROKEN/.test(v.reason));
});

test("acceptance 3: a DIFFERENT remote address than the control reads PROVEN-BROKEN and names both addresses", () => {
  const v = assessEgressContainment(
    egressEvidence({
      egressBlockedReached: true,
      egressAllowedReached: true,
      egressDenialSeen: false,
      egressBlockedRemoteIp: "93.184.216.34",
      egressAllowedRemoteIp: "140.82.112.3",
    }),
  );
  assert.equal(v.contained, false);
  assert.match(v.reason, /PROVEN-BROKEN/);
  assert.match(v.reason, /93\.184\.216\.34/);
  assert.match(v.reason, /140\.82\.112\.3/);
});

// ── readRemoteIp (defaultExecutor's own read of the two remote-ip files) ───────────
//
// The pure-verdict tests above hand `assessEgressContainment` an already-built
// `ContainmentEvidence`; these two drive `defaultExecutor` itself so its private
// `readRemoteIp` helper's two branches — a successful trimmed read, and the
// catch-on-missing-file fallback — are each exercised through a real fake spawn
// that writes into the SAME cwd the executor computed, exactly as curl's `-w
// '%{remote_ip}' > file` redirection would.

function fakeWorkerResult(): WorkerResult {
  return {
    sessionId: "s",
    costUsd: 0,
    numTurns: 1,
    text: "",
    blocks: [],
    stderr: "",
    subtype: "success",
    isError: false,
    apiError: false,
    permissionDenials: [],
  } as unknown as WorkerResult;
}

test("readRemoteIp: a reached request with a written remote-ip file reads the trimmed content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-egress-remoteip-test-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    // Same discipline curl's own redirection follows: the remote-ip file is
    // written UNCONDITIONALLY, the touch marker only once the request "succeeds".
    writeFileSync(join(args.cwd, EGRESS_BLOCKED_REMOTE_IP_FILE), "93.184.216.34\n");
    writeFileSync(join(args.cwd, EGRESS_BLOCKED_MARKER), "");
    writeFileSync(join(args.cwd, EGRESS_ALLOWED_REMOTE_IP_FILE), "140.82.112.3\n");
    writeFileSync(join(args.cwd, EGRESS_ALLOWED_MARKER), "");
    return fakeWorkerResult();
  };
  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("remoteIpTok");
  assert.equal(result.egressBlockedRemoteIp, "93.184.216.34");
  assert.equal(result.egressAllowedRemoteIp, "140.82.112.3");
});

test("readRemoteIp: a reached request whose remote-ip file never landed reads undefined, not a thrown error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-egress-remoteip-test-"));
  const config = { root: dir } as Config;
  const fakeSpawn = async (args: SpawnWorkerArgs): Promise<WorkerResult> => {
    // The touch marker says the request came back, but its paired remote-ip
    // file is absent — readRemoteIp must catch the missing-file read and
    // return undefined rather than throw, exactly as an executor that
    // predates this field (or a redirect that never landed) would look.
    writeFileSync(join(args.cwd, EGRESS_BLOCKED_MARKER), "");
    writeFileSync(join(args.cwd, EGRESS_ALLOWED_MARKER), "");
    return fakeWorkerResult();
  };
  const exec = defaultExecutor("settings.json", config, undefined, fakeSpawn);
  const result: ProbeExecResult = await exec("remoteIpTok2");
  assert.equal(result.egressBlockedReached, true);
  assert.equal(result.egressAllowedReached, true);
  assert.equal(result.egressBlockedRemoteIp, undefined);
  assert.equal(result.egressAllowedRemoteIp, undefined);
});

// ── Criterion 4 — the body is still never read ──────────────────────────────────────

test("acceptance 4: the egress command still discards both response bodies", () => {
  const cmd = egressProbeCommand(EGRESS_ALLOWED_HOST_FALLBACK);
  const bodyDiscards = cmd.match(/-o \/dev\/null/g);
  assert.equal(bodyDiscards?.length, 2, "both curl calls must discard the body, exactly as before");
  assert.ok(!/--fail\b/.test(cmd), "no status-code gate was added — this task adds observation, not a new check");
  assert.ok(!/-w '%\{(?!remote_ip)/.test(cmd), "the only -w field exposed is the transport fact, never body content");
});

// ── Criterion 5 — the turn cap stays derived, never a literal ──────────────────────

test("acceptance 5: probeCommandCount still counts exactly six numbered entries, unchanged by this task", () => {
  const prompt = containmentProbePrompt("tokABC");
  assert.equal(probeCommandCount(prompt), 6);
  // W1-T2344: PROBE_TURN_ALLOWANCE became a function of command count (capped at
  // a stated ceiling) rather than a flat per-probe constant — see
  // test/containment.test.ts's own W1-T2344 tests for the scaling/ceiling
  // behavior itself; this file only needs the derivation to still hold.
  assert.equal(probeTurnBudget(prompt), 6 + 1 + PROBE_TURN_ALLOWANCE(6));
});

test("acceptance 5: the egress command itself introduces no new numbered entry", () => {
  // egressProbeCommand's own returned text must never contain a line matching the
  // prompt's numbering convention (`N) ...`) — if it did, probeCommandCount would
  // silently double-count and probeTurnBudget would drift without a deliberate
  // decision (design note part (v)).
  const cmd = egressProbeCommand(EGRESS_ALLOWED_HOST_FALLBACK);
  assert.equal(probeCommandCount(cmd), 0);
});

// ── Criterion 6 — still observational, the filesystem arm keeps sole gating authority ─

test("acceptance 6: a bare egress response never throws — the filesystem arm's PASS governs the run", async () => {
  const exec = (): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: "tokEGR touch: ../tokEGR.txt: Operation not permitted",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      egressBlockedReached: true,
      egressAllowedReached: true,
    });
  const res = await probeContainment({ settingsFile: settingsFile(ENABLED), token: "tokEGR", exec });
  assert.equal(res.contained, true, "the filesystem arm's own OS-denial still governs the throw/pass decision");
  // And the pure egress verdict over that SAME evidence still reads UNPROVEN, not
  // PROVEN-BROKEN — the fix is visible on the recorded evidence even though it never
  // gated this run either way.
  const egress = assessEgressContainment(res.evidence);
  assert.equal(egress.contained, false);
  assert.match(egress.reason, /UNPROVEN/);
});

test("acceptance 6: even a PROVEN-BROKEN egress verdict (genuine remote-ip mismatch) does not throw", async () => {
  const exec = (): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: "tokEGR2 touch: ../tokEGR2.txt: Operation not permitted",
      outsideWriteCreated: false,
      insideWriteCreated: true,
      egressBlockedReached: true,
      egressAllowedReached: true,
      egressBlockedRemoteIp: "93.184.216.34",
      egressAllowedRemoteIp: "140.82.112.3",
    });
  const res = await probeContainment({ settingsFile: settingsFile(ENABLED), token: "tokEGR2", exec });
  assert.equal(res.contained, true, "the egress arm never throws regardless of its own verdict");
  assert.match(assessEgressContainment(res.evidence).reason, /PROVEN-BROKEN/);
});

// ── Criterion 7 — no new destination, allowlist unchanged ──────────────────────────

test("acceptance 7: the egress command names exactly two hosts — the RFC 2606 target and the allowlisted control", () => {
  const cmd = egressProbeCommand("my-allowed-host.example.org");
  const hosts = [...cmd.matchAll(/https:\/\/([^\s"']+)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(hosts), new Set([EGRESS_BLOCKED_HOST, "my-allowed-host.example.org"]));
});

test("acceptance 7: the allowlisted control is still derived FROM the allowlist, never a literal added by this task", () => {
  assert.equal(
    allowedHostFromSettings({ sandbox: { network: { allowedDomains: ["github.com", "api.github.com"] } } }),
    "github.com",
  );
  assert.equal(allowedHostFromSettings({}), EGRESS_ALLOWED_HOST_FALLBACK);
});

test("acceptance 7: the two touch markers are still present, unchanged names — existsSync semantics preserved", () => {
  const cmd = egressProbeCommand(EGRESS_ALLOWED_HOST_FALLBACK);
  assert.ok(cmd.includes(`touch ${EGRESS_BLOCKED_MARKER}`));
  assert.ok(cmd.includes(`touch ${EGRESS_ALLOWED_MARKER}`));
});
