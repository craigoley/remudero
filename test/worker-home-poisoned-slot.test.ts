import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workerHomeDir, type Config } from "../src/lib/config.js";
import { lostWorkerHomeGrants, materializeWorkerHome, perRunWorkerHomeDir } from "../src/lib/worker-home.js";
import { readUsageSnapshot } from "../src/run-task.js";
import { collectWorkerResult, workerLedgerFields, type WorkerResult } from "../src/lib/worker.js";

/** A minimal healthy WorkerResult — every field the projection reads, nothing lost. */
function baseResult(): WorkerResult {
  return {
    sessionId: "s", costUsd: 1, numTurns: 1, text: "", blocks: [], stderr: "", subtype: "success",
    isError: false, apiError: false, permissionDenials: [], childEnvKeys: [], model: "m", effort: "e",
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, modelUsage: {},
    compactionEvents: [], qualitySuspect: false,
  } as unknown as WorkerResult;
}

/**
 * A REAL DIRECTORY in a symlink slot won PERMANENTLY and SILENTLY. `unlinkSync` cannot remove a
 * directory (the catch comment named that case), the following `symlinkSync` threw EEXIST into a
 * best-effort catch, and nothing recorded either — so the grant was lost for the life of the
 * worker home and re-materialisation never healed it.
 *
 * MEASURED IN THE AZURE CONTAINER: `worker-home-usage-probe/.claude` was a DIRECTORY dated
 * 2026-08-09 01:55:59 while `.gitconfig` beside it was a symlink; the first `usage.probe_failed`
 * followed 346 ms later, and 33 of 33 probes read `stage: "parse"` against a 207-byte cost summary
 * instead of the account panel. The rc files were rewritten hours later, proving materialisation
 * ran again and did NOT heal it. It is container-specific for a real reason: `/home/node/Remudero`
 * is a persistent mounted volume while `/home/node/.claude` is rebuilt per container, so the
 * poisoned slot outlives the credential it shadows.
 */

function homes(): { workerHome: string; realHome: string } {
  const root = mkdtempSync(join(tmpdir(), "worker-home-poisoned-"));
  const workerHome = join(root, "worker-home-usage-probe");
  const realHome = join(root, "real-home");
  mkdirSync(realHome, { recursive: true });
  return { workerHome, realHome };
}

/** A real `~/.claude` holding the one file the A/B proved decisive. */
function realClaudeWithCredential(realHome: string, token = "tok-live"): string {
  const dir = join(realHome, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ token, subscriptionType: "max" }));
  return dir;
}

/** POISON the slot exactly as the container did: a real directory where the symlink belongs. */
function poison(workerHome: string): string {
  const dir = join(workerHome, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.local.json"), "{}"); // what the CLI itself writes there
  return dir;
}

// ── THIRD TRAP: the poisoned state must be REPRODUCIBLE, or the test cannot see the defect ──

test("a REAL DIRECTORY in the slot is displaced and the grant is restored — the fixture reproduces the poisoning", () => {
  const { workerHome, realHome } = homes();
  const realClaude = realClaudeWithCredential(realHome);
  const poisoned = poison(workerHome);

  // The fixture really is poisoned before materialisation — a clean slot cannot see this defect.
  assert.equal(lstatSync(poisoned).isDirectory(), true);
  assert.equal(lstatSync(poisoned).isSymbolicLink(), false, "a real directory, not a link");

  const plan = materializeWorkerHome({ workerHome, realHome });
  const slot = join(workerHome, ".claude");

  assert.equal(lstatSync(slot).isSymbolicLink(), true, "the slot is a symlink again");
  assert.equal(readlinkSync(slot), realClaude, "and it points at the real grant");

  const outcome = plan.outcomes?.find((o) => o.relFrom === ".claude");
  assert.equal(outcome?.state, "displaced", "and the heal is RECORDED, not silent");
  assert.ok(outcome?.displacedTo, "naming where the poisoning went");
  assert.equal(existsSync(outcome!.displacedTo!), true, "which is KEPT, never deleted — it is the only evidence");
  assert.equal(
    readFileSync(join(outcome!.displacedTo!, "settings.local.json"), "utf8"),
    "{}",
    "with its contents intact for inspection",
  );
});

// ── THE TRAP: prove the healed slot actually REACHES the credential, not merely that a link exists ──

test("THE TRAP: reading THROUGH the healed slot returns the credential — a symlink that resolves to nothing proves nothing", () => {
  const { workerHome, realHome } = homes();
  realClaudeWithCredential(realHome, "tok-through-the-link");
  poison(workerHome);

  // BEFORE: the poisoned slot shadows the real grant — exactly the container's A/B, where the
  // only difference between a 207-byte cost summary and a full account panel was whether
  // `.claude/.credentials.json` was reachable from the home the probe constructs.
  const credThroughSlot = join(workerHome, ".claude", ".credentials.json");
  assert.equal(existsSync(credThroughSlot), false, "poisoned: the credential is UNREACHABLE from this home");

  materializeWorkerHome({ workerHome, realHome });

  // AFTER: a real read through the slot — the filesystem resolving the link, not an assertion
  // about the link's existence.
  assert.equal(existsSync(credThroughSlot), true, "healed: the credential is reachable");
  const parsed = JSON.parse(readFileSync(credThroughSlot, "utf8")) as { token: string; subscriptionType: string };
  assert.equal(parsed.token, "tok-through-the-link", "and it is the REAL credential, read through the link");
  assert.equal(parsed.subscriptionType, "max");

  // And a process with HOME redirected here resolves it too — the thing the CLI actually does.
  const seen = execFileSync(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(require('path').join(process.env.HOME,'.claude','.credentials.json'),'utf8'))"], {
    env: { ...process.env, HOME: workerHome },
    encoding: "utf8",
  });
  assert.match(seen, /tok-through-the-link/, "a child resolving $HOME/.claude reads the real credential");
});

