// W1-T3718: THE FIX RUNG COULD NOT SPAWN AND NOTHING SAID SO. Measured 2026-09-17: every provider
// refused, both paid rungs were switched off, and the only trace was one `fix.spawn_infra_blocked`
// row among 731 -- the operator's sole symptom was red PRs that stopped moving. These tests hold the
// four things that make such a stall visible and decidable: one durable fleet state, surfaced with
// its age, that tells a FULL provider from one that CANNOT BE ASKED, and clears on the first spawn
// that works -- plus a verb that prices the paid rungs and never switches one on.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { buildServeServer, type ServeDeps } from "../src/lib/serve.js";
import { repairLadderCommand, trackRepairLadder } from "../src/lib/sweep.js";
import type { SpawnWorkerArgs } from "../src/lib/worker.js";
import {
  ProviderCapacityBlockedError,
  claudeCapacityFromUsage,
  providerRefusalCondition,
  readRepairLadderState,
  repairLadderStatePath,
  selectCodexModel,
  type ProviderCapacity,
} from "../src/lib/worker-provider.js";

const READ_TOKEN = "repair-ladder-read-token";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rmd-repair-ladder-"));
  mkdirSync(join(root, "state"), { recursive: true });
  return root;
}

function configFor(root: string, extra: Partial<Config> = {}): Config {
  return { claudeBin: "/bin/true", root, workerProviders: { enabled: ["claude", "codex"] }, ...extra } as Config;
}

/** The two readings the 2026-09-17 ledger carried: a Claude probe that never answered, and a Codex
 *  account that answered and was below its reserve. */
const CANNOT_BE_ASKED: ProviderCapacity = claudeCapacityFromUsage(undefined);
const FULL: ProviderCapacity = {
  provider: "codex",
  readable: false,
  exhausted: true,
  windows: [{ name: "codex primary", usedPercent: 98 }],
  detail: "balanced Codex models have no reserved headroom",
};

function blocked(): ProviderCapacityBlockedError {
  return new ProviderCapacityBlockedError([CANNOT_BE_ASKED, FULL]);
}

function recorder(): { rows: Array<{ step: string; extra?: Record<string, unknown> }>; log: (step: string, extra?: Record<string, unknown>) => void } {
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  return { rows, log: (step, extra) => rows.push({ step, extra }) };
}

const FIX_ARGS = { cwd: "/nowhere", prompt: "fix", tools: ["Read", "Edit", "Bash"] } as unknown as SpawnWorkerArgs;

test("a stalled repair ladder is one fleet state, not a per-attempt line", async () => {
  const root = fixtureRoot();
  const ledger = recorder();
  let clock = Date.parse("2026-09-17T01:18:55.000Z");
  const refused = blocked();
  const spawn = trackRepairLadder(async () => { throw refused; }, { config: configFor(root), log: ledger.log, now: () => clock });

  // Three refused strikes across ninety minutes: the per-attempt shape this task replaces.
  for (const stepMs of [0, 45 * 60_000, 45 * 60_000]) {
    clock += stepMs;
    await assert.rejects(spawn(FIX_ARGS), (error) => error === refused, "the refusal propagates unchanged");
  }

  const record = JSON.parse(readFileSync(repairLadderStatePath(root), "utf8"));
  assert.equal(record.since, "2026-09-17T01:18:55.000Z", "ONE state: the first-seen instant survives every later refusal");
  assert.equal(record.lastSeen, "2026-09-17T02:48:55.000Z");
  assert.equal("count" in record || "refusals" in record, false, "no refusal count -- the shape nobody read");
  assert.deepEqual(record.fallbacks.map((f: { rung: string }) => f.rung), ["cash", "overflow"]);
  assert.match(record.fallbacks[0].refusal, /cashFallbackWhenBlocked/);
  assert.match(record.fallbacks[1].refusal, /overflow/);
  assert.deepEqual(
    ledger.rows.filter((row) => row.step === "repair_ladder.stalled").length,
    1,
    "the fleet state is announced once when it begins, not once per attempt",
  );

  // A refusal that is NOT "no provider would take the work" is a per-spawn fault, not this state.
  const otherRoot = fixtureRoot();
  const other = trackRepairLadder(async () => { throw new Error("worktree vanished"); }, { config: configFor(otherRoot), log: () => {} });
  await assert.rejects(other(FIX_ARGS), /worktree vanished/);
  assert.equal(existsSync(repairLadderStatePath(otherRoot)), false);
});

