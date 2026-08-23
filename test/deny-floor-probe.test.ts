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
//
// W1-T1271: the step count is a PROXY for a real contract — the prompt's narrated
// count must agree with the steps it actually lists, or a worker acting on the
// prose can silently skip a step it was never told about. A literal `/THREE
// commands/` pins today's number and breaks on the next step added to the prompt,
// in a file the step-adding task never declares. `parseProbeStepNarration` derives
// both sides — the listed steps and the narrated counts — FROM THE PROMPT ITSELF,
// so the check below holds at any count and fails only on genuine drift between
// the two.

const CARDINAL_WORDS: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
};

const ORDINAL_WORDS: Record<string, number> = {
  FIRST: 1,
  SECOND: 2,
  THIRD: 3,
  FOURTH: 4,
  FIFTH: 5,
  SIXTH: 6,
  SEVENTH: 7,
  EIGHTH: 8,
  NINTH: 9,
  TENTH: 10,
};

/**
 * Derive, FROM THE PROMPT TEXT ALONE, the steps it actually lists and the counts
 * it narrates for them — never a hand-maintained number, or the coupling this
 * task removes reappears one level down.
 *
 * The prompt narrates counts in two shapes, matching how `containmentProbePrompt`
 * is written: an opening CARDINAL ("run these THREE commands") covering the first
 * block of numbered steps, and zero or more later ORDINAL follow-ons ("run this
 * FOURTH command") each introducing exactly one more numbered step — the shape
 * W1-T1265 used to add the egress check without renumbering the first three.
 */
function parseProbeStepNarration(prompt: string): {
  listed: number[];
  cardinal: number | undefined;
  ordinals: number[];
} {
  const listed = [...prompt.matchAll(/^(\d+)\)/gm)].map((m) => Number(m[1]));
  const cardinalMatch = prompt.match(/run these (\w+) commands/i);
  const cardinal = cardinalMatch ? CARDINAL_WORDS[cardinalMatch[1].toUpperCase()] : undefined;
  const ordinals = [...prompt.matchAll(/run this (\w+) command/gi)].map(
    (m) => ORDINAL_WORDS[m[1].toUpperCase()],
  );
  return { listed, cardinal, ordinals };
}

/**
 * THE CONTRACT ITSELF: the prompt's narrated counts must agree with the steps it
 * actually lists. Throws (via node:assert) on disagreement; passes silently — at
 * ANY total step count — when the narration is consistent. This is what the
 * literal `THREE` stood in for; asserting this instead means the next step added
 * to the prompt cannot break this file unless the narration itself goes wrong.
 */
function assertStepNarrationAgrees(prompt: string): void {
  const { listed, cardinal, ordinals } = parseProbeStepNarration(prompt);
  assert.ok(listed.length > 0, "the prompt must list at least one numbered step");
  assert.deepEqual(
    listed,
    listed.map((_, i) => i + 1),
    "the listed steps must be numbered sequentially starting at 1, with no gaps",
  );
  assert.ok(
    ordinals.every((n) => typeof n === "number" && !Number.isNaN(n)),
    "every 'run this Nth command' must use a recognized ordinal word",
  );
  assert.ok(
    typeof cardinal === "number" && !Number.isNaN(cardinal),
    "the prompt must open with a recognized 'run these N commands' cardinal count",
  );
  const total = listed.length;
  assert.equal(
    cardinal,
    total - ordinals.length,
    "the narrated cardinal count must equal the steps NOT introduced by a later ordinal",
  );
  ordinals.forEach((n, i) => {
    assert.equal(
      n,
      (cardinal as number) + i + 1,
      "each 'run this Nth command' ordinal must match that step's actual position in the list",
    );
  });
}

test("the probe prompt carries the tripwire command, so a spawned worker actually attempts it", () => {
  const prompt = containmentProbePrompt("tok123");
  assert.ok(
    prompt.includes(denyFloorProbeCommand()),
    "the prompt must carry the tripwire command verbatim or no worker ever attempts it",
  );
  assertStepNarrationAgrees(prompt);
  assert.match(prompt, /tripwire:/, "the report shape must have a slot for the tripwire outcome");
});

test("the prompt's narrated step count agrees with its listed steps, AT ANY COUNT — not just today's four", () => {
  // A plain block of N steps, no ordinal follow-on — covers "three or four or more"
  // (design note v) without hard-coding which count the real prompt uses today.
  const CARDINAL_LIST = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN"];
  const plainBlock = (n: number): string =>
    [`run these ${CARDINAL_LIST[n]} commands IN ORDER.`, ...Array.from({ length: n }, (_, i) => `${i + 1}) step`)].join(
      "\n",
    );
  for (const n of [3, 4, 5, 7]) {
    assert.doesNotThrow(() => assertStepNarrationAgrees(plainBlock(n)), `a well-formed ${n}-step prompt must pass`);
  }

  // The shape W1-T1265 actually used: a cardinal block plus a later ordinal
  // addition — must also pass, at whatever total it produces.
  const staged = [
    "run these THREE commands IN ORDER.",
    "1) step",
    "2) step",
    "3) step",
    "THEN run this FOURTH command — an addition:",
    "4) step",
  ].join("\n");
  assert.doesNotThrow(() => assertStepNarrationAgrees(staged), "a cardinal block plus one ordinal addition must pass");

  // The real prompt itself, at whatever count it currently narrates.
  assert.doesNotThrow(
    () => assertStepNarrationAgrees(containmentProbePrompt("tok123")),
    "the actual containmentProbePrompt output must satisfy the contract",
  );
});

test("a prompt whose narrated count DISAGREES with its listed steps fails the assertion", () => {
  // Says THREE but lists four steps with no ordinal introducing the fourth.
  const undercounted = [
    "run these THREE commands IN ORDER.",
    "1) step",
    "2) step",
    "3) step",
    "4) step",
  ].join("\n");
  assert.throws(
    () => assertStepNarrationAgrees(undercounted),
    "an undercounted cardinal (THREE said, four listed) must fail",
  );

  // Says FOUR but only lists three.
  const overcounted = ["run these FOUR commands IN ORDER.", "1) step", "2) step", "3) step"].join("\n");
  assert.throws(
    () => assertStepNarrationAgrees(overcounted),
    "an overcounted cardinal (FOUR said, three listed) must fail",
  );

  // The ordinal addition names the wrong position — FIFTH where the list is only at 4.
  const wrongOrdinal = [
    "run these THREE commands IN ORDER.",
    "1) step",
    "2) step",
    "3) step",
    "THEN run this FIFTH command — an addition:",
    "4) step",
  ].join("\n");
  assert.throws(
    () => assertStepNarrationAgrees(wrongOrdinal),
    "an ordinal that names the wrong position (FIFTH for step 4) must fail",
  );

  // A gap in the listed numbering itself (1, 2, 4 — no 3).
  const gappedList = ["run these THREE commands IN ORDER.", "1) step", "2) step", "4) step"].join("\n");
  assert.throws(() => assertStepNarrationAgrees(gappedList), "a gap in the listed step numbers must fail");
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
