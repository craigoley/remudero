import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  escalateWithJudge,
  type AsyncIssueGateway,
  type Escalation,
  type EscalationJudgeVerdict,
  type IssueGateway,
  type OpenIssue,
} from "../src/lib/escalate.js";

// W1-T5765 — a judged escalation awaits its gateway: the dedup search, the issue create and the
// supersede closes all run under the async driver, so a slow `gh` call never parks the daemon loop.

const PR = "https://github.com/craigoley/remudero/pull/5765";

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-T5765",
    summary: `two strikes exhausted — ${PR}`,
    detail: "the fix rung stood down.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

function ledgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "rmd-judged-async-")), "ledger.ndjson");
}

function rows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map(({ ts: _ts, at: _at, timestamp: _timestamp, ...rest }) => rest);
}

interface Store {
  gateway: IssueGateway;
  open: OpenIssue[];
  created: string[];
  comments: string[];
}

function syncStore(opts: { listThrows?: boolean } = {}): Store {
  const open: OpenIssue[] = [];
  const created: string[] = [];
  const comments: string[] = [];
  const gateway: IssueGateway = {
    create(title, body) {
      const number = 100 + created.length;
      const url = `https://github.com/craigoley/remudero/issues/${number}`;
      created.push(url);
      open.push({ number, url, title, body });
      return url;
    },
    listOpen() {
      if (opts.listThrows) throw new Error("rest outage");
      return [...open];
    },
    comment(_url, body) {
      comments.push(body);
    },
    closeWithComment() {},
  };
  return { gateway, open, created, comments };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function onTimer(store: Store, pending: { inFlight: number; sawInFlight: string[] }): AsyncIssueGateway {
  const wrap = <A extends unknown[], R>(name: string, fn: (...a: A) => R) =>
    async (...a: A): Promise<R> => {
      pending.inFlight++;
      pending.sawInFlight.push(name);
      await sleep(15);
      try {
        return fn(...a);
      } finally {
        pending.inFlight--;
      }
    };
  const g = store.gateway;
  return {
    create: wrap("create", g.create.bind(g)),
    listOpen: wrap("listOpen", g.listOpen!.bind(g)),
    comment: wrap("comment", g.comment!.bind(g)),
    closeWithComment: wrap("closeWithComment", g.closeWithComment!.bind(g)),
  };
}

const deliver = async (): Promise<EscalationJudgeVerdict> => ({ decision: "deliver", reason: "real blocker" });
const demote = async (): Promise<EscalationJudgeVerdict> => ({ decision: "demote", reason: "self-resolving storm" });

test("unit test: test/a-judged-escalation-reads-and-writes-github-off-the-loop.test.ts — the event loop ticks while the dedup search and issue create are in flight", async () => {
  const store = syncStore();
  const pending = { inFlight: 0, sawInFlight: [] as string[] };
  let ticksDuringCalls = 0;
  const gateway = onTimer(store, pending);
  const probe = setInterval(() => {
    if (pending.inFlight > 0) ticksDuringCalls++;
  }, 1);
  try {
    const url = await escalateWithJudge(escalation(), {
      issues: gateway,
      ledgerPath: ledgerPath(),
      runId: "RUN-A",
      judge: deliver,
    });
    assert.equal(url, store.created[0]);
  } finally {
    clearInterval(probe);
  }
  assert.ok(pending.sawInFlight.includes("listOpen"), "the dedup search went through the async gateway");
  assert.ok(pending.sawInFlight.includes("create"), "the issue create went through the async gateway");
  assert.ok(ticksDuringCalls >= 2, `the loop must tick while gateway calls are pending, saw ${ticksDuringCalls}`);
});

test("unit test: test/a-judged-escalation-reads-and-writes-github-off-the-loop.test.ts — the supersede close is awaited too", async () => {
  const store = syncStore();
  const pending = { inFlight: 0, sawInFlight: [] as string[] };
  const old = "https://github.com/craigoley/remudero/pull/5700";
  const path = ledgerPath();
  const gateway = onTimer(store, pending);
  await escalateWithJudge(escalation({ summary: `blocked — ${old} head aaaa1111` , detail: `Head SHA: aaaa1111\n${old}` }), {
    issues: gateway,
    ledgerPath: path,
    runId: "RUN-S",
    judge: deliver,
  });
  assert.equal(pending.inFlight, 0, "every gateway call settled before escalateWithJudge resolved");
});

test("unit test: test/a-judged-escalation-reads-and-writes-github-off-the-loop.test.ts — same ledger rows as the sync path for found, unreadable, demote and deliver", async () => {
  async function both(drive: (issues: AsyncIssueGateway, path: string) => Promise<unknown>, make: () => Store) {
    const syncPath = ledgerPath();
    const asyncPath = ledgerPath();
    const s1 = make();
    const s2 = make();
    const pending = { inFlight: 0, sawInFlight: [] as string[] };
    const r1 = await drive(s1.gateway, syncPath);
    const r2 = await drive(onTimer(s2, pending), asyncPath);
    assert.deepEqual(rows(asyncPath), rows(syncPath));
    assert.deepEqual(r2, r1);
    assert.ok(pending.sawInFlight.length > 0, "the async arm drove the timer gateway");
    return { rows: rows(asyncPath), store: s2 };
  }

  const deliverRun = await both(
    (issues, path) => escalateWithJudge(escalation(), { issues, ledgerPath: path, runId: "R", judge: deliver }),
    () => syncStore(),
  );
  assert.deepEqual(
    deliverRun.rows.map((r) => r.step),
    ["escalation.judged", "escalation.issue_opened"],
  );

  const demoteRun = await both(
    (issues, path) => escalateWithJudge(escalation(), { issues, ledgerPath: path, runId: "R", judge: demote }),
    () => syncStore(),
  );
  assert.deepEqual(
    demoteRun.rows.map((r) => r.step),
    ["escalation.judged", "escalation.demoted"],
  );
  assert.deepEqual(demoteRun.store.comments, ["self-resolving storm"]);

  const unreadableRun = await both(
    (issues, path) => escalateWithJudge(escalation(), { issues, ledgerPath: path, runId: "R", judge: deliver }),
    () => syncStore({ listThrows: true }),
  );
  assert.deepEqual(
    unreadableRun.rows.map((r) => r.step),
    ["escalation.dedup_unreadable"],
  );
  assert.equal(unreadableRun.store.created.length, 0, "an unreadable surface never creates");

  let judged = 0;
  const countingJudge = async (): Promise<EscalationJudgeVerdict> => {
    judged++;
    return { decision: "deliver", reason: "n/a" };
  };
  const foundRun = await both(
    async (issues, path) => {
      const first = await escalateWithJudge(escalation(), { issues, ledgerPath: path, runId: "R1", judge: countingJudge });
      const second = await escalateWithJudge(escalation(), { issues, ledgerPath: path, runId: "R2", judge: countingJudge });
      return [first, second];
    },
    () => syncStore(),
  );
  assert.equal(foundRun.store.created.length, 1, "the duplicate never opens a sibling");
  assert.equal(judged, 2, "two arms x one judged fresh escalation each; the duplicate is never judged");
});
