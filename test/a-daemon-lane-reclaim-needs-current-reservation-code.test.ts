import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fixedClock } from "../src/lib/clock.js";
import { appendLedger } from "../src/lib/ledger.js";
import { LEDGER_FILENAME } from "../src/lib/ledger-path.js";
import * as reservation from "../src/lib/task-id-reservation.js";
import * as runTask from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

// @source-text-subject: the production construction census enforces which factory each lane uses.
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const AGE = 3 * 60 * 60 * 1000;
const clock = fixedClock(NOW);
const lanes = ["triage", "plan", "approve", "approve-batch", "ci-learning", "plan-repair", "next-task-id-prefix"];
const currencies: reservation.ReservationPolicyCurrency[] = [
  { status: "differs", loaded: "old", main: "new" },
  { status: "unprovable", reason: "origin/main unreadable" },
  { status: "current" },
];

function origin(opts: { fresh?: boolean; pushError?: string; free?: boolean; heldId?: string } = {}) {
  const pushes: string[] = [];
  const message = reservation.formatReservationHolderLine({
    branch: "abandoned-filer", pid: 7, host: "old-host",
    startedAt: new Date(NOW - (opts.fresh ? 21_000 : AGE)).toISOString(),
  });
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const run: reservation.RemoteReserveDeps["run"] = (args) => {
    if (args[0] === "remote") return ok("/tmp/local-origin.git\n");
    if (args[0] === "hash-object") return ok("TREE\n");
    if (args[0] === "commit-tree") return ok(args.includes("-p") ? "RECLAIMED\n" : "ANCHOR\n");
    if (args[0] === "fetch") return ok();
    if (args[0] === "log") return ok(message);
    if (args[0] === "ls-remote") return args.includes("--heads") && !args.some((arg) => arg.startsWith("run-"))
      ? { status: 2, stdout: "", stderr: "" } : ok();
    if (args[0] === "push") {
      const refspec = args[2]!;
      pushes.push(refspec);
      if (opts.pushError) return { status: 1, stdout: "", stderr: opts.pushError };
      if (!opts.free && refspec === `ANCHOR:refs/rmd-id/${opts.heldId ?? "W1-T6075"}`) {
        return { status: 1, stdout: "", stderr: "rejected (already exists)" };
      }
      return ok();
    }
    throw new Error(`unexpected git invocation: ${args.join(" ")}`);
  };
  return { run, pushes };
}

function factory(deps: reservation.RemoteReserveDeps & {
  lane: string; log?: (step: string, fields: Record<string, unknown>) => void;
}): reservation.RemoteRefReserver {
  const gated = (reservation as typeof reservation & {
    gatedRemoteRefReserver?: (d: typeof deps) => reservation.RemoteRefReserver;
  }).gatedRemoteRefReserver;
  assert.equal(typeof gated, "function", "the gated production factory must exist");
  return gated!(deps);
}

