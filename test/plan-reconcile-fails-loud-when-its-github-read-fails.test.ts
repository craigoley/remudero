// W1-T5029 — `rmd plan-reconcile` printed 'board gateway: batched PR fetch failed (unknown)' and then the
// confident '0 shard(s) would be reconciled' with exit 0, because the gateway marks its failure and the verb
// never asked. A failed or truncated merged-PR read must print UNKNOWN, write nothing and exit 2; a readable
// empty projection is a real 0 and stays exit 0.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GitHub } from "../src/lib/status.js";
import { buildBatchedGithub } from "../src/lib/status.js";
import { creditProjectionWithReadState, defaultCreditedMergedIds, planReconcileCommand } from "../src/run-task.js";

const SHARD = "- id: W1-T1234\n  title: t\n  status: queued\n  attempts: 0\n";

/** Run the verb capturing stdout and stderr, so what an operator would read is what is asserted. */
async function run(args: string[], deps: Parameters<typeof planReconcileCommand>[1]) {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await planReconcileCommand(args, deps);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
}

const shards = () => [{ taskId: "W1-T1234", path: "/p/W1-T1234.yaml", text: SHARD }];

test("W1-T5029: a failed merged-PR read makes a dry run print UNKNOWN and exit 2", async () => {
  const r = await run([], { readShards: shards, creditedProjection: () => ({ ids: new Set(), unknownReason: "rate_limit" }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /rmd plan-reconcile: UNKNOWN/);
  assert.match(r.err, /\(rate_limit\)/, "the reason is named");
  assert.doesNotMatch(r.out, /would be reconciled/, "the zero-shard summary is never printed on this path");
});

test("W1-T5029: a failed merged-PR read under --write writes nothing and exits 2", async () => {
  const written: string[] = [];
  const logged: string[] = [];
  const r = await run(["--write"], {
    readShards: shards,
    // Even a non-empty credit set must not be written from a failed read.
    creditedProjection: () => ({ ids: new Set(["W1-T1234"]), unknownReason: "unknown" }),
    writeShard: (p) => written.push(p),
    log: (step) => logged.push(step),
  });
  assert.equal(r.code, 2);
  assert.deepEqual(written, []);
  assert.deepEqual(logged, ["plan.reconcile.unknown"]);
  assert.doesNotMatch(r.out, /reconciled/);
});

test("W1-T5029: a readable empty projection still prints the count and exits 0", async () => {
  const r = await run([], { readShards: shards, creditedProjection: () => ({ ids: new Set() }) });
  assert.equal(r.code, 0);
  assert.match(r.out, /0 shard\(s\) would be reconciled/);
  assert.equal(r.err, "");
});

test("W1-T5029: a truncated merged-PR read is UNKNOWN too", async () => {
  const github: Partial<GitHub> = { readState: () => "ok", readTruncated: () => true };
  const builder = (() => []) as unknown as Parameters<typeof creditProjectionWithReadState>[2];
  const withTrunc = withLedgerRoot((cfg, root) => creditProjectionWithReadState(cfg, root, builder, github as GitHub));
  assert.equal(withTrunc.unknownReason, "truncated");
  const r = await run([], { readShards: shards, creditedProjection: () => withTrunc });
  assert.equal(r.code, 2);
  assert.match(r.err, /\(truncated\)/);

  // A clean read, and a failed read that is never asked about truncation (readTruncated would force a fetch).
  const clean = withLedgerRoot((cfg, root) =>
    creditProjectionWithReadState(cfg, root, builder, { readState: () => "ok", readTruncated: () => false } as GitHub),
  );
  assert.equal(clean.unknownReason, undefined);
  let asked = false;
  const failed = withLedgerRoot((cfg, root) =>
    creditProjectionWithReadState(cfg, root, builder, {
      readState: () => "failed",
      readFailureReason: () => "auth",
      readTruncated: () => ((asked = true), true),
    } as GitHub),
  );
  assert.equal(failed.unknownReason, "auth");
  assert.equal(asked, false);
  const noReason = withLedgerRoot((cfg, root) =>
    creditProjectionWithReadState(cfg, root, builder, { readState: () => "failed" } as GitHub),
  );
  assert.equal(noReason.unknownReason, "unknown");
  // A gateway with no readState at all is not UNKNOWN: nothing says the read failed.
  const bare = withLedgerRoot((cfg, root) => creditProjectionWithReadState(cfg, root, builder, {} as GitHub));
  assert.equal(bare.unknownReason, undefined);
});

test("W1-T5029: the thrown-projection arm still exits 1 and an injected set is unchanged", async () => {
  const thrown = await run([], {
    readShards: shards,
    creditedMergedIds: () => {
      throw new Error("boom");
    },
  });
  assert.equal(thrown.code, 1);
  assert.match(thrown.err, /credit projection is unreadable \(boom\)/);

  const written: string[] = [];
  const injected = await run(["--write"], {
    readShards: shards,
    creditedMergedIds: () => new Set(["W1-T1234"]),
    writeShard: (p) => written.push(p),
  });
  assert.equal(injected.code, 0);
  assert.deepEqual(written, ["/p/W1-T1234.yaml"]);
  assert.match(injected.out, /1 shard\(s\) reconciled/);
});

test("W1-T5029: a real failing gateway read is reported UNKNOWN by the default projection", () => {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5029-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.ndjson"), "", "utf8");
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      [
        "- id: W1-T1234",
        "  title: tiny",
        "  repo: remudero",
        "  depends_on: []",
        "  type: implement",
        "  verify: auto",
        "  budget_usd: 1.00",
        "  status: queued",
        "  acceptance:",
        '    - claim: "c"',
        '      proof: "unit test: x"',
        "",
      ].join("\n"),
      "utf8",
    );
    const github = buildBatchedGithub("o", "r", {
      exec: () => {
        throw Object.assign(new Error("spawnSync gh ENOENT"), { code: "ENOENT" });
      },
      log: () => {},
    });
    const logs: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    let projection: ReturnType<typeof creditProjectionWithReadState>;
    try {
      projection = creditProjectionWithReadState({ root } as never, root, undefined, github);
    } finally {
      console.error = realErr;
    }
    assert.equal(projection.ids.size, 0, "the failed read credits nothing");
    assert.equal(projection.unknownReason, "unknown", "the gateway's own marked failure is what the projection reports");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1-T5029: defaultCreditedMergedIds keeps returning only the reconcilable ids as a plain Set", () => {
  const builder = (() => [
    { taskId: "W1-T1", merged: true, creditIsImplementation: true },
    { taskId: "W1-T2", merged: true, creditIsImplementation: false },
  ]) as unknown as Parameters<typeof defaultCreditedMergedIds>[2];
  const ids = withLedgerRoot((cfg, root) => defaultCreditedMergedIds(cfg, root, builder));
  assert.deepEqual([...ids], ["W1-T1"]);
});

/** A throwaway checkout root holding an (empty) ledger, the one thing the projection's early return asks for. */
function withLedgerRoot<T>(fn: (cfg: never, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "rmd-t5029-ledger-"));
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(join(root, "state", "ledger.ndjson"), "", "utf8");
    writeFileSync(
      join(root, "plan", "tasks.yaml"),
      "- id: W1-T1234\n  title: tiny\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: auto\n  budget_usd: 1.00\n  status: queued\n  acceptance:\n    - claim: \"c\"\n      proof: \"unit test: x\"\n",
      "utf8",
    );
    return fn({ root } as never, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
