import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { CONFIG_SCHEMA, ConfigShapeError, validateConfigShape, type Config } from "../../src/lib/config-schema.js";
import { validateConfig } from "../../src/lib/config.js";
import { CASH_TRIAL_ID, decideCashTrial } from "../../src/lib/cash-trial.js";

const SOURCE = "daily-cap.json";

/** A config that the shape check accepts except, possibly, for its daily cash cap. */
function withCap(dailyCapUsd: unknown): Record<string, unknown> {
  return { claudeBin: "/usr/bin/claude", root: "/tmp/root", dailyCapUsd };
}

/** The message of the shape refusal for one cap, or a failed assertion when the cap is accepted. */
function refusal(dailyCapUsd: unknown): string {
  let message: string | undefined;
  assert.throws(
    () => validateConfigShape(withCap(dailyCapUsd), SOURCE),
    (err: unknown) => {
      assert.ok(err instanceof ConfigShapeError);
      message = err.message;
      return true;
    },
    `the shape check must refuse the cap ${JSON.stringify(dailyCapUsd)}`,
  );
  assert.match(message!, /dailyCapUsd: /, "the refusal names the field");
  return message!;
}

test("W1-T12186 criterion 1: the shape check and the full check accept a normal and squeezed pair", () => {
  const pair = { normal: 10, squeezed: 50 };
  const shaped = validateConfigShape(withCap(pair), SOURCE);
  assert.deepEqual(shaped.dailyCapUsd, pair);
  // An equal pair is valid: the squeeze day buys the same as a normal day.
  assert.doesNotThrow(() => validateConfigShape(withCap({ normal: 10, squeezed: 10 }), SOURCE));
  const withCash = { ...withCap(pair), workerProviders: { enabled: ["claude", "cash"] } } as unknown as Config;
  assert.doesNotThrow(() => validateConfig(withCash));
});

test("W1-T12186 criterion 2: the shape check refuses a pair whose squeezed figure is below its normal figure", () => {
  const message = refusal({ normal: 50, squeezed: 10 });
  assert.match(message, /squeezed \(\$10\) is below normal \(\$50\)/);
  assert.throws(() => validateConfig(withCap({ normal: 50, squeezed: 10 }) as unknown as Config), ConfigShapeError);
});

test("W1-T12186 criterion 3: the shape check refuses a pair with a wrong member", () => {
  assert.match(refusal({ normal: 10 }), /squeezed is missing/);
  assert.match(refusal({ squeezed: 50 }), /normal is missing/);
  assert.match(refusal({}), /normal is missing/);
  assert.match(refusal({ normal: "10", squeezed: 50 }), /normal is not a finite number/);
  assert.match(refusal({ normal: 10, squeezed: null }), /squeezed is not a finite number/);
  assert.match(refusal({ normal: 10, squeezed: Number.POSITIVE_INFINITY }), /squeezed is not a finite number/);
  assert.match(refusal({ normal: -1, squeezed: 50 }), /normal is below zero/);
  assert.match(refusal({ normal: -5, squeezed: -1 }), /normal is below zero/);
  assert.match(refusal({ normal: 10, squeezed: 50, frontier: 75 }), /unexpected member "frontier"/);
  assert.match(refusal([10, 50]), /expected number or null, or a pair/);
});

test("W1-T12186 criterion 4: a plain number and null pass, and a string and a number below zero do not", () => {
  for (const cap of [25, 0, 0.5, null]) {
    assert.equal(validateConfigShape(withCap(cap), SOURCE).dailyCapUsd, cap);
  }
  // An absent cap is still valid for the shape check; the full check decides whether a provider needs one.
  assert.doesNotThrow(() => validateConfigShape({ claudeBin: "/usr/bin/claude", root: "/tmp/root" }, SOURCE));
  const bothForms = /dailyCapUsd: expected number or null, or a pair \{ normal, squeezed \} of numbers/;
  assert.match(refusal("25"), bothForms);
  assert.match(refusal(true), bothForms);
  assert.match(refusal(Number.NaN), bothForms);
  const negative = refusal(-1);
  assert.match(negative, bothForms);
  assert.match(negative, /the cap is below zero/);
});

