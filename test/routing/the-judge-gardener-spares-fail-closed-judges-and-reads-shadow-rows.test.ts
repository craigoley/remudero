/**
 * W1-T13501 — the config gardener's move-judge-to-cash class never proposes cash for a judge that fails closed,
 * reads the one-line rows that carry a nested `shadow:` mapping, and refuses a row it cannot edit as one line.
 * The guard test and the gardener read one list, FAIL_CLOSED_JUDGE_ROWS. Criterion 2 reads two files as text
 * because its claim is about where that list is read: @source-text-subject.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  configCandidates, FAIL_CLOSED_JUDGE_ROWS, JUDGE_CASH_BAR, JUDGE_ROLE_ROWS, judgeCashCandidate, type ConfigInventory,
} from "#src/lib/config-gardener.js";
import type { JudgeShadowRoleSummary } from "#src/lib/judge-shadow.js";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import { ownedFixtureDir, type FixtureScope } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const ISO = fixedClock(Date.parse("2026-11-17T12:00:00.000Z")).iso();
const TABLE = readFileSync(mountsPath(REPO_ROOT), "utf8");
const rng = () => 0;

/** The real table's line for `key`. */
function realLine(key: string): string {
  const line = TABLE.split("\n").find((l) => l.startsWith(`${key}: {`));
  assert.ok(line, `.remudero/mounts.yaml must hold a one-line ${key} row`);
  return line!;
}

/** A checkout the gardener can read, holding `mountsText` as its mounts table. */
function root(t: FixtureScope, mountsText = TABLE): string {
  const dir = ownedFixtureDir(t, "judge-gardener-fail-closed").dir;
  mkdirSync(join(dir, ".remudero"));
  mkdirSync(join(dir, "plan", "tasks.d"), { recursive: true });
  writeFileSync(join(dir, "plan", "tasks.yaml"), "[]\n");
  writeFileSync(mountsPath(dir), mountsText);
  return dir;
}

function inventory(...judgeShadows: JudgeShadowRoleSummary[]): ConfigInventory {
  return { nowIso: ISO, runs: [], queued: [], recommendations: [], active: [], cooling: [], judgeShadows };
}

/** A record exactly at {@link JUDGE_CASH_BAR}. */
function record(role: string): JudgeShadowRoleSummary {
  return { role, paired: JUDGE_CASH_BAR.minPaired, agreeShare: JUDGE_CASH_BAR.minAgreeShare, noAnswerShare: JUDGE_CASH_BAR.maxNoAnswerShare,
    refused: 0, primaryMedianCostUsd: 0.003, shadowMedianCostUsd: 0.0002 };
}

test("W1-T13501 criterion 1: a risk_judge row on one line, of the lowest tier, with no provider and a record over the bar gets no move-judge-to-cash proposal; feedback_summary with the same record gets exactly one", (t) => {
  const dir = root(t);
  const mounts = loadMounts(mountsPath(dir));
  const lowest = Math.min(...Object.values(mounts.tiers));
  // The risk judge's row is everything the class would otherwise accept.
  assert.match(realLine("risk_judge"), /^\w+: \{[^{}]*\}\s*$/);
  assert.equal(mounts.risk_judge?.provider, undefined);
  assert.equal(mounts.tiers[mounts.risk_judge!.model], lowest);
  assert.equal(JUDGE_ROLE_ROWS["risk-judge"], "risk_judge");

  assert.equal(judgeCashCandidate(inventory(record("risk-judge")), dir), undefined);
  assert.deepEqual(configCandidates(inventory(record("risk-judge")), dir, rng), []);

  // The decision summary fails open: the same record gets one proposal, also when the risk judge is listed first.
  for (const inv of [inventory(record("decision-summary")), inventory(record("risk-judge"), record("decision-summary"))]) {
    const actions = configCandidates(inv, dir, rng);
    assert.equal(actions.length, 1);
    assert.deepEqual([actions[0]!.class, actions[0]!.target], ["move-judge-to-cash", "decision-summary"]);
    assert.equal(actions[0]!.edits[0]!.from, realLine("feedback_summary"));
  }
});

