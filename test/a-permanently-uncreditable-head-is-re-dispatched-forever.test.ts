import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import * as RT from "../src/run-task.js";
import { buildSweepEffects } from "../src/run-task.js";
import type { IssueGateway, OpenIssue } from "../src/lib/escalate.js";
import { appendLedger } from "../src/lib/ledger.js";
import type { Plan, Task } from "../src/lib/plan.js";
import { DEFAULT_SWEEP_POLICY, type OpenPrView } from "../src/lib/sweep.js";

const TASK_ID = "W1-T2723";
const TASK = {
  id: TASK_ID,
  title: TASK_ID,
  risk: "high",
  acceptance: [],
  verify: "auto",
  files: [],
  status: "queued",
} as unknown as Task;
const PLAN = { tasks: [TASK], byId: new Map([[TASK_ID, TASK]]) } as Plan;

const headAcceptable = (RT as unknown as Record<string, unknown>)[["fixHead", "Acceptable"].join("")] as (
  head: string | undefined,
  taskId: string,
  synthetic: boolean,
) => boolean;

interface Harness {
  cleanup(): void;
  createdIssues: OpenIssue[];
  dispatch(headSha: string): Promise<unknown>;
  failNextEscalation(): void;
  ghViewCount(): number;
  ledgerRows(): Array<Record<string, unknown>>;
  seedRotatedTerminal(headSha: string): void;
  setHead(head: string): void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "terminal-head-root-"));
  const bin = mkdtempSync(join(tmpdir(), "terminal-head-gh-"));
  const ledgerPath = join(root, "state", "ledger.ndjson");
  const callsPath = join(root, "gh-calls.ndjson");
  const headPath = join(root, "head.txt");
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "repos"), { recursive: true });
  writeFileSync(callsPath, "");
  writeFileSync(headPath, "codex/manual-fix");
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const { appendFileSync, readFileSync } = require("node:fs");',
      "const args = process.argv.slice(2);",
      'appendFileSync(process.env.RMD_TERMINAL_HEAD_CALLS, JSON.stringify(args) + "\\n");',
      'const fields = args[args.indexOf("--json") + 1];',
      'if (fields && fields.includes("headRefName")) {',
      '  const headRefName = readFileSync(process.env.RMD_TERMINAL_HEAD_VALUE, "utf8").trim();',
      '  process.stdout.write(JSON.stringify({ headRefName, body: "Remudero-Task: W1-T2723" }));',
      '} else if (args[0] === "api" && /^repos\\/[^/]+\\/[^/]+\\/pulls\\/\\d+$/.test(args[1] || "")) {',
      '  process.stdout.write(JSON.stringify({ state: "open", merged: false }));',
      '} else {',
      '  process.stdout.write("{}");',
      '}',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const createdIssues: OpenIssue[] = [];
  let failNextCreate = false;
  const issueGateway: IssueGateway = {
    listOpen: () => createdIssues,
    create: (title, body) => {
      if (failNextCreate) {
        failNextCreate = false;
        throw new Error("injected issue transport failure");
      }
      const number = 9000 + createdIssues.length;
      const issue = {
        number,
        url: `https://github.com/acme/scratch/issues/${number}`,
        state: "open",
        title,
        body,
      };
      createdIssues.push(issue);
      return issue.url;
    },
  };

  const oldPath = process.env.PATH;
  const oldCalls = process.env.RMD_TERMINAL_HEAD_CALLS;
  const oldHead = process.env.RMD_TERMINAL_HEAD_VALUE;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.RMD_TERMINAL_HEAD_CALLS = callsPath;
  process.env.RMD_TERMINAL_HEAD_VALUE = headPath;

  return {
    createdIssues,
    failNextEscalation: () => {
      failNextCreate = true;
    },
    setHead: (head) => writeFileSync(headPath, head),
    ghViewCount: () =>
      readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
        .filter((args) => args[0] === "pr" && args[1] === "view").length,
    ledgerRows: () =>
      readFileSync(ledgerPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    seedRotatedTerminal: (headSha) => {
      appendLedger(ledgerPath, {
        run_id: "SWEEP-prior",
        task_id: "SWEEP",
        step: "sweep.fix.uncreditable_head",
        pr_number: 4242,
        head_sha: headSha,
        head: "codex/manual-fix",
        synthetic: false,
        reason: "not_a_run_branch",
        terminal: true,
        repair_task_id: TASK_ID,
        cause: "review",
      });
      appendLedger(ledgerPath, {
        run_id: "SWEEP-prior",
        task_id: "SWEEP",
        step: "sweep.fix.uncreditable_head_escalated",
        pr_number: 4242,
        head_sha: headSha,
        issue_url: "https://github.com/acme/scratch/issues/8999",
      });
      writeFileSync(
        join(root, "state", "ledger.2026-09-03T00-00-00-000Z.ndjson.gz"),
        gzipSync(readFileSync(ledgerPath)),
      );
      writeFileSync(ledgerPath, "");
    },
    dispatch: async (headSha) => {
      const log = (step: string, extra: Record<string, unknown> = {}): void => {
        appendLedger(ledgerPath, { run_id: `SWEEP-${headSha}`, task_id: "SWEEP", step, ...extra });
      };
      const effects = buildSweepEffects(
        "acme",
        "scratch",
        { root } as never,
        ledgerPath,
        `SWEEP-${headSha}`,
        PLAN,
        log,
        DEFAULT_SWEEP_POLICY,
        undefined,
        undefined,
        undefined,
        issueGateway,
      );
      const pr = {
        prNumber: 4242,
        prUrl: "https://github.com/acme/scratch/pull/4242",
        headSha,
        headRefName: "snapshot-only",
        taskId: TASK_ID,
        reviewState: "failure",
        checksState: "green",
        unmetCriteria: ["manual branch cannot be amended"],
        priorStrikes: 0,
        lastActivityAt: new Date().toISOString(),
      } as unknown as OpenPrView;
      try {
        await effects.dispatchFix(pr, { unmetCriteria: pr.unmetCriteria, ciFailures: [] } as never);
        return undefined;
      } catch (error) {
        return error;
      }
    },
    cleanup: () => {
      process.env.PATH = oldPath;
      if (oldCalls === undefined) delete process.env.RMD_TERMINAL_HEAD_CALLS;
      else process.env.RMD_TERMINAL_HEAD_CALLS = oldCalls;
      if (oldHead === undefined) delete process.env.RMD_TERMINAL_HEAD_VALUE;
      else process.env.RMD_TERMINAL_HEAD_VALUE = oldHead;
      rmSync(root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    },
  };
}

test("a terminal descriptive head is read and escalated once per head sha, even across fresh sweep effects", async () => {
  const h = makeHarness();
  try {
    await h.dispatch("sha-one");
    await h.dispatch("sha-one");
    assert.equal(h.ghViewCount(), 1, "the persisted terminal decision suppresses the second GraphQL head read");
    assert.equal(h.createdIssues.length, 1, "the same terminal head reaches a human exactly once");

    await h.dispatch("sha-two");
    assert.equal(h.ghViewCount(), 2, "a new sha is a new fact and is judged afresh");
    assert.equal(h.createdIssues.length, 2, "a genuinely new terminal head gets its own escalation");
    const declines = h.ledgerRows().filter((row) => row.step === "sweep.fix.uncreditable_head");
    assert.deepEqual(
      declines.map((row) => row.head_sha),
      ["sha-one", "sha-two"],
      "the terminal key is durable and explicit in the ledger",
    );
  } finally {
    h.cleanup();
  }
});

test("a new sha that moves onto the task run branch proceeds instead of inheriting the old decline", async () => {
  const h = makeHarness();
  try {
    await h.dispatch("sha-old");
    h.setHead(`run-${TASK_ID}-1788400000000`);
    const error = await h.dispatch("sha-new");
    assert.ok(error instanceof Error, "the accepted head proceeds to the deliberately absent test repository");
    assert.equal(h.ghViewCount(), 2, "the new sha was re-read rather than suppressed by the old terminal key");
    assert.equal(h.createdIssues.length, 1, "only the old descriptive head was escalated");
    assert.deepEqual(
      h.ledgerRows()
        .filter((row) => row.step === "sweep.fix.uncreditable_head")
        .map((row) => row.head_sha),
      ["sha-old"],
    );
  } finally {
    h.cleanup();
  }
});

test("the ownership guard still refuses foreign heads and accepts only this task's run branch", () => {
  assert.equal(headAcceptable("codex/manual-fix", TASK_ID, false), false);
  assert.equal(headAcceptable("run-W1-T999-1788400000000", TASK_ID, false), false);
  assert.equal(headAcceptable(`run-${TASK_ID}-1788400000000`, TASK_ID, false), true);
});

test("a terminal marker survives ledger rotation and a process-cold effects construction", async () => {
  const h = makeHarness();
  try {
    h.seedRotatedTerminal("sha-rotated");
    await h.dispatch("sha-rotated");
    assert.equal(h.ghViewCount(), 0, "the archive∪live reconstruction suppresses the old head without GitHub I/O");
    assert.equal(h.createdIssues.length, 0, "the durable delivered marker also suppresses a duplicate escalation");
  } finally {
    h.cleanup();
  }
});

test("a failed human delivery retries without re-reading the unchanged head, then becomes terminal", async () => {
  const h = makeHarness();
  try {
    h.failNextEscalation();
    await h.dispatch("sha-retry");
    assert.equal(h.createdIssues.length, 0, "the injected transport failure did not fabricate a delivery");
    await h.dispatch("sha-retry");
    await h.dispatch("sha-retry");
    assert.equal(h.ghViewCount(), 1, "delivery retry and later suppression both reuse the recorded head decision");
    assert.equal(h.createdIssues.length, 1, "the recovered transport reaches a human once, never once per poll");
    assert.equal(
      h.ledgerRows().filter((row) => row.step === "sweep.fix.uncreditable_head_escalated").length,
      1,
      "the delivered marker is written only after the external issue exists",
    );
  } finally {
    h.cleanup();
  }
});