// ── SECOND TRAP: the absent-target skip is correct and must stay silent ──

test("SECOND TRAP: an ABSENT target is still skipped SILENTLY — the mini legitimately lacks several grants", () => {
  const { workerHome, realHome } = homes();
  // No `.claude` in the real home at all: the grant is genuinely unavailable.
  const plan = materializeWorkerHome({ workerHome, realHome });

  const outcome = plan.outcomes?.find((o) => o.relFrom === ".claude");
  assert.equal(outcome?.state, "absent", "absent is its OWN state, never conflated with failed");
  assert.equal(outcome?.reason, undefined, "and carries no failure reason, because nothing failed");
  assert.equal(existsSync(join(workerHome, ".claude")), false, "nothing is created for an absent grant");

  const lost = (plan.outcomes ?? []).filter((o) => o.state === "failed" || o.state === "displaced");
  assert.deepEqual(lost, [], "an absent grant must never reach the loud path");
});

test("a healthy slot is `linked` on first materialisation and `already` on the second — the common paths stay quiet", () => {
  const { workerHome, realHome } = homes();
  realClaudeWithCredential(realHome);

  const first = materializeWorkerHome({ workerHome, realHome });
  assert.equal(first.outcomes?.find((o) => o.relFrom === ".claude")?.state, "linked");

  const second = materializeWorkerHome({ workerHome, realHome });
  assert.equal(second.outcomes?.find((o) => o.relFrom === ".claude")?.state, "already", "idempotent, and not re-displaced");

  // Neither run reports a loss — this is what keeps a per-spawn path from becoming chatty.
  for (const plan of [first, second]) {
    assert.deepEqual((plan.outcomes ?? []).filter((o) => o.state === "failed" || o.state === "displaced"), []);
  }
});

test("a STALE symlink pointing elsewhere is still re-pointed, and reports `linked` rather than `displaced`", () => {
  const { workerHome, realHome } = homes();
  const realClaude = realClaudeWithCredential(realHome);
  const elsewhere = join(realHome, "somewhere-else");
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(workerHome, { recursive: true });
  symlinkSync(elsewhere, join(workerHome, ".claude"));

  const plan = materializeWorkerHome({ workerHome, realHome });
  assert.equal(readlinkSync(join(workerHome, ".claude")), realClaude, "re-pointed at the real grant");
  assert.equal(
    plan.outcomes?.find((o) => o.relFrom === ".claude")?.state,
    "linked",
    "a stale LINK is ordinary debris, not a displaced directory — the two must not be conflated",
  );
});

// ── The grant loss must REACH THE LEDGER, through the probe's own existing sink ──
//
// The probe reported `stage: "parse"` 33 times out of 33 and named the symptom (no
// `Current session:` line) rather than the cause. `"grant"` is a THIRD stage on purpose: the
// stage union's own doc records that conflating spawn with parse "cost this fleet its headroom
// read for hours", and a lost grant is a third, distinct thing again.

test("the usage probe reports a DISPLACED grant through its own failure sink, naming the slot", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-usage-grant-"));
  const config = { claudeBin: "/bin/true", root } as unknown as Config;
  const realHome = process.env.HOME ?? "";

  // Poison the exact home the probe constructs, the way the container's was poisoned.
  const workerHome = perRunWorkerHomeDir(workerHomeDir(config), "usage-probe");
  mkdirSync(join(workerHome, ".claude"), { recursive: true });
  writeFileSync(join(workerHome, ".claude", "settings.local.json"), "{}");
  assert.equal(existsSync(join(realHome, ".claude")), true, "this host really has the grant to lose");

  const calls: Array<{ stage: string; reason: string }> = [];
  readUsageSnapshot(config, () => "no panel here", (stage, reason) => calls.push({ stage, reason }));

  const grant = calls.find((c) => c.stage === "grant");
  assert.ok(grant, "the lost/healed grant is REPORTED — it was silent, which is why the cause took days");
  assert.match(grant!.reason, /^\.claude:/, "and names the slot it healed");
  assert.match(grant!.reason, /displaced to /, "and where the poisoning went");

  // The absent-target grants on this host stay silent — the loud path is for losses only.
  assert.equal(calls.filter((c) => c.stage === "grant").length, 1, "one grant event, not one per symlink");
});