test("the stalled ladder reaches the status surface with its age", async () => {
  const root = fixtureRoot();
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "");
  const since = Date.now() - 95 * 60_000;
  writeFileSync(repairLadderStatePath(root), JSON.stringify({
    version: 1,
    since: new Date(since).toISOString(),
    lastSeen: new Date(since + 60_000).toISOString(),
    reason: blocked().message,
    providers: [{ provider: "claude", condition: "cannot-be-asked", detail: "capacity unreadable" }],
    fallbacks: [{ rung: "cash", refusal: "operator has not enabled workerProviders.cashFallbackWhenBlocked" }],
  }));
  const github = { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined, readFailed: () => false };
  const deps = {
    board: { plan: { tasks: [], byId: new Map() }, ledgerPath, github },
    panelGraph: { root, planPath: join(root, "tasks.yaml"), ledgerPath, github: { prView: () => null }, statusGithub: github, ratify: { approve() {}, reframe() {} } },
    ledgerPath,
    issues: { close() {} },
    fleetControlRoot: root,
    questionsRoot: root,
    tokens: { read: READ_TOKEN, write: "repair-ladder-write-token" },
    daemonHealth: { exec: () => "{}", statfs: () => ({ bavail: 1, bsize: 1 }) },
    githubAppRefresh: { start: () => ({ armed: false }) },
    log: () => {},
  } as unknown as ServeDeps;
  const server = buildServeServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/v1/status", "/v1/daemon-health"]) {
      const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
      assert.equal(response.status, 200, path);
      const body = (await response.json()) as { repairLadder?: { state: string; ageMs: number; downFor: string; since: string; infrastructureFault: boolean } };
      assert.equal(body.repairLadder?.state, "stalled", `${path} says the repair ladder is down`);
      assert.equal(body.repairLadder?.since, new Date(since).toISOString());
      assert.ok((body.repairLadder?.ageMs ?? 0) >= 95 * 60_000, `${path} says for how long`);
      assert.match(body.repairLadder?.downFor ?? "", /^1h 3[5-9]m$/);
      assert.equal(body.repairLadder?.infrastructureFault, true);
    }
  } finally {
    server.close();
  }
});

test("an unreadable capacity probe is not reported as no headroom", () => {
  // The Claude probe that never answered, and the Codex account that answered FULL.
  assert.equal(providerRefusalCondition(CANNOT_BE_ASKED), "cannot-be-asked");
  assert.equal(providerRefusalCondition(FULL), "full");
  const message = blocked().message;
  assert.match(message, /claude=cannot be asked \(capacity unreadable\)/);
  assert.match(message, /codex=full \(balanced Codex models have no reserved headroom\)/);

  // The Codex selector itself used to say "no reserved headroom" for a quota it could not READ.
  const models = [{ id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }];
  const config = { claudeBin: "/unused", root: "/tmp", workerProviders: { enabled: ["codex"] as Array<"codex">, codexModel: "gpt-5.6-terra" } };
  const unreadable = selectCodexModel(models, { rateLimitsByLimitId: { terra: { limitId: "terra", limitName: "GPT-5.6-Terra", primary: null } } }, config, undefined, "medium");
  assert.equal(unreadable.readable, false);
  assert.doesNotMatch(unreadable.detail ?? "", /no reserved headroom/, "an unreadable quota is not a full one");
  assert.match(unreadable.detail ?? "", /quota is unreadable/);
  assert.equal(providerRefusalCondition(unreadable), "cannot-be-asked");

  const exhausted = selectCodexModel(models, { rateLimitsByLimitId: { terra: { limitId: "terra", limitName: "GPT-5.6-Terra", primary: { usedPercent: 99 } } } }, config, undefined, "medium");
  assert.match(exhausted.detail ?? "", /no reserved headroom/);
  assert.equal(providerRefusalCondition(exhausted), "full");
});

