import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { attributeVerbs, deriveCliVerbs, deriveStepPrefixes } from "../src/lib/emissions.js";
import { assertVerbScanAgreesWithRegistry, COMMANDS, emissionsCommand } from "../src/run-task.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TASK_SOURCE = readFileSync(join(REPO, "src", "run-task.ts"), "utf8");

// The full source corpus emissionsCommand itself scans for ledger-step prefixes — `notify.sent`
// lives in lib/notify.ts, not run-task.ts, so a prefix check scoped to run-task.ts alone would
// wrongly read `notify` as unattributable.
function allSrcSources(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const child = join(d, e.name);
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith(".ts")) out.push(readFileSync(child, "utf8"));
    }
  };
  walk(join(REPO, "src"));
  return out;
}

// The three verbs W1-T2479 found invisible: registered on ONE LINE at two-space indentation
// (`{ name: "retro", usage: … }`), not the four-space multi-line shape every other entry used —
// which is exactly what the prior `/^\s{4}name:\s*"…"/gm` pattern required.
const PREVIOUSLY_INVISIBLE = ["retro", "resume", "notify"];

// The OLD, buggy pattern, reproduced here rather than imported: the fix under test replaced it,
// so the only way to prove "reverting it fails loudly" is to keep a copy of what it did.
const oldDeriveCliVerbs = (source: string): string[] => [...source.matchAll(/^\s{4}name:\s*"([a-z0-9-]+)"/gm)].map((m) => m[1]);

test("the verb scan sees a registry entry written on one line as well as one written across several", () => {
  const verbs = deriveCliVerbs(RUN_TASK_SOURCE);
  // "run-task" is written across several lines (name: on its own line at four-space indentation);
  // "retro" is written on one line at two-space indentation. Both must be seen.
  assert.ok(verbs.includes("run-task"), "the multi-line entry shape must still be read");
  assert.ok(verbs.includes("retro"), "the one-line entry shape must now be read too");
});

test("the three previously invisible verbs appear in the report", () => {
  const verbs = deriveCliVerbs(RUN_TASK_SOURCE);
  for (const name of PREVIOUSLY_INVISIBLE) {
    assert.ok(verbs.includes(name), `expected \`rmd ${name}\` in the derived verb set — it was invisible before W1-T2479`);
  }
});

test("the scan and the registry are asserted to agree at the caller that can see both", () => {
  const declared = COMMANDS.map((c) => c.name);
  const scanned = deriveCliVerbs(RUN_TASK_SOURCE);
  // Non-vacuity first: an empty-vs-empty comparison would pass every assertion below for the
  // wrong reason.
  assert.ok(declared.length > 0 && scanned.length > 0);
  assert.doesNotThrow(
    () => assertVerbScanAgreesWithRegistry(scanned, declared),
    "the real scan and the real registry must agree on this checkout",
  );
  assert.deepEqual([...scanned].sort(), [...declared].sort(), "same verbs, not merely the same count");
});

test("a registry entry in a shape the scan cannot read fails loudly rather than shrinking the corpus", () => {
  const declared = ["run-task", "review", "retro"];
  const scanned = ["run-task", "review"]; // "retro" silently dropped, as the old pattern did
  assert.throws(
    () => assertVerbScanAgreesWithRegistry(scanned, declared),
    /disagree/,
    "a scan short of the registry must throw, never just report a smaller number",
  );
  // Named, not just counted.
  assert.throws(() => assertVerbScanAgreesWithRegistry(scanned, declared), /retro/);
});

test("reverting the pattern fix makes the agreement control fail by name", () => {
  const declared = COMMANDS.map((c) => c.name);
  const reverted = oldDeriveCliVerbs(RUN_TASK_SOURCE);
  // The old pattern itself must actually reproduce the bug this task fixes — otherwise this test
  // would prove nothing about the control below.
  for (const name of PREVIOUSLY_INVISIBLE) {
    assert.ok(!reverted.includes(name), `expected the OLD pattern to still miss \`rmd ${name}\``);
  }
  let thrown: unknown;
  try {
    assertVerbScanAgreesWithRegistry(reverted, declared);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, "the control must throw when fed the reverted (buggy) scan");
  for (const name of PREVIOUSLY_INVISIBLE) {
    assert.match((thrown as Error).message, new RegExp(name), `the failure must name \`${name}\`, not just a count`);
  }
});

test("a verb with no attributable prefix is still reported unmeasurable and never as dead", () => {
  // `resume` carries no ledger step prefix anywhere in source (verified: no "resume.*" literal
  // exists), unlike `retro` (retro.start/.synthesized/...) and `notify` (notify.sent) — so it is
  // the real, in-corpus case of SURFACE 4's "unauditable, not dead" distinction this task's
  // rationale insists on.
  const prefixes = deriveStepPrefixes(allSrcSources());
  assert.ok(!prefixes.has("resume"), "fixture assumption: `resume` must carry no ledger prefix in source");

  const attributed = attributeVerbs(["retro", "resume", "notify"], prefixes);
  const byName = new Map(attributed.map((a) => [a.name, a.prefix]));
  assert.equal(byName.get("resume"), null, "resume has no attributable prefix");
  assert.notEqual(byName.get("retro"), null, "retro DOES have an attributable prefix (retro.*)");
  assert.notEqual(byName.get("notify"), null, "notify DOES have an attributable prefix (notify.*)");

  // And the live command's own UNAUDITABLE line is where that shows up — never as a dead/live
  // classification row, which only ever covers `measurable` verbs.
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let code: number;
  try {
    code = emissionsCommand([]);
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /UNAUDITABLE \(no ledger step carries the verb's name\): .*\bresume\b/);
  assert.doesNotMatch(out, /\bDEAD\b/i, "this report never uses a 'dead' label — unauditable/unreachable are the only unmeasured statuses");
});

test("the report states how many verbs the registry declares beside how many it scanned", () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let code: number;
  try {
    code = emissionsCommand([]);
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0);
  const out = lines.join("\n");
  const m = /verbs\s+: (\d+) declared, (\d+) scanned, \d+ measurable, \d+ unauditable/.exec(out);
  assert.ok(m, `expected a "declared" figure beside a "scanned" figure, got:\n${out}`);
  const [, declaredStr, scannedStr] = m as unknown as [string, string, string];
  assert.equal(declaredStr, String(COMMANDS.length), "declared must be the registry's own length");
  assert.equal(scannedStr, String(deriveCliVerbs(RUN_TASK_SOURCE).length), "scanned must be the derivation's own length");
  // On a healthy checkout they agree — assertVerbScanAgreesWithRegistry already enforced that
  // above the print statement — but they are printed as two numbers, not collapsed into one.
  assert.equal(declaredStr, scannedStr);
});