test("a grant that genuinely CANNOT be created reports `failed`, distinct from `absent`", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-home-failed-"));
  const workerHome = join(root, "wh");
  const realHome = join(root, "real");
  mkdirSync(join(realHome, ".config", "gh"), { recursive: true }); // the target EXISTS
  // Lock the PARENT of the link path (not the home itself, or the rc writes fail first and the
  // function throws before any grant is attempted). `symlinkSync` into it then fails for real —
  // a REAL EACCES, never a stubbed error: a fabricated failure is indistinguishable from the
  // thing under test, which is the whole defect one level up.
  mkdirSync(join(workerHome, ".config"), { recursive: true });
  chmodSync(join(workerHome, ".config"), 0o500);
  try {
    const plan = materializeWorkerHome({ workerHome, realHome });
    const outcome = plan.outcomes?.find((o) => o.relFrom === join(".config", "gh"));
    assert.equal(outcome?.state, "failed", "the target EXISTS and we could not reach it — a loss, not an option");
    assert.ok(outcome?.reason, "carrying the error's own message, never a guess");
    assert.notEqual(outcome?.state, "absent", "and never conflated with the silent optional-grant skip");
  } finally {
    chmodSync(join(workerHome, ".config"), 0o700);
  }
});

// ── spawnWorker's own half: the loss must reach the VERDICT ROW, not stop at the result ──
//
// worker.ts writes no ledger rows by design, so the fact rides `WorkerResult` and
// `workerLedgerFields` projects it onto the verdict row every caller already writes — one
// wiring, five call sites in run-task.ts. NO NEW ROWS: one field on a row that exists.

test("workerLedgerFields carries a lost grant onto the verdict row, naming the slot and the cause", () => {
  const withLoss = {
    ...baseResult(),
    lostGrants: [
      { relFrom: ".claude", to: "/real/.claude", state: "failed" as const, reason: "EACCES: permission denied" },
      { relFrom: ".config/gh", to: "/real/.config/gh", state: "displaced" as const, displacedTo: "/wh/.config/gh.displaced-1" },
    ],
  };
  const row = workerLedgerFields(withLoss);
  assert.deepEqual(row.lost_grants, [
    ".claude: EACCES: permission denied",
    ".config/gh: displaced to /wh/.config/gh.displaced-1",
  ]);
});

test("a healthy run adds NO field at all — the common case must not grow the row", () => {
  const clean = workerLedgerFields(baseResult());
  assert.equal("lost_grants" in clean, false, "absent, not an empty array: a healthy run says nothing");

  const emptied = workerLedgerFields({ ...baseResult(), lostGrants: [] });
  assert.equal("lost_grants" in emptied, false, "an empty list is also silence, never a rendered []");
});

test("collectWorkerResult mirrors the grants verbatim and omits them when there are none", async () => {
  const envelope = (async function* () {
    yield { type: "result", subtype: "success", result: "ok", usage: {} };
  })();
  const lost = [{ relFrom: ".claude", to: "/real/.claude", state: "failed" as const, reason: "EACCES" }];
  const withLoss = await collectWorkerResult(envelope, { childEnvKeys: [], lostGrants: lost });
  assert.deepEqual(withLoss.lostGrants, lost, "mirrored verbatim, never re-derived");

  const envelope2 = (async function* () {
    yield { type: "result", subtype: "success", result: "ok", usage: {} };
  })();
  const clean = await collectWorkerResult(envelope2, { childEnvKeys: [] });
  assert.equal("lostGrants" in clean, false, "omitted entirely when nothing was lost");
});

test("lostWorkerHomeGrants reports ONLY losses and heals — an absent grant must never reach the loud path", () => {
  // The mini legitimately lacks several grants. If `absent` were reported, every spawn there
  // would carry noise on its verdict row and the signal would be worthless within a day.
  const plan = {
    workerHome: "/wh",
    rcFiles: [],
    symlinks: [],
    outcomes: [
      { relFrom: ".claude", to: "/r/.claude", state: "absent" as const },
      { relFrom: ".gitconfig", to: "/r/.gitconfig", state: "linked" as const },
      { relFrom: ".config/gh", to: "/r/.config/gh", state: "already" as const },
      { relFrom: "Library/Keychains/login.keychain-db", to: "/r/k", state: "failed" as const, reason: "EACCES" },
      { relFrom: ".npmrc", to: "/r/.npmrc", state: "displaced" as const, displacedTo: "/wh/.npmrc.displaced-1" },
    ],
  };
  const lost = lostWorkerHomeGrants(plan);
  assert.deepEqual(lost.map((g) => g.relFrom), ["Library/Keychains/login.keychain-db", ".npmrc"]);
  assert.equal(lost.some((g) => g.state === "absent"), false, "absent is silence, not a loss");
  assert.equal(lost.some((g) => g.state === "linked" || g.state === "already"), false, "nor are the healthy states");
});
