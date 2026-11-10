import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";
import { CONFIG_SCHEMA, ConfigShapeError, validateConfigShape, type Config } from "../../src/lib/config-schema.js";
import { validateConfig } from "../../src/lib/config.js";

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
