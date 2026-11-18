import assert from "node:assert/strict";
import { test } from "node:test";

import { CONSOLE_SHA_UNKNOWN, gateStaleCodeExit, type StaleCodeExitDeps } from "#src/lib/serve.js";

// W1-T13615: a supervised generation pins its plan at the boot sha at once. Before this, no thread had a pin until main's
// next plan change, so the views, board and slow-lane threads each re-stat every plan shard on every pass: 37 ms of CPU
// per pass over 5,689 shards on the host on 2026-11-18, for the first 29 minutes after a boot.

const BOOT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function gate(extra: Partial<StaleCodeExitDeps>) {
  const reloads: string[] = [];
  const exits: number[] = [];
  const g = gateStaleCodeExit({
    bootSha: BOOT,
    resolveCurrentSha: () => extra.bootSha ?? BOOT,
    exit: (code) => exits.push(code),
    scheduleRecheck: () => () => {},
    reloadPlan: async (ref) => (reloads.push(ref), true),
    ...extra,
  });
  return { g, reloads, exits };
}

test("W1-T13615 criterion 1: a supervised generation reloads its plan at the boot sha when the gate is built, before any re-check", async () => {
  const { reloads } = gate({ pinBootPlan: true });
  await settle();
  assert.deepEqual(reloads, [BOOT], "the pin is published at construction, not after main's next plan change");
});

test("W1-T13615 criterion 2: an unsupervised serve, or one whose boot sha is unknown, pins nothing at boot", async () => {
  const plain = gate({});
  const unknown = gate({ pinBootPlan: true, bootSha: CONSOLE_SHA_UNKNOWN });
  await settle();
  assert.deepEqual(plain.reloads, [], "a serve outside a generation keeps following its working-tree files");
  assert.deepEqual(unknown.reloads, [], "an unknown sha is not a ref git can read");
});

test("W1-T13615 criterion 3: the boot pin loads once, and a later plan-only advance still reloads at the new sha", async () => {
  const { g, reloads, exits } = gate({ pinBootPlan: true, resolveCurrentSha: () => NEW, resolveCommitsBehind: () => 1, changedPathsSince: () => ({ changedPaths: ["plan/tasks.d/W1-T9-x.yaml"] }) });
  await settle();
  await g.recheck();
  await settle();
  await g.recheck();
  await settle();
  assert.deepEqual(reloads, [BOOT, NEW], "the boot pin is not reloaded every minute, and main's plan change still lands");
  assert.deepEqual(exits, [], "a plan-only advance never restarts serve");
});