test("test/a-daemon-lane-reclaim-needs-current-reservation-code.test.ts", async (t) => {
  for (const lane of lanes) for (const currency of currencies) {
    await t.test(`${lane}: ${currency.status} policy controls takeover and its durable row`, () => {
      const remote = origin();
      const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w6075-ledger-`));
      const ledger = join(dir, "ledger.ndjson");
      const rows: Record<string, unknown>[] = [];
      try {
        const reserver = factory({
          run: remote.run, lane, filingBranch: `file-${lane}`, clock, anchor: () => "ANCHOR",
          say: () => {}, policyCurrency: () => currency,
          log: (step, fields) => {
            const row = { run_id: "w6075", task_id: "W1-T6075", step, ...fields };
            rows.push(row);
            appendLedger(ledger, row);
          },
        });
        const held = reservation.reserveTaskIdRemote(6075, reserver);
        if (currency.status === "current") {
          assert.equal(held.taskId, "W1-T6075");
          assert.deepEqual(remote.pushes, ["ANCHOR:refs/rmd-id/W1-T6075", "RECLAIMED:refs/rmd-id/W1-T6075"]);
          assert.deepEqual(rows, [{
            run_id: "w6075", step: "reservation.taken_over", lane,
            task_id: "W1-T6075", ref: "refs/rmd-id/W1-T6075", taken_over_from: "abandoned-filer",
            holder_pid: 7, holder_host: "old-host", holder_started_at: new Date(NOW - AGE).toISOString(), age_ms: AGE,
          }]);
          const stored = readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
          assert.equal(stored.length, 1);
          for (const [key, value] of Object.entries(rows[0]!)) assert.equal(stored[0][key], value);
        } else {
          assert.equal(held.taskId, "W1-T6076", "stale or unprovable code must advance to a free id");
          assert.deepEqual(remote.pushes, ["ANCHOR:refs/rmd-id/W1-T6075", "ANCHOR:refs/rmd-id/W1-T6076"]);
          assert.deepEqual(rows, []);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  await t.test("the default arm really checks the installed module with real git", () => {
    const remote = origin();
    const expected = reservation.reservationPolicyCurrency().status === "current";
    const rows: string[] = [];
    const reserver = factory({ run: remote.run, lane: "default", filingBranch: "file-default", clock,
      say: () => {}, log: (step) => { rows.push(step); } });
    assert.equal(reserver.reclaim!("W1-T6075"), expected ? "created" : "taken");
    assert.deepEqual(remote.pushes, expected ? ["RECLAIMED:refs/rmd-id/W1-T6075"] : []);
    assert.deepEqual(rows, expected ? ["reservation.taken_over"] : []);
  });

  await t.test("fresh holders, free ids and failed takeover pushes emit no takeover row", () => {
    for (const opts of [{ fresh: true }, { free: true }, { pushError: "connection refused" }]) {
      const remote = origin(opts);
      const rows: string[] = [];
      const reserver = factory({ run: remote.run, lane: "plan", filingBranch: "file-plan", clock,
        anchor: () => "ANCHOR", say: () => {}, policyCurrency: () => ({ status: "current" }),
        log: (step) => { rows.push(step); } });
      if (opts.free) assert.equal(reservation.reserveTaskIdRemote(6075, reserver).taskId, "W1-T6075");
      else assert.equal(reserver.reclaim!("W1-T6075"), opts.fresh ? "taken" : "unreachable");
      assert.deepEqual(rows, []);
    }
    const remote = origin();
    assert.equal(factory({ run: remote.run, lane: "optional-log", filingBranch: "file-plan", clock,
      say: () => {}, policyCurrency: () => ({ status: "current" }) }).reclaim!("W1-T6075"), "created");
  });

  for (const currency of currencies) await t.test(`--prefix uses the gate with ${currency.status} policy`, async () => {
    const remote = origin({ heldId: "X-T1" });
    const out: string[] = [];
    const rows: Record<string, unknown>[] = [];
    const saved = { log: console.log, error: console.error };
    let disposed = false;
    console.log = (...args) => { out.push(args.join(" ")); };
    console.error = (...args) => { out.push(args.join(" ")); };
    try {
      // The real clock is avoided by naming main, which is takeover-eligible at every age.
      const run: reservation.RemoteReserveDeps["run"] = (args) => args[0] === "log"
        ? { status: 0, stdout: reservation.formatReservationHolderLine({ branch: "main" }), stderr: "" }
        : remote.run(args);
      const code = await runTask.nextTaskIdCommand(["--prefix", "X", "--repo", "acme/target", "--branch", "file-prefix"], {}, {
        openTargetRepo: () => ({ run, planTexts: [], dispose: () => { disposed = true; } }),
        openPrTexts: () => [], policyCurrency: () => currency,
        log: (step, fields) => { rows.push({ step, ...fields }); },
      });
      assert.equal(code, 0, out.join("\n"));
      const reserved = out.filter((line) => line.startsWith("RESERVED "));
      assert.equal(reserved.length, 1);
      if (currency.status === "current") {
        assert.match(reserved[0]!, /RESERVED X-T1.*TAKEN OVER from main/);
        assert.deepEqual(rows, [{ step: "reservation.taken_over", lane: "next-task-id-prefix",
          task_id: "X-T1", ref: "refs/rmd-id/X-T1", taken_over_from: "main",
          holder_pid: null, holder_host: null, holder_started_at: null, age_ms: null }]);
      } else {
        assert.match(reserved[0]!, /^RESERVED X-T2 /);
        assert.ok(!reserved[0]!.includes("TAKEN OVER"));
        assert.deepEqual(rows, []);
        assert.ok(remote.pushes.every((push) => !push.startsWith("RECLAIMED:")));
      }
      assert.equal(disposed, true);
    } finally { console.log = saved.log; console.error = saved.error; }
  });

  for (const config of ["valid", "unreadable"]) await t.test(`--prefix default ledger sink with ${config} config`, async (t) => {
    const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w6075-config-`));
    const root = join(home, "instance");
    mkdirSync(join(home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(home, ".config", "remudero", "config.json"), config === "valid"
      ? JSON.stringify({ claudeBin: "/usr/bin/true", root }) : "{broken json");
    t.mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    const remote = origin({ heldId: "X-T1" });
    const saved = { log: console.log, error: console.error };
    const errors: string[] = [];
    console.log = () => {};
    console.error = (...args) => { errors.push(args.join(" ")); };
    try {
      const run: reservation.RemoteReserveDeps["run"] = (args) => args[0] === "log"
        ? { status: 0, stdout: reservation.formatReservationHolderLine({ branch: "main" }), stderr: "" }
        : remote.run(args);
      assert.equal(await runTask.nextTaskIdCommand(["--prefix", "X", "--repo", "acme/target", "--branch", "file-prefix"], {}, {
        openTargetRepo: () => ({ run, planTexts: [], dispose: () => {} }),
        openPrTexts: () => [], policyCurrency: () => ({ status: "current" }),
      }), 0);
      if (config === "valid") {
        const rows = readFileSync(join(root, "state", LEDGER_FILENAME), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].step, "reservation.taken_over");
        assert.equal(rows[0].lane, "next-task-id-prefix");
        assert.equal(rows[0].task_id, "X-T1");
        assert.deepEqual(errors, []);
      } else {
        assert.equal(errors.length, 1);
        assert.match(errors[0]!, /takeover ledger unavailable:.*SyntaxError/);
      }
    } finally {
      console.log = saved.log;
      console.error = saved.error;
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(home, { recursive: true, force: true });
    }
  });

  await t.test("the production construction census names any lane bypassing the factory", () => {
    const expected = new Map([
      ["ciLearningTaskIdMinter", "ci-learning"], ["triageCommandLocked", "triage"],
      ["planCommand", "plan"], ["approveCommand", "approve"], ["approveBatchCommand", "approve-batch"],
      ["prefixedNextTaskIdCommand", "next-task-id-prefix"], ["reservePlanRepairTaskId", "plan-repair"],
    ]);
    const seen = new Set<string>();
    let operator = 0;
    for (const path of ["src/run-task.ts", "src/lib/sweep.ts"]) {
      const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
      const functions = [...text.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)];
      assert.ok(functions.length > 10, `${path}: positive control must see the function population`);
      for (const call of text.matchAll(/\b(gitRemoteRefReserver|gatedRemoteRefReserver)\s*\(/g)) {
        const owner = functions.filter((f) => f.index! < call.index!).at(-1)?.[1];
        const tail = text.slice(call.index, functions.find((f) => f.index! > call.index!)?.index);
        if (call[1] === "gitRemoteRefReserver") {
          assert.equal(owner, "nextTaskIdCommand", `${owner}: bypasses the gated factory in ${path}`);
          assert.match(text.slice(call.index, text.indexOf(";", call.index)), /policyCurrency:/);
          operator++;
        } else {
          assert.ok(owner && expected.has(owner), `${owner}: new lane needs a census entry`);
          assert.match(tail, new RegExp(`lane: "${expected.get(owner!)}"`), `${owner}: must name its lane`);
          assert.match(tail, /\blog\b/, `${owner}: must supply a ledger sink`);
          seen.add(owner!);
        }
      }
      if (path === "src/run-task.ts") {
        const callers = [...text.matchAll(/\bciLearningTaskIdMinter\(([^\n)]*)/g)]
          .filter((call) => !text.slice(0, call.index).endsWith("function "));
        assert.ok(callers.length >= 8, "the census must see every daemon minter caller");
        for (const call of callers) assert.match(call[1]!, /,/, "a minter caller must pass its ledger sink");
      }
    }
    assert.equal(operator, 1, "nextTaskIdCommand keeps its explicitly gated operator path");
    assert.deepEqual([...seen].sort(), [...expected.keys()].sort());
  });
});
