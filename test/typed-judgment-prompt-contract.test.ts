import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTypedJudgmentPrompt,
  parseTypedJudgmentResponse,
  runTypedJudgment,
} from "#src/lib/typed-judgment.js";
import type { spawnWorker } from "#src/lib/worker.js";

test("typed judgment prompt example round-trips through the real parser", () => {
  for (const options of [
    ["low", "high"],
    ["proceed", "watch", "escalate"],
    ["only"],
    ['quote"inside', "back\\slash", "line\nbreak", "tab\tvalue", "café雪"],
    Array.from({ length: 17 }, (_, i) => `option-${i}`),
  ]) {
    const prompt = buildTypedJudgmentPrompt({ question: "Classify this input.", options });
    assert.match(prompt, /example illustrates formatting only/);
    const example = prompt.split("\n").find(line => /^\s*TYPED_JUDGMENT:/.test(line));
    assert(example, "the prompt must contain one physical-line example");
    const result = parseTypedJudgmentResponse(example, options);
    assert.equal(result.kind, "distribution", JSON.stringify({ options, result }));
    assert.deepEqual(Object.keys(result.distribution), options);
    for (const option of options) assert.equal(result.distribution[option], 1 / options.length);
  }
});

test("typed judgment preserves special option names as own distribution properties", () => {
  const options = ["__proto__", "constructor", "toString"];
  const example = 'TYPED_JUDGMENT: {"__proto__": 0.5, "constructor": 0.3, "toString": 0.2}';
  const result = parseTypedJudgmentResponse(example, options);
  assert.equal(result.kind, "distribution");
  assert.deepEqual(Object.keys(result.distribution), options);
  assert.equal(Object.getPrototypeOf(result.distribution), Object.prototype);
  assert.equal(result.distribution.__proto__, 0.5);
  assert.equal(result.distribution.constructor, 0.3);
  assert.equal(result.distribution.toString, 0.2);
});

test("typed judgment refuses empty and duplicate option sets before spawning", async () => {
  let spawned = 0;
  const spawn = (async () => { spawned++; throw new Error("invalid options must not spawn"); }) as typeof spawnWorker;
  for (const options of [[], ["low", "low"]]) {
    assert.throws(() => buildTypedJudgmentPrompt({ question: "q", options }), /non-empty distinct options/);
    const parsed = parseTypedJudgmentResponse('TYPED_JUDGMENT: {"low": 0.5}', options);
    assert.equal(parsed.kind, "rejected");
    if (parsed.kind !== "rejected") throw new Error("invalid option set must reject");
    assert.match(parsed.reason, /non-empty distinct options/);
    await assert.rejects(runTypedJudgment({ question: "q", options, cwd: "/unused", settingsFile: "/unused",
      mount: { model: "haiku", effort: "medium", maxTurns: 1, contextBudget: 60000 }, spawn }), /non-empty distinct options/);
  }
  assert.equal(spawned, 0);
});