test("W1-T12186 criterion 5: the pair in the comment on the field passes both checks", () => {
  const source = readFileSync(join(REPO_ROOT, "src", "lib", "config-schema.ts"), "utf8");
  const example = /^\s*\*\s+dailyCapUsd: \{ normal: (\d+), squeezed: (\d+) \}\s*$/m.exec(source);
  assert.ok(example, "the comment on dailyCapUsd gives a pair as an example");
  const pair = { normal: Number(example[1]), squeezed: Number(example[2]) };
  const config = { ...withCap(pair), workerProviders: { enabled: ["claude", "cash"] } };
  assert.deepEqual(validateConfigShape(config, SOURCE).dailyCapUsd, pair);
  assert.doesNotThrow(() => validateConfig(config as unknown as Config));
  // The type text of the field names the pair, as the type of Config.dailyCapUsd does.
  const field = CONFIG_SCHEMA.find((candidate) => candidate.name === "dailyCapUsd");
  assert.equal(field?.type, "number | { normal: number; squeezed: number } | null");
});

test("W1-T12186 criterion 6: with a pair, the cash trial budgets from the normal figure", () => {
  const today = "2026-11-10";
  const trialConfig = (dailyCapUsd: unknown): Config => ({
    ...withCap(dailyCapUsd),
    workerProviders: { enabled: ["claude", "cash"], harnessCommitsImplement: true, cashTrial: { sharePercent: 100 } },
  }) as unknown as Config;
  // One cash run of the trial that opened a pull request and cost `usd` today.
  const spent = (usd: number): Record<string, unknown>[] => [
    { ts: `${today}T01:00:00Z`, run_id: "r1", step: "worker.assignment",
      worker_assignment: { id: "a1", routing: { decision: { trial: CASH_TRIAL_ID, trialArm: "cash" } } } },
    { ts: `${today}T01:30:00Z`, run_id: "r1", step: "implement.done", selection_assignment_id: "a1",
      provider: "cash", billing_mode: "api", total_cost_usd: usd },
    { ts: `${today}T02:00:00Z`, run_id: "r1", step: "verdict", verdict: "blocked_ci", pr_url: "https://example.test/pull/1" },
  ];
  const decide = (dailyCapUsd: unknown, rows: Record<string, unknown>[] = []) => decideCashTrial({
    task: { id: "T-DOCS", type: "implement", risk: "low", files: ["docs/guide.md"] },
    taskClass: "docs", config: trialConfig(dailyCapUsd), harnessCommits: true, stateDir: "/state", readRows: () => rows, today,
  });
  const pair = { normal: 10, squeezed: 50 };

  const open = decide(pair);
  assert.equal(open?.arm, "cash", `a pair is a cap that is set: ${open?.reason}`);

  // The default share is 10%. That is $1 of the normal figure and $5 of the squeezed figure.
  const overNormal = decide(pair, spent(2));
  assert.equal(overNormal?.arm, "held");
  assert.match(overNormal!.reason, /trial budget spent today \(\$2\.00 of \$1\.00\)/);
  assert.equal(decide(pair, spent(0.5))?.arm, "cash", "spend below the share of the normal figure keeps the trial open");

  // A plain number and an absent cap keep their answers.
  assert.equal(decide(25, spent(2))?.arm, "cash");
  assert.match(decide(undefined)!.reason, /dailyCapUsd is unset/);
  assert.match(decide(null)!.reason, /dailyCapUsd is unset/);
  assert.match(decide(-1)!.reason, /invalid/);

  // A pair that the provider refuses holds the trial. Nothing is thrown.
  const inverted = decide({ normal: 50, squeezed: 10 });
  assert.equal(inverted?.arm, "held");
  assert.match(inverted!.reason, /dailyCapUsd is invalid for a paid trial: .*squeezed/);
});
