/**
 * A proposal an operator declined is never approved from the terminal. The console's inbox pass applied the ledger's
 * declines; `rmd approve` (single and batch) and `rmd inbox` classified without them, so a declined proposal read as
 * whatever its other predicates said and could be ratified. These cases drive the real commands over a real registry
 * and ledger, and a fake gateway that records every call.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Proposal, RatifyGateway } from "../src/lib/inbox.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { approveCommand, inboxCommand } from "../src/run-task.js";

function fixture(declines: Array<{ step: string; id: string; reason: string }>) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}approve-declined-`));
  mkdirSync(join(root, "state"), { recursive: true });
  const proposals: Proposal[] = [
    { id: "P-declined", summary: "s", evidenceAnchors: [] },
    { id: "P-other", summary: "s", evidenceAnchors: [] },
  ];
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals }), "utf8");
  const ledgerPath = join(root, "state", "ledger.ndjson");
  writeFileSync(ledgerPath, "", "utf8");
  for (const d of declines) appendFileSync(ledgerPath, `${JSON.stringify({ run_id: "PANEL-1", task_id: d.id, step: d.step, origin: "t", reason: d.reason })}\n`);
  const calls: string[] = [];
  const gateway: RatifyGateway = {
    createRatificationBranch: () => (calls.push("createRatificationBranch"), "b"),
    openPlanPr: () => (calls.push("openPlanPr"), "https://github.com/craigoley/remudero/pull/1"),
    writeSkillFile: () => (calls.push("writeSkillFile"), "b"),
  };
  const rows = () =>
    readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { root, config: { claudeBin: "/usr/bin/true", root } as never, gateway, calls, rows };
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ value: T; err: string }> {
  const err: string[] = [];
  const savedError = console.error;
  const savedLog = console.log;
  console.error = (line: unknown) => void err.push(String(line));
  console.log = (line: unknown) => void err.push(String(line));
  try {
    return { value: await fn(), err: err.join("\n") };
  } finally {
    console.error = savedError;
    console.log = savedLog;
  }
}

test("rmd approve refuses a declined proposal, names the decline's reason, and makes no gateway call", async () => {
  const f = fixture([{ step: "panel.proposal_declined", id: "P-declined", reason: "a legacy duplicate" }]);
  try {
    const { value: code } = await quietly(() => approveCommand(["P-declined"], { config: f.config, gateway: f.gateway }));
    assert.notEqual(code, 0);
    assert.deepEqual(f.calls, []);
    const refused = f.rows().filter((r) => r.step === "ratify.approve_refused" && r.task_id === "P-declined");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.state, "declined");
    assert.match(String(refused[0]!.reason), /P-declined is DECLINED \(a legacy duplicate\) — never approvable/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a batch approve naming a declined proposal skips it as DECLINED, not as merely not-ready", async () => {
  const f = fixture([{ step: "panel.proposal_declined", id: "P-declined", reason: "a legacy duplicate" }]);
  try {
    const { err } = await quietly(() => approveCommand(["P-declined", "P-other"], { config: f.config, gateway: f.gateway }));
    const text = `${err}\n${JSON.stringify(f.rows())}`;
    assert.match(text, /P-declined is DECLINED \(a legacy duplicate\) — never approvable/);
    assert.doesNotMatch(text, /P-other is DECLINED/, "only the declined member reads as declined");
    assert.deepEqual(f.calls, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a proposal declined and then restored is judged on its other predicates again, not as declined", async () => {
  const f = fixture([
    { step: "panel.proposal_declined", id: "P-declined", reason: "a wrong call" },
    { step: "panel.proposal_restored", id: "P-declined", reason: "taken back" },
  ]);
  try {
    await quietly(() => approveCommand(["P-declined"], { config: f.config, gateway: f.gateway }));
    const refused = f.rows().filter((r) => r.step === "ratify.approve_refused" && r.task_id === "P-declined");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.state, "not_ready", "with no drafted candidate it is not ready, and nothing else");
    assert.doesNotMatch(String(refused[0]!.reason), /DECLINED/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rmd inbox --dry-run classifies a declined proposal as declined, as the console does", async () => {
  const f = fixture([{ step: "panel.proposal_declined", id: "P-declined", reason: "a legacy duplicate" }]);
  try {
    const { value: code } = await quietly(() => inboxCommand(["--dry-run"], { config: f.config }));
    assert.equal(code, 0);
    const classified = new Map(f.rows().filter((r) => r.step === "inbox.classified").map((r) => [r.proposal_id, r.state]));
    assert.equal(classified.get("P-declined"), "declined");
    assert.notEqual(classified.get("P-other"), "declined");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
