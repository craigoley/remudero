import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_FILE = join(ROOT, "test/headroom-sdk-source.test.ts");
const AUTH_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS"];
const FILE_ONLY_CASES = [
  "capacity refuses real unusable credential stores before opening its SDK transport",
  "a credential lost during SDK initialization prevents the usage control and releases its session",
  "an ordinary usage caller waits for native credential rotation before immediately tearing down",
  "a native credential refresh timeout or lost store is unreadable and never reaches usage",
  "the default usage refresh wait observes a real file replacement without sending a prompt",
  "the usage probe waits inside the pinned native CLI refresh margin while the token is still valid",
];
const OWNER_CONTROL = "usage authentication environment and Darwin keychain retain their existing credential precedence";
const RESTORED = "synthetic ambient authentication restored in the fixture child";
const FAILED_BODY = "file-only fixture deliberately fails after acquiring its cleanup hook";
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function fixtureChild(titles: readonly string[], body: string, absentKey?: string) {
  // Read the real suite before selection: a wrapper or a ghost path is not a six-case result.
  const bytes = readFileSync(SDK_FILE, "utf8");
  for (const title of titles.filter(title => title !== RESTORED && title !== FAILED_BODY)) assert.ok(bytes.includes(title), `missing real SDK case: ${title}`);
  const dir = mkdtempSync(join(tmpdir(), "rmd-sdk-auth-environment-"));
  const entry = join(dir, "fixture.test.mjs");
  const env = { ...process.env };
  // The child is a fresh runner, not this file's NODE_TEST_CONTEXT; retain the host-slot budget.
  delete env.NODE_TEST_CONTEXT;
  env.NODE_V8_COVERAGE = "";
  for (const key of AUTH_KEYS) env[key] = key.startsWith("CLAUDE_CODE_USE_") ? "1" : "fixture-only-ambient-auth";
  if (absentKey) delete env[absentKey];
  const expected = AUTH_KEYS.map(key => ({ key, present: Object.hasOwn(env, key), value: env[key] }));
  writeFileSync(entry, [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    `const sdk = await import(${JSON.stringify(pathToFileURL(SDK_FILE).href)});`,
    body,
    `test(${JSON.stringify(RESTORED)}, () => {`,
    `  for (const { key, present, value } of ${JSON.stringify(expected)}) {`,
    '    assert.equal(Object.hasOwn(process.env, key), present, "synthetic selector presence: " + key);',
    '    assert.equal(process.env[key], value, "synthetic selector restoration: " + key);',
    '  }',
    '});',
  ].join("\n"));
  const saved = AUTH_KEYS.map(key => process.env[key]);
  // This child inherits the admitted parent's environment and concurrency budget, not another host slot.
  const result = spawnSync(process.execPath, ["--import", "tsx", "--import", join(ROOT, "test/setup/tmp-hygiene.ts"), "--test", "--test-reporter=tap", "--test-concurrency=1", "--test-name-pattern", `^(?:${titles.map(literal).join("|")})$`, entry], { cwd: ROOT, env, encoding: "utf8", timeout: 40_000, maxBuffer: 8 * 1024 * 1024 });
  for (let i = 0; i < AUTH_KEYS.length; i++) assert.ok(process.env[AUTH_KEYS[i]!] === saved[i], "parent authentication was mutated");
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  const tap = result.stdout + result.stderr;
  const counts = Object.fromEntries(["tests", "pass", "fail", "cancelled", "skipped", "todo"].map(key => {
    const match = tap.match(new RegExp(`^# ${key} (\\d+)$`, "m"));
    assert.ok(match, `missing complete TAP summary: ${key}\n${tap}`);
    return [key, Number(match[1])];
  }));
  for (const title of titles) assert.ok(tap.split("\n").some(line => /^(?:not )?ok \d+ - /.test(line) && line.endsWith(title)), `actual case was not run: ${title}\n${tap}`);
  return { result, tap, counts };
}

test("file-only SDK fixtures preserve ambient caller auth and owner precedence", () => {
  const { result, tap, counts } = fixtureChild([...FILE_ONLY_CASES, OWNER_CONTROL, RESTORED], "");
  assert.equal(result.status, 0, tap);
  assert.deepEqual(counts, { tests: 8, pass: 8, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
});

test("file-only SDK fixture authentication restores after a failing body", () => {
  const { result, tap, counts } = fixtureChild([FAILED_BODY, RESTORED], [
    `test(${JSON.stringify(FAILED_BODY)}, t => {`,
    '  assert.equal(typeof sdk.fileOnlyUsageAuthentication, "function", "actual fixture helper is exported");',
    '  sdk.fileOnlyUsageAuthentication(t);',
    `  for (const key of ${JSON.stringify(AUTH_KEYS)}) assert.equal(process.env[key], undefined, "file-only precondition: " + key);`,
    '  throw new Error("deliberate fixture-body failure after cleanup registration");',
    '});',
  ].join("\n"), "CLAUDE_CODE_USE_ANTHROPIC_AWS");
  assert.equal(result.status, 1, tap);
  assert.deepEqual(counts, { tests: 2, pass: 1, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
  assert.match(tap, /deliberate fixture-body failure after cleanup registration/);
  assert.ok(tap.split("\n").some(line => /^ok \d+ - /.test(line) && line.endsWith(RESTORED)), "cleanup after an assertion/throw restores values and absence");
});
