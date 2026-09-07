import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureBrowsers,
  execWhitelistedProof,
  parseWhitelistedProof,
  type BrowserPreflightRunner,
  type ProofSpawner,
} from "../src/lib/review.js";

const PASSING_TAP = "ok 1 - fixture passes\n# tests 1\n# pass 1\n# duration_ms 1\n";

function checkoutWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-browser-preflight-gate-"));
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(dir, file.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  return dir;
}

function runProof(proof: string, cwd: string): {
  outcome: "pass" | "fail" | "no-match";
  preflights: number;
  spawns: number;
  args: readonly string[];
} {
  const whitelisted = parseWhitelistedProof(proof);
  assert.ok(whitelisted, "fixture proof must parse");
  let preflights = 0;
  let spawns = 0;
  let args: readonly string[] = [];
  const spawn: ProofSpawner = (_command, spawnedArgs) => {
    spawns += 1;
    args = spawnedArgs;
    return PASSING_TAP;
  };
  const preflightBrowsers: BrowserPreflightRunner = () => {
    preflights += 1;
  };
  const outcome = execWhitelistedProof(whitelisted, cwd, 60_000, spawn, { preflightBrowsers });
  return { outcome, preflights, spawns, args };
}

test("source-only test proofs skip browser preflight without changing the proof result", () => {
  const cwd = checkoutWith({
    "test/source-only.test.ts": 'import assert from "node:assert/strict";\ntest("fixture", () => assert.equal(1, 1));\n',
  });

  const result = runProof("unit test: test/source-only.test.ts", cwd);

  assert.equal(result.outcome, "pass");
  assert.equal(result.preflights, 0);
  assert.equal(result.spawns, 1);
});

test("test proofs importing a browser driver still preflight before execution", () => {
  const cwd = checkoutWith({
    "test/browser.test.ts": 'import { chromium } from "playwright";\ntest("fixture", () => chromium);\n',
  });

  const result = runProof("unit test: test/browser.test.ts", cwd);

  assert.equal(result.outcome, "pass");
  assert.equal(result.preflights, 1);
  assert.equal(result.spawns, 1);
});

test("unresolved name-filtered test proofs still preflight and run the full test glob", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rmd-browser-preflight-unknown-"));

  const result = runProof("unit test: fixture title", cwd);

  assert.equal(result.outcome, "pass");
  assert.equal(result.preflights, 1);
  assert.equal(result.spawns, 1);
  assert.ok(result.args.includes("test/**/*.test.ts"));
});

test("name-filtered test proofs use their resolved file set for the browser preflight decision", () => {
  const cwd = checkoutWith({
    "test/source-title.test.ts": 'test("fixture title", () => {});\n',
    "test/browser-title.test.ts": 'import { chromium } from "playwright";\ntest("browser fixture title", () => chromium);\n',
  });

  const sourceOnly = runProof("unit test: fixture title", cwd);
  const browser = runProof("unit test: browser fixture title", cwd);

  assert.equal(sourceOnly.outcome, "pass");
  assert.equal(sourceOnly.preflights, 0);
  assert.ok(sourceOnly.args.includes("test/source-title.test.ts"));
  assert.ok(!sourceOnly.args.includes("test/**/*.test.ts"));
  assert.equal(browser.outcome, "pass");
  assert.equal(browser.preflights, 1);
  assert.ok(browser.args.includes("test/browser-title.test.ts"));
});

test("handled browser install failures log one cause line without stack frames", () => {
  const logged: string[] = [];
  const outcome = ensureBrowsers({
    browsersJsonText: JSON.stringify({ browsers: [{ name: "chromium", revision: "1", installByDefault: true }] }),
    isInstalled: () => false,
    install: () => {
      throw new Error("cdn refused\n    at IncomingMessage.fake\n    at ClientRequest.fake");
    },
    log: (msg) => logged.push(msg),
  });

  assert.equal(outcome, "failed");
  assert.equal(logged.length, 2);
  assert.equal(logged[1].includes("\n"), false);
  assert.match(logged[1], /cdn refused/);
  assert.doesNotMatch(logged[1], /IncomingMessage|ClientRequest|\bat /);
});
