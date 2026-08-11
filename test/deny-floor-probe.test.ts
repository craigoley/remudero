import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ContainmentError,
  DENY_FLOOR_PROBE_BASENAME,
  assessDenyFloor,
  containmentProbePrompt,
  denyFloorProbeCommand,
  probeContainment,
  stripDenyFloorLines,
  type ProbeExecResult,
} from "../src/lib/containment.js";

const containmentSrc = readFileSync(fileURLToPath(new URL("../src/lib/containment.ts", import.meta.url)), "utf8");
const denyFloorSrc = readFileSync(fileURLToPath(new URL("../hooks/deny-floor.sh", import.meta.url)), "utf8");

function settingsFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-deny-floor-test-"));
  const path = join(dir, "worker.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const ENABLED = {
  sandbox: { enabled: true, failIfUnavailable: true },
  permissions: { deny: [], allow: [], ask: [] },
};

// ── assessDenyFloor: BOTH directions, plus the third state ──────────────────

test("assessDenyFloor: the tripwire was CREATED ⇒ the deny floor did NOT engage", () => {
  const v = assessDenyFloor({
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
    denyFloorProbeCreated: true,
  });
  assert.equal(v.engaged, false);
  assert.match(v.reason, /NOT ENGAGED/);
  assert.match(v.reason, new RegExp(DENY_FLOOR_PROBE_BASENAME));
});

test("assessDenyFloor: the tripwire was REFUSED ⇒ the deny floor engaged", () => {
  const v = assessDenyFloor({
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
    denyFloorProbeCreated: false,
  });
  assert.equal(v.engaged, true);
  assert.match(v.reason, /engaged/);
});

test("assessDenyFloor: NO tripwire observation ⇒ UNOBSERVED, never 'engaged' — silence is not evidence", () => {
  const v = assessDenyFloor({
    outsideWriteCreated: false,
    osDenialSeen: true,
    insideWriteCreated: true,
  });
  assert.equal(v.engaged, undefined, "an unreported tripwire must never read as engaged");
  assert.match(v.reason, /UNOBSERVED/);
});

// ── The probe REACHES the worker, and targets the one path that discriminates ──

test("the probe prompt carries the tripwire command, so a spawned worker actually attempts it", () => {
  const prompt = containmentProbePrompt("tok123");
  assert.ok(
    prompt.includes(denyFloorProbeCommand()),
    "the prompt must carry the tripwire command verbatim or no worker ever attempts it",
  );
  assert.match(prompt, /THREE commands/, "the prompt must ask for all three steps");
  assert.match(prompt, /tripwire:/, "the report shape must have a slot for the tripwire outcome");
});

test("the tripwire targets a path INSIDE cwd — an outside-cwd target would prove the sandbox, not the hook", () => {
  const cmd = denyFloorProbeCommand();
  assert.ok(!cmd.includes("~"), "a ~ target is outside the sandbox write scope and proves nothing about the hook");
  assert.ok(!cmd.includes(".."), "a parent-dir target is outside the sandbox write scope and proves nothing about the hook");
  assert.match(cmd, /\.\/FORBIDDEN_PROBE$/, "the tripwire must be a cwd-relative path");
});

test("the hook rule the probe depends on still exists — probe and hook cannot drift apart silently", () => {
  assert.ok(
    denyFloorSrc.includes(DENY_FLOOR_PROBE_BASENAME),
    "hooks/deny-floor.sh must still match the basename the probe plants, or the probe reports a false NOT-ENGAGED",
  );
});

// ── stripDenyFloorLines: the containment verdict must not get WEAKER ─────────

test("stripDenyFloorLines removes tripwire lines and keeps the outside-write denial", () => {
  const transcript = [
    "touch ../tok123.txt",
    "touch: ../tok123.txt: Operation not permitted",
    `touch ./${DENY_FLOOR_PROBE_BASENAME}`,
    "deny-floor: blocked — FORBIDDEN_PROBE path",
    "tripwire: permission denied by the hook",
  ].join("\n");
  const stripped = stripDenyFloorLines(transcript);
  assert.ok(stripped.includes("Operation not permitted"), "the outside-write denial is the evidence and must survive");
  assert.ok(!stripped.includes("deny-floor"), "the hook's own line must be stripped");
  assert.ok(!stripped.includes(DENY_FLOOR_PROBE_BASENAME), "the tripwire command line must be stripped");
  assert.ok(!/tripwire:/.test(stripped), "the tripwire report line must be stripped");
});