test("W1-T13501 criterion 2: config-gardener.ts exports FAIL_CLOSED_JUDGE_ROWS with risk_judge and ruling_judge, judgeCashCandidate and the fail-closed guard both read it, and neither keeps a literal list", () => {
  assert.deepEqual([...FAIL_CLOSED_JUDGE_ROWS], ["risk_judge", "ruling_judge"]);
  const gardener = readFileSync(join(REPO_ROOT, "src", "lib", "config-gardener.ts"), "utf8");
  const guard = readFileSync(join(REPO_ROOT, "test", "an-open-weight-provider-rides-the-capability-ladder.test.ts"), "utf8");

  // The gardener: judgeCashCandidate's body reads the list, and ruling_judge is named only where the list is declared.
  const start = gardener.indexOf("export function judgeCashCandidate(");
  assert.ok(start > 0, "judgeCashCandidate is declared");
  const body = gardener.slice(start, gardener.indexOf("\n}\n", start));
  assert.match(body, /FAIL_CLOSED_JUDGE_ROWS[^\n]*\.includes\(key\)/, "judgeCashCandidate skips a row on the list");
  assert.doesNotMatch(body, /"risk_judge"|"ruling_judge"/, "judgeCashCandidate names no fail-closed row itself");
  assert.equal(gardener.match(/ruling_judge/g)?.length, 1, "ruling_judge is named only in FAIL_CLOSED_JUDGE_ROWS");

  // The guard: it imports the list from the gardener's module and loops over it.
  const testStart = guard.indexOf("the fail-closed judges deliberately do not");
  assert.ok(testStart > 0, "the fail-closed guard is present");
  const guardBody = guard.slice(testStart, guard.indexOf("\n});\n", testStart));
  assert.match(guard, /import \{[^}]*\bFAIL_CLOSED_JUDGE_ROWS\b[^}]*\} from "#src\/lib\/config-gardener\.js"/);
  assert.match(guardBody, /for \(const name of FAIL_CLOSED_JUDGE_ROWS\)/);
  assert.match(guardBody, /doesNotMatch\(rowLine\[1\]!, \/provider\\s\*:\//, "the guard checks each row line for a provider");
  assert.match(guardBody, /parsed\[name\]\?\.provider, undefined/, "the guard checks each parsed row for a provider");
  // No literal pattern or list of fail-closed names remains in the guard.
  assert.doesNotMatch(guardBody, /\/\^(risk|ruling)_judge:/, "no literal row pattern");
  assert.doesNotMatch(guardBody, /\[\s*"(risk|ruling)_judge"/, "no literal list");
});

test("W1-T13501 criterion 3: the real ci_judge and fix_progress_judge lines get one edit that puts provider: cash before shadow:, and the edited table loads with the cash provider and the shadow arm", (t) => {
  for (const [role, key] of [["ci-judge", "ci_judge"], ["fix-progress", "fix_progress_judge"]] as const) {
    const dir = root(t);
    const from = realLine(key);
    // W1-T14841: the row shadows auto with DeepSeek-V4-Flash as its flat fallback, so it stays one flow map.
    assert.match(from, /, shadow: auto, shadow_fallback: DeepSeek-V4-Flash \}$/, `${key} carries its shadow arm`);
    const actions = configCandidates(inventory(record(role)), dir, rng);
    assert.equal(actions.length, 1, key);
    assert.equal(actions[0]!.edits.length, 1);
    const edit = actions[0]!.edits[0]!;
    assert.equal(edit.path, ".remudero/mounts.yaml");
    assert.equal(edit.from, from);
    assert.equal(edit.to, from.replace(", shadow: auto", ", provider: cash, shadow: auto"));

    const edited = root(t, TABLE.split("\n").map((line) => (line === edit.from ? edit.to : line)).join("\n"));
    const moved = loadMounts(mountsPath(edited));
    assert.equal(moved[key]!.provider, "cash");
    const arm = moved[key]!.shadow!;
    assert.equal(arm.provider === "auto" ? arm.fallback?.deployment : undefined, "DeepSeek-V4-Flash");
  }
});

test("W1-T13501 criterion 4: a row over several lines, a row with two levels of nested braces and a one-line row that names any provider get no proposal, and a flat provider-less row still gets provider: cash before its last brace", (t) => {
  const summary = realLine("feedback_summary");
  const ci = realLine("ci_judge");
  const refused: Array<[string, string, string]> = [
    ["several lines", "decision-summary", TABLE.replace(summary, summary.replace(" max_turns:", "\n  max_turns:"))],
    ["two nesting levels", "ci-judge", TABLE.replace(ci, ci.replace("DeepSeek-V4-Flash }", "DeepSeek-V4-Flash, note: { a: { b: 1 } } }"))],
  ];
  for (const provider of ["claude", "codex", "cash"]) {
    refused.push([`flat row on ${provider}`, "decision-summary", TABLE.replace(summary, summary.replace(/ \}$/, `, provider: ${provider} }`))]);
    refused.push([`shadow row on ${provider}`, "ci-judge", TABLE.replace(ci, ci.replace(", shadow:", `, provider: ${provider}, shadow:`))]);
  }
  for (const [name, role, text] of refused) {
    assert.notEqual(text, TABLE, name);
    const dir = root(t, text);
    loadMounts(mountsPath(dir)); // each variant is a table that loads: the refusal is the gardener's.
    assert.deepEqual(configCandidates(inventory(record(role)), dir, rng), [], name);
  }

  const flat = configCandidates(inventory(record("decision-summary")), root(t), rng);
  assert.deepEqual(flat[0]!.edits, [{ path: ".remudero/mounts.yaml", from: summary, to: summary.replace(/ \}$/, ", provider: cash }") }]);
});
