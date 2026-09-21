import assert from "node:assert/strict";
import { test } from "node:test";

import { judgeCashSpendability } from "../src/lib/doctor.js";

test("cash fallback configured but unspendable: key is absent", () => {
  const check = judgeCashSpendability({ configured: true, keyPresent: false });
  assert.equal(check.name, "cash-spendability");
  assert.equal(check.verdict, "FAIL");
  assert.match(check.measured, /unspendable/);
  assert.match(check.measured, /key is absent/);
});

test("a configured cash fallback with a key is spendable, while a disabled fallback is not a fault", () => {
  assert.equal(judgeCashSpendability({ configured: true, keyPresent: true }).verdict, "OK");
  assert.equal(judgeCashSpendability({ configured: false, keyPresent: false }).verdict, "OK");
});

test("doctor reads key presence once and never renders its value", async () => {
  const { doctorCommand } = await import("../src/run-task.js");
  const rendered: string[] = [];
  const secret = "must-never-appear-in-doctor-output";
  let reads = 0;
  await doctorCommand([], {
    out: (line) => rendered.push(line),
    loadConfig: () => ({ root: "/nonexistent-cash-doctor-root", workerProviders: { enabled: ["cash"], cashFallbackWhenBlocked: true } }) as never,
    nowMs: Date.parse("2026-09-20T12:00:00Z"),
    readLedgerLines: () => [],
    readMemInfo: () => ({ availableBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, swapTotalBytes: 2 * 1024 ** 3 }),
    readDiskFreeBytes: () => 40 * 1024 ** 3,
    readDiskTotalBytes: () => 80 * 1024 ** 3,
    readPauseAgeMs: () => undefined,
    readGitLocks: () => [],
    readCheckoutDepth: () => ({ shallow: false, commitCount: 1000 }),
    readNvmrcVersion: () => process.versions.node,
    readProviderRoutingStatus: () => ({ providers: [] }) as never,
    readCashKey: () => {
      reads++;
      return secret;
    },
  });
  assert.equal(reads, 1, "a green spendability reading must consult the key exactly once");
  assert.match(rendered.join("\n"), /cash fallback configured and spendable/);
  assert.doesNotMatch(rendered.join("\n"), new RegExp(secret));
});
