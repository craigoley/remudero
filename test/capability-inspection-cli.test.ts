import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createCapabilityGrant, InMemoryCapabilityGrantStore, useCapabilityGrant } from "../src/lib/capability-grant.js";
import { authorityCommand, COMMANDS, HANDLERS, USAGE } from "../src/run-task.js";
import { CAPABILITY_INSPECTION_MAX_FILE_BYTES } from "../src/lib/capability-inspection.js";

test("test/capability-inspection-cli.test.ts: real local command reads canonical snapshot and receipts cannot execute", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inspection-"));
  try {
    const grant = createCapabilityGrant({ id: "g", targetIdentity: "t", operations: ["read"], audience: "a",
      expiresAt: "2030-01-01Z", approval: { approvedBy: "o", approvedAt: "2026-01-01Z" }, revocationLink: "r" });
    const request = { grantId: "g", operation: "read", target: "t", audience: "a", nonce: "n" };
    const storeFile = join(dir, "canonical.json");
    const requestFile = join(dir, "request.json");
    const casesFile = join(dir, "cases.json");
    const candidateFile = join(dir, "candidate.json");
    const snapshot = JSON.stringify({ schema: "capability-inspection-source-v1", grants: [
      { grant, revoked: false, useCount: 0, nonces: [] },
    ] });
    writeFileSync(storeFile, snapshot);
    writeFileSync(requestFile, JSON.stringify(request));
    writeFileSync(casesFile, JSON.stringify([request, request]));
    writeFileSync(candidateFile, JSON.stringify([request, { ...request, operation: "admin" }]));
    const run = (...args: string[]) => spawnSync(resolve("bin/rmd"), ["--repo-root", dir, "authority", "inspect", ...args], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, RMD_ROOT: dir, GH_TOKEN: "", GH_APP_ID: "", GH_APP_PRIVATE_KEY: "", GH_APP_INSTALLATION_ID: "" },
    });
    const common = ["--store", storeFile, "--at", "2026-10-08T00:00:00Z"];
    const first = run(...common, "--request", requestFile);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.schema, "capability-inspection-v1");
    assert.equal(receipt.verdict, "allow");
    const replay = run(...common, "--cases", casesFile, "--compare-cases", candidateFile);
    assert.equal(replay.status, 1, replay.stderr);
    const comparison = JSON.parse(replay.stdout);
    assert.deepEqual(comparison.baseline.results.map((r: { verdict: string }) => r.verdict), ["allow", "allow"]);
    assert.deepEqual(comparison.comparison.changes, ["unchanged", "changed"]);
    assert.equal(readFileSync(storeFile, "utf8"), snapshot);
    assert.deepEqual(readdirSync(dir).sort(), ["candidate.json", "canonical.json", "cases.json", "request.json"]);
    writeFileSync(requestFile, JSON.stringify(receipt));
    const reused = run(...common, "--request", requestFile);
    assert.equal(reused.status, 2);
    assert.equal(JSON.parse(reused.stdout).code, "invalid-request");
    const liveStore = new InMemoryCapabilityGrantStore();
    liveStore.issue(grant);
    liveStore.revoke("g");
    const live = useCapabilityGrant(liveStore, { ...request, receipt } as typeof request, { now: "2026-10-08Z" });
    assert.equal(live.verification.ok, false);
    assert.equal(liveStore.useCount("g"), 0);
    const help = run("--help");
    assert.equal(help.status, 0);
    assert.match(help.stdout, /read-only/);
    assert.match(help.stdout, /rmd authority inspect --store/);
    assert.equal(help.stdout.includes("rmd capability-inspect"), false);
    const invalid = run(...common, "--request", requestFile, "--execute");
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stderr.includes("--execute"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real command reports missing, malformed and oversized files without upstream error text", () => {
  const dir = mkdtempSync(join(tmpdir(), "rmd-inspection-source-"));
  try {
    const source = join(dir, "source.json");
    const input = join(dir, "input.json");
    const request = { grantId: "g", operation: "read", target: "t", audience: "a", nonce: "n" };
    writeFileSync(input, JSON.stringify(request));
    const run = (...args: string[]) => spawnSync(resolve("bin/rmd"), ["--repo-root", dir, "authority", "inspect", "--store", source,
      "--at", "2026-10-08Z", ...args], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    for (const content of [undefined, "secret broken JSON", "{}", "x".repeat(CAPABILITY_INSPECTION_MAX_FILE_BYTES + 1)]) {
      if (content !== undefined) writeFileSync(source, content);
      const result = run("--request", input);
      assert.equal(result.status, 2, result.stderr);
      const outcome = JSON.parse(result.stdout);
      assert.equal(outcome.verdict, "unavailable");
      assert.equal(outcome.code, content === undefined ? "missing-source" : "malformed-source");
      assert.equal(result.stdout.includes("secret"), false);
      assert.equal(result.stderr, "");
    }
    writeFileSync(source, JSON.stringify({ schema: "capability-inspection-source-v1", grants: [] }));
    const denied = run("--request", input);
    assert.equal(denied.status, 1);
    assert.equal(JSON.parse(denied.stdout).code, "unknown-grant");
    writeFileSync(input, "invalid input payload");
    assert.equal(JSON.parse(run("--request", input).stdout).verdict, "unknown");
    assert.equal(run("--request", input, "--cases", input).status, 2);
    assert.equal(run("--request").status, 2);
    const invalidClock = spawnSync(resolve("bin/rmd"), ["--repo-root", dir, "authority", "inspect", "--store", source, "--request", input],
      { cwd: dir, encoding: "utf8", timeout: 30_000 });
    assert.equal(invalidClock.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("authority inspect bypasses the fleet report and owns inspection help without a new CLI verb", () => {
  const output: string[] = [];
  const errors: string[] = [];
  const deps = {
    out: (s: string) => output.push(s),
    err: (s: string) => errors.push(s),
    loadPolicy: () => assert.fail("inspection must not load fleet policy"),
    loadPins: () => assert.fail("inspection must not load ratification pins"),
    resolveLedger: () => assert.fail("inspection must not read the ledger"),
  };
  assert.equal(authorityCommand(["inspect", "--help"], deps), 0);
  assert.equal(output.length, 1);
  assert.match(output[0], /rmd authority inspect --store/);
  assert.deepEqual(errors, []);
  assert.equal(authorityCommand(["inspect", "--execute"], deps), 2);
  assert.deepEqual(errors, ["rmd authority inspect: invalid arguments; see --help"]);
  assert.equal(COMMANDS.filter((c) => c.name === "authority").length, 1);
  assert.equal(COMMANDS.some((c) => c.name === "capability-inspect"), false);
  assert.equal(HANDLERS.has("capability-inspect"), false);
  assert.equal(USAGE.includes("rmd capability-inspect"), false);
});
