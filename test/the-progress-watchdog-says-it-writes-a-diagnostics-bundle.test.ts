import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// @source-text-subject: the watchdog descriptions are the subject of this wording regression.
const parity = readFileSync(new URL("../scripts/console-parity-ratchet.mjs", import.meta.url), "utf8");
const source = readFileSync(new URL("../src/run-task.ts", import.meta.url), "utf8");

test("test/the-progress-watchdog-says-it-writes-a-diagnostics-bundle.test.ts: registry detail", () => {
  const registry = source.match(/const COMMANDS: readonly CommandSpec\[\] = \[([\s\S]*?)\n\] as const/);
  assert.ok(registry, "the COMMANDS registry exists");
  const command = registry[1].match(/^  \{\n    name: "progress-watchdog",\n[\s\S]*?^  \},/m);
  assert.ok(command, "the progress-watchdog command is registered");
  const literal = command[0].match(/^    detail: ("(?:\\.|[^"\\])*"),$/m);
  assert.ok(literal, "the progress-watchdog registry detail is a string literal");
  const detail: string = JSON.parse(literal[1]);
  assert.doesNotMatch(detail, /read[- ]only/i);
  assert.match(detail, /capture-diagnostics it writes one bundle/);
  assert.match(detail, /<state>\/diagnostics\/progress-<ts>\//);
  assert.match(detail, /at most one per 15 min/);
  assert.match(detail, /docker ps/);
  assert.match(detail, /docker logs --tail/);
  assert.match(detail, /it recycles nothing/i);
});

test("test/the-progress-watchdog-says-it-writes-a-diagnostics-bundle.test.ts: CLI_ONLY note", () => {
  const note = parity.match(/\/\/ W1-T5687:([^\n]*)\n\s*"progress-watchdog",/);
  assert.ok(note, "the CLI_ONLY progress-watchdog note exists");
  assert.doesNotMatch(note[1], /read[- ]only/i);
  assert.match(note[1], /capture-diagnostics/);
  assert.match(note[1], /writes.*bundle/);
  assert.match(note[1], /<state>\/diagnostics\//);
  assert.match(note[1], /at most one per 15 min/);
  assert.match(note[1], /docker ps/);
  assert.match(note[1], /docker logs/);
  assert.match(note[1], /it recycles nothing/);
});

test("test/the-progress-watchdog-says-it-writes-a-diagnostics-bundle.test.ts: command comment", () => {
  const comment = source.match(/(\/\/ W1-T5687:[^\n]*\n\/\/[^\n]*)\nexport function progressWatchdogCommand/);
  assert.ok(comment, "the two-line progressWatchdogCommand comment exists");
  assert.doesNotMatch(comment[1], /read[- ]only/i);
  assert.match(comment[1], /capture-diagnostics/);
  assert.match(comment[1], /writes.*bundle/);
  assert.match(comment[1], /<state>\/diagnostics\//);
  assert.match(comment[1], /at most one per 15 min/);
  assert.match(comment[1], /docker/);
  assert.match(comment[1], /recycles nothing/);
});
