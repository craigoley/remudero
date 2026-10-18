import { repoRoot } from "#test/helpers/repo-root.js";
import { pathToFileURL } from "node:url";
// The sweep's diff-coverage reporter feeds the red-base refresh decision. It reads repository paths
// through the fix prompt's parser and retains absolute checkout paths when CI prints those instead.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

import * as sweep from "#src/lib/sweep.js";

const HEADER =
  "diff-coverage: BLOCKED -- this diff adds source line(s) with zero covering tests, even though the aggregate coverage-ratchet floor may still be satisfied:";

test("a diff-coverage line glossed with a remedy is still reported as uncovered", () => {
  const logTail = [HEADER, "  - src/lib/daemon.ts:1528 -- add a test that throws from afterRow", "  - src/lib/daemon.ts:1530"].join("\n");
  const report = sweep.diffCoverageReport([{ name: "coverage-ratchet", logTail }]);
  assert.deepEqual(report?.uncovered, ["src/lib/daemon.ts:1528", "src/lib/daemon.ts:1530"]);
});

test("a glossed-only diff-coverage red still names its source file to the red-base refresh", () => {
  const logTail = [HEADER, "  - src/lib/daemon-memory-telemetry.ts:277 -- cover the rejected heap read"].join("\n");
  assert.deepEqual(sweep.failingSourceFilesFromCiFailures([{ name: "coverage-ratchet", logTail }]), [
    "src/lib/daemon-memory-telemetry.ts",
  ]);
});

test("an absolute diff-coverage path retains its checkout prefix and gloss", () => {
  const logTail = [HEADER, "  - C:\\workspace\\remudero\\src\\lib\\model-health.ts:47 -- cover the failure arm"].join("\n");
  const failures = [{ name: "coverage-ratchet", logTail }];
  assert.deepEqual(sweep.diffCoverageReport(failures)?.uncovered, [
    "C:\\workspace\\remudero\\src\\lib\\model-health.ts:47",
  ]);
  assert.deepEqual(sweep.failingSourceFilesFromCiFailures(failures), [
    "C:/workspace/remudero/src/lib/model-health.ts",
  ]);
});

test("an absolute path from another checkout does not match a source basename", () => {
  const logTail = [HEADER, "  - /workspace/other/foo.ts:12"].join("\n");
  const failures = [{ name: "coverage-ratchet", logTail }];
  assert.deepEqual(sweep.failingSourceFilesFromCiFailures(failures), ["/workspace/other/foo.ts"]);
  assert.deepEqual(
    sweep.decideRedBaseRefresh(failures, { behindBy: 3, baseChangedFiles: ["src/lib/foo.ts"] }).matchingBaseFiles,
    [],
  );
});

test('the absolute-path diff-coverage parser rejects a long "- /!/!/" line in linear time', async (t) => {
  const moduleUrl = pathToFileURL(`${repoRoot()}/src/lib/sweep.ts`).href;
  const program = `
    const { diffCoverageReport } = await import(${JSON.stringify(moduleUrl)});
    process.send({ ready: true });
    process.once("message", () => {
      const reports = [40, 20_000].map(n => diffCoverageReport([{
        name: "coverage-ratchet",
        logTail: ${JSON.stringify(HEADER)} + "\\n  - /" + "!/".repeat(n),
      }]));
      const positive = diffCoverageReport([{
        name: "coverage-ratchet",
        logTail: ${JSON.stringify(HEADER)} + "\\n  - /src/" + "a/".repeat(20_000) + "x.ts:12 -- remedy",
      }]);
      process.send({ reports, positive }, () => process.exit(0));
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const closed = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  const result = await new Promise<{ reports: unknown[]; positive: unknown }>((resolve, reject) => {
    // Test safety bounds: price parser execution only after the real module's ready message.
    // A deliberately restored exponential expression must fail, not hang the suite or leave a child.
    let timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the isolated real sweep module did not become ready within 20 seconds"));
    }, 20_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`the isolated parser exited before reporting: ${code}/${signal}`));
    });
    child.on("message", (message: { ready?: boolean; reports?: unknown[]; positive?: unknown }) => {
      clearTimeout(timer);
      if (message.ready) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("the real absolute-path parser did not finish its witness and positive control within 2 seconds"));
        }, 2_000);
        child.send({ run: true });
      } else {
        if (!message.reports) {
          reject(new Error("the child must report real parser results, not merely become ready"));
          return;
        }
        resolve({ reports: message.reports, positive: message.positive });
      }
    });
  });
  assert.deepEqual(result.reports, [
    { check: "coverage-ratchet", uncovered: [] },
    { check: "coverage-ratchet", uncovered: [] },
  ]);
  assert.deepEqual(result.positive, {
    check: "coverage-ratchet", uncovered: ["/src/" + "a/".repeat(20_000) + "x.ts:12"],
  });
  assert.equal((await closed)[0], 0, "the disposable parser child must exit normally on the fixed code");
});

test("the absolute-path parser retains repeated separators, dot names, Unicode, drives and glosses", () => {
  const accepted = [
    "/src/a.ts:12", "//src///a.ts:12", "/a/.ts:12", "/src/雪/é.tsx:47",
    "C:\\workspace\\src\\a.cts:9", "D:/workspace//src/a.mjsx:8", "/a\\b/file.js:3",
  ];
  for (const target of accepted) {
    const report = sweep.diffCoverageReport([{ name: "coverage-ratchet", logTail: HEADER + "\n  - " + target + " -- remedy" }]);
    assert.deepEqual(report?.uncovered, [target], target);
  }
  for (const target of ["/src/a.ts:not-a-line", "/src/a.txt:12", "/src/a.ts:12suffix", "/src/a b.ts:12"]) {
    const report = sweep.diffCoverageReport([{ name: "coverage-ratchet", logTail: HEADER + "\n  - " + target }]);
    assert.deepEqual(report?.uncovered, [], target);
  }
});