test("a successful spawn clears the stalled ladder state", async () => {
  const root = fixtureRoot();
  const ledger = recorder();
  let refuse = true;
  let clock = Date.parse("2026-09-17T01:18:55.000Z");
  const spawn = trackRepairLadder(async () => {
    if (refuse) throw blocked();
    return "worker ran";
  }, { config: configFor(root), log: ledger.log, now: () => clock });

  await assert.rejects(spawn(FIX_ARGS));
  assert.equal(readRepairLadderState(root, clock).state, "stalled");

  // Provider capacity recovers on its own -- no restart, no config change.
  refuse = false;
  clock += 90 * 60_000;
  assert.equal(await spawn(FIX_ARGS), "worker ran");
  assert.deepEqual(readRepairLadderState(root, clock), { state: "running" });
  const recovered = ledger.rows.find((row) => row.step === "repair_ladder.recovered");
  assert.equal(recovered?.extra?.down_ms, 90 * 60_000);

  // The NEXT stall is a new one, with its own first-seen instant.
  refuse = true;
  clock += 60_000;
  await assert.rejects(spawn(FIX_ARGS));
  const next = readRepairLadderState(root, clock);
  assert.equal(next.state === "stalled" ? next.since : undefined, new Date(clock).toISOString());
});

test("the ladder verb prices the rungs and flips nothing", () => {
  const root = fixtureRoot();
  const configPath = join(root, "config.json");
  const config = Object.freeze(configFor(root, { dailyCapUsd: 20, workerProviders: { enabled: ["claude", "codex", "cash"] } }));
  const bytes = `${JSON.stringify(config)}\n`;
  writeFileSync(configPath, bytes);
  const snapshot = JSON.stringify(config);

  const printed: string[] = [];
  const exit = repairLadderCommand(["--json"], { config, fixTools: ["Read", "Edit", "Bash"], env: {}, print: (line) => printed.push(line) });
  assert.equal(exit, 0);
  const report = JSON.parse(printed[0]) as { ladder: { state: string }; rungs: Array<Record<string, unknown>> };
  assert.equal(report.ladder.state, "running");
  const [cash, overflow] = report.rungs;
  assert.equal(cash.rung, "cash");
  assert.equal(cash.armed, false);
  assert.equal(cash.switchSetting, "workerProviders.cashFallbackWhenBlocked: true");
  assert.equal(cash.dailyCeilingUsd, 20);
  assert.match(String(cash.price), /\$20\/UTC day/);
  assert.match(String(cash.stillBlockedBy), /tool surface/, "priced honestly: the switch alone would not arm the fix lane");
  assert.equal(overflow.rung, "overflow");
  assert.equal(overflow.switchSetting, 'overflow: "api_key"');
  assert.equal(overflow.dailyCeilingUsd, 20);
  assert.match(String(overflow.stillBlockedBy), /ANTHROPIC_API_KEY/);

  const text: string[] = [];
  assert.equal(repairLadderCommand([], { config, fixTools: ["Read"], env: {}, print: (line) => text.push(line) }), 0);
  assert.match(text.join("\n"), /changes nothing/);

  // FLIPS NOTHING: the config it read is byte-identical, in memory and on disk, and no rung armed.
  assert.equal(JSON.stringify(config), snapshot);
  assert.equal(readFileSync(configPath, "utf8"), bytes);
  assert.equal(config.workerProviders?.cashFallbackWhenBlocked, undefined);
  assert.equal(config.overflow, undefined);
  assert.equal(repairLadderCommand(["--enable"], { config, fixTools: undefined, print: () => {} }), 2, "there is no enabling flag");
});
