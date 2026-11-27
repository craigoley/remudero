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

import type { Proposal, RatifyGateway } from "#src/lib/inbox.js";
import { fakeGitHub } from "#test/helpers/fake-github.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { approveCommand, inboxCommand } from "#src/run-task.js";

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

// W1-T14977: the draft-free release fails closed without a release predicate, so the terminal verbs build one from
// their own ledger. Without it every parked ask reads as not drafted here although the Console offers it.
const PARKED = "W1-T9950";
test("W1-T14977 criterion 1: a parked verify:human task's ask with no draft is ready to approve as its release — from the terminal too, which reads releases from its own ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}parked-release-cli-`));
  const savedError = console.error;
  const savedLog = console.log;
  const savedArgv = process.argv;
  // `rmd inbox` reads the instance's plan; point it at this fixture's plan, as the operator's --repo-root does.
  process.argv = [...savedArgv, "--repo-root", root];
  try {
    mkdirSync(join(root, "state"), { recursive: true });
    mkdirSync(join(root, "plan"), { recursive: true });
    writeFileSync(join(root, "plan", "tasks.yaml"), `- id: ${PARKED}\n  title: "A parked record that needs a person"\n  repo: remudero\n  depends_on: []\n  type: implement\n  verify: human\n  status: queued\n  attempts: 0\n`, "utf8");
    writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: [{ id: `verify-human:${PARKED}`, summary: "A high-risk release still needs human verification", evidenceAnchors: [] }] }), "utf8");
    const ledgerPath = join(root, "state", "ledger.ndjson");
    const classified = async (ledger: string): Promise<Record<string, unknown> | undefined> => {
      writeFileSync(ledgerPath, ledger, "utf8");
      console.error = () => undefined;
      console.log = () => undefined;
      try {
        assert.equal(await inboxCommand(["--dry-run"], { config: { claudeBin: "/usr/bin/true", root } as never, github: fakeGitHub() }), 0);
      } finally {
        console.error = savedError;
        console.log = savedLog;
      }
      const rows = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      return rows.filter((r) => r.step === "inbox.classified" && r.proposal_id === `verify-human:${PARKED}`).at(-1);
    };
    const unreleased = await classified("");
    assert.equal(unreleased?.state, "ready", `\`rmd inbox\` offers the unreleased parked ask as its release: ${JSON.stringify(unreleased?.reasons)}`);
    const release = JSON.stringify({ run_id: "PANEL-1", task_id: PARKED, step: "ratify.approved", released: "verify-human", origin: "t" });
    assert.notEqual((await classified(`${release}\n`))?.state, "ready", "a task the ledger shows released is not offered again");
  } finally {
    process.argv = savedArgv;
    console.error = savedError;
    console.log = savedLog;
    rmSync(root, { recursive: true, force: true });
  }
});