test("REGRESSION: a run whose ONLY denial text is the tripwire's still FAILS CLOSED as unproven", async () => {
  // Without stripDenyFloorLines this transcript satisfies OS_DENIAL_RE via step 3's
  // narration alone, flipping a genuinely UNPROVEN run (the outside write was never
  // attempted) to "contained" — the one way adding the tripwire could WEAKEN the gate.
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: [
        `I was asked about ../${token}.txt but did not run step 1.`,
        `touch ./${DENY_FLOOR_PROBE_BASENAME}`,
        "tripwire: permission denied",
      ].join("\n"),
      outsideWriteCreated: false,
      insideWriteCreated: true,
      denyFloorProbeCreated: false,
    });
  await assert.rejects(
    () => probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tok123" }),
    (e: unknown) => e instanceof ContainmentError && /UNPROVEN/.test((e as Error).message),
  );
});

// ── OBSERVATIONAL: the tripwire records, it does not gate ───────────────────

test("a NOT-ENGAGED deny floor does NOT block the run — the observation is advisory, not a new bound", async () => {
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted\ntouch probe-ok.txt`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
      denyFloorProbeCreated: true, // the floor LEAKED
    });
  const res = await probeContainment({ settingsFile: settingsFile(ENABLED), exec, token: "tok123" });
  assert.equal(res.contained, true, "containment is unchanged by the deny-floor observation");
  assert.equal(res.evidence.denyFloorProbeCreated, true, "the leak is still carried on the evidence");
});

test("the tripwire observation rides the containment.probe ledger line, tri-state intact", async () => {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
      denyFloorProbeCreated: false,
    });
  await probeContainment({
    settingsFile: settingsFile(ENABLED),
    exec,
    token: "tok123",
    log: (step, extra) => lines.push({ step, extra }),
  });
  const probe = lines.find((l) => l.step === "containment.probe");
  assert.ok(probe, "the probe must still log containment.probe");
  assert.equal(probe!.extra?.deny_floor_engaged, true);
  assert.match(String(probe!.extra?.deny_floor_reason), /engaged/);
});

test("an executor that reports NO tripwire outcome logs UNOBSERVED, not engaged", async () => {
  const lines: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const exec = (token: string): Promise<ProbeExecResult> =>
    Promise.resolve({
      transcript: `touch ../${token}.txt\ntouch: ../${token}.txt: Operation not permitted`,
      outsideWriteCreated: false,
      insideWriteCreated: true,
    });
  await probeContainment({
    settingsFile: settingsFile(ENABLED),
    exec,
    token: "tok123",
    log: (step, extra) => lines.push({ step, extra }),
  });
  const probe = lines.find((l) => l.step === "containment.probe");
  assert.equal(probe!.extra?.deny_floor_engaged, undefined);
  assert.match(String(probe!.extra?.deny_floor_reason), /UNOBSERVED/);
});

// ── the falsifier ────────────────────────────────────────────────────────────

test("MUTANT: the strip guards the OS-denial test, and the tripwire is observed inside cwd", () => {
  const strip = "stripDenyFloorLines(r.transcript)";
  assert.equal(
    containmentSrc.split(strip).length - 1,
    1,
    "the substitution target must be UNIQUE or the mutant proves nothing",
  );
  // The strip must guard the OS-denial pattern specifically — a call placed anywhere
  // else would leave osDenialSeen reading the raw transcript.
  assert.match(
    containmentSrc,
    new RegExp(`OS_DENIAL_RE\\.test\\(${strip.replace(/[.()]/g, "\\$&")}\\)`),
    "OS_DENIAL_RE must be applied to the STRIPPED transcript, never the raw one",
  );

  const observe = "existsSync(denyFloorPath)";
  assert.equal(
    containmentSrc.split(observe).length - 1,
    1,
    "the substitution target must be UNIQUE or the mutant proves nothing",
  );
  // The observed path must be built under `cwd`, not `base` — a `base` sibling is
  // outside the sandbox write scope and would report a permanent false ENGAGED.
  assert.match(
    containmentSrc,
    /const denyFloorPath = join\(cwd, DENY_FLOOR_PROBE_BASENAME\);/,
    "the tripwire must be observed INSIDE cwd or every run reports a false engaged",
  );
});
