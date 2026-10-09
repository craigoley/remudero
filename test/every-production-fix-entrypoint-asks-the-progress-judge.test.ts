// W1-T7096: the former fixed bound survives only as a stand-in for a caller that wires no judge.
// These tests drive the REAL entrypoint wiring (the daemon's sweep hooks and `rmd fix`) and assert
// that each one constructs the production progress judge, so no production path can silently fall
// back to the bound Craig ruled out. The stand-in itself must announce itself when it is used.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/lib/config.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildSweepEffects } from "../src/lib/sweep.js";
import { buildSweepHook, buildSweepLightHook, fixCommand, formerBoundStandIn } from "../src/run-task.js";
import { ghShim } from "./helpers/gh-shim.js";

type Row = { step: string; extra?: Record<string, unknown> };
const wiring = (rows: Row[]) => rows.filter((r) => r.step === "sweep.progress_judge_wiring").map((r) => r.extra?.judge);

async function withGh<T>(stdout: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t7096-entry-`));
  const shim = ghShim([{ when: "", stdout }], { kind: "t7096-entry-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    return await run(root);
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

test("W1-T7096: the daemon's full sweep hook wires the production progress judge", async () => {
  const rows: Row[] = [];
  await withGh("[]", async (root) => {
    const hook = buildSweepHook("o", "r", { root, claudeBin: "/bin/true" } as Config, join(root, "ledger.ndjson"),
      "DAEMON-T7096", { tasks: [], byId: new Map() } as never, (step, extra) => { rows.push({ step, extra }); });
    await hook();
  });
  assert.ok(wiring(rows).length > 0, `the hook built its sweep effects: ${JSON.stringify(rows.map((r) => r.step))}`);
  assert.deepEqual([...new Set(wiring(rows))], ["production"]);
});

test("W1-T7096: the daemon's light sweep hook wires the production progress judge", async () => {
  const rows: Row[] = [];
  await withGh("[]", async (root) => {
    const hook = buildSweepLightHook("o", "r", { root } as never, join(root, "ledger.ndjson"), "RUN-T7096",
      { tasks: [] } as never, (step, extra) => { rows.push({ step, extra }); },
      { loadedCodeSha: "boot-loaded-sha", isLoadedCodeAtOrAfter: () => false });
    await hook();
  });
  assert.ok(wiring(rows).length > 0, `the light hook built its sweep effects: ${JSON.stringify(rows.map((r) => r.step))}`);
  assert.deepEqual([...new Set(wiring(rows))], ["production"]);
});

test("W1-T7096: `rmd fix` wires the production progress judge", async () => {
  await withGh('{"contexts":[]}', async (root) => {
    mkdirSync(join(root, "state"), { recursive: true });
    const oldError = console.error;
    console.error = () => {};
    try {
      await fixCommand(["7096"], {
        config: { root, claudeBin: "/bin/true" } as Config,
        fetch: (args) => /\/pulls\/7096$/.test(args[1])
          ? { number: 7096, html_url: "https://github.com/o/r/pull/7096", state: "closed", merged: true,
              merged_at: "2026-10-09T00:00:00Z", body: "Remudero-Task: W1-T7096\n", updated_at: "2026-10-09T00:00:00Z",
              head: { ref: "run-W1-T7096-1", sha: "abc123" }, auto_merge: null }
          : /\/check-runs\?/.test(args[1]) ? { check_runs: [] } : { statuses: [] },
      });
    } finally {
      console.error = oldError;
    }
    const ledger = readFileSync(join(root, "state", "ledger.ndjson"), "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { step: string; judge?: string });
    const judges = ledger.filter((r) => r.step === "sweep.progress_judge_wiring").map((r) => r.judge);
    assert.ok(judges.length > 0, "rmd fix built its sweep effects");
    assert.deepEqual([...new Set(judges)], ["production"]);
  });
});

test("W1-T7096: sweep effects built without the opt-in say so in a ledger row", () => {
  const rows: Row[] = [];
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t7096-effects-`));
  try {
    const effects = buildSweepEffects({ owner: "o", repo: "r", config: { root } as Config,
      ledgerPath: join(root, "ledger.ndjson"), runId: "T7096", plan: { tasks: [] } as never,
      log: (step: string, extra?: Record<string, unknown>) => { rows.push({ step, extra }); } } as never);
    assert.equal(effects.fixProgressJudge, undefined, "no production judge was built");
    assert.deepEqual(wiring(rows), ["former_bound_stand_in"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T7096: the fixed-bound stand-in announces itself once, then decides by the former bound", async () => {
  const rows: Row[] = [];
  const said: string[] = [];
  let reached = false;
  const judge = formerBoundStandIn(() => reached, (step, extra) => { rows.push({ step, extra }); }, (line) => said.push(line));
  const input = {} as never;
  assert.equal((await judge(input))?.verdict, "continue");
  reached = true;
  assert.equal((await judge(input))?.verdict, "escalate");
  assert.deepEqual(rows.map((r) => r.step), ["fix.progress_judge_stand_in"]);
  assert.equal(said.length, 1);
  assert.match(said[0] ?? "", /former fixed bound/);
});
