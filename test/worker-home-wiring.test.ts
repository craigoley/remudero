import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workerSrc = readFileSync(fileURLToPath(new URL("../src/lib/worker.ts", import.meta.url)), "utf8");

// ── The W1-T18 HOME redirection is WIRED into every worker spawn, not just implemented ──

test("spawnWorker MATERIALIZES the redirected worker-home before building the child env", () => {
  assert.match(workerSrc, /materializeWorkerHome\(/, "worker.ts must call materializeWorkerHome");
  const materializeIdx = workerSrc.indexOf("materializeWorkerHome(");
  const envIdx = workerSrc.indexOf("buildWorkerEnv(args.env");
  assert.ok(materializeIdx >= 0 && envIdx >= 0);
  assert.ok(materializeIdx < envIdx, "the scratch HOME must exist on disk before the child env references it");
});

test("spawnWorker passes the redirected HOME into buildWorkerEnv (the grant actually reaches the child env)", () => {
  const call = workerSrc.slice(workerSrc.indexOf("buildWorkerEnv(args.env"), workerSrc.indexOf("buildWorkerEnv(args.env") + 400);
  assert.match(call, /home:\s*workerHome/, "buildWorkerEnv must be called with { home: workerHome }");
});

test("workerHomeDir is resolved from config, never hardcoded", () => {
  assert.match(workerSrc, /workerHomeDir\(config\)/);
});
