// W1-T13690: the notice that tells the operator the GitHub budget ran out never arrived. For a core exhaustion its
// dedup read listed the open needs-human issues over REST, a core read that the installation budget refuses at the
// write reserve and that GitHub refuses at 0 (7 core rows, 2026-11-14 to 2026-11-18, all delivered false). A core
// notice now reads and opens its issue through GraphQL, a separate limit. When that fails too, the notice is sent
// once after the reset, naming the window, and a kept delivered_late row stops a second send.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { deliverQuotaExhaustionLate, escalateQuotaExhaustion } from "#src/lib/escalation-catalogue.js";
import { ghIssueGatewayAsync, type IssueGateway, type OpenIssue } from "#src/lib/escalate.js";
import { configureGithubInstallationBudget, GhPaceFloorStandDownError } from "#src/lib/github-transport.js";
import { createInstallationBudget } from "#src/lib/github-installation-budget.js";
import { DECISION_RELEVANT_LEDGER_STEPS, rotateLedger } from "#src/lib/ledger.js";
import { runDaemon } from "#src/lib/daemon.js";
import { loadPlan } from "#src/lib/plan.js";
import { requestStop, stopDetail } from "#src/lib/fleet-control.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { readLedgerLines } from "#src/lib/status.js";
import { systemClock } from "#src/lib/clock.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim, type GhShim, type GhShimRoute } from "#test/helpers/gh-shim.js";
// W1-T14998: an escalation files in the host's escalation repository; this suite's gh fixture answers for o/r.
process.env.RMD_ESCALATION_REPOSITORY ??= "o/r";

const RESETS_AT = "2026-11-18T02:00:00.000Z";
const CORE = { bucket: "core" as const, remaining: 0, resetsAt: RESETS_AT };
const NEW_URL = "https://github.com/o/r/issues/900";

function tmp(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w13690-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ledger(t: TestContext): string {
  return join(tmp(t, "state"), "ledger.ndjson");
}

const rows = (path: string, step: string) => readLedgerLines(path).filter((r) => r.step === step);

const emptyList = JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });
const listOf = (issues: OpenIssue[]) => JSON.stringify({ data: { repository: { issues: {
  nodes: issues.map((i) => ({ number: i.number, url: i.url, title: i.title, body: i.body })),
  pageInfo: { hasNextPage: false, endCursor: null } } } } });
const ids = JSON.stringify({ data: { repository: { id: "R_1", l0: { id: "LA_0" }, l1: { id: "LA_1" }, l2: { id: "LA_2" } } } });
const created = JSON.stringify({ data: { createIssue: { issue: { url: NEW_URL } } } });

/** The GraphQL answers: the mutation, the id read and the issue list, matched on text each query alone holds. */
function graphqlRoutes(list = emptyList): GhShimRoute[] {
  return [
    { when: "createIssue(input:", stdout: created },
    { when: "label(name:", stdout: ids },
    { when: "issues(labels:", stdout: list },
  ];
}

function withShim(t: TestContext, routes: GhShimRoute[]): GhShim {
  const shim = ghShim(routes, { kind: "w13690-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  });
  return shim;
}

/** The raw argv log: a body holds newlines, so a call can span lines. */
const rawCalls = (shim: GhShim): string => readFileSync(join(shim.dir, "calls.log"), "utf8");

/** Every call starts its own log line with `api ` or another gh verb; a body line never does. */
const callStarts = (shim: GhShim): string[] => shim.calls().filter((l) => /^(api|issue|label|pr|auth|repo) /.test(l));

/** The title, body and label names the GraphQL path sent, read back from the shim's argv log. */
function sentNotice(shim: GhShim): { title: string; body: string; labels: string[] } {
  const raw = rawCalls(shim);
  const mutation = raw.slice(raw.indexOf("createIssue(input:"));
  const title = mutation.slice(mutation.indexOf(" -f title=") + 10, mutation.indexOf(" -f body="));
  const body = mutation.slice(mutation.indexOf(" -f body=") + 9, mutation.indexOf(" -f labelIds[]="));
  const idRead = raw.split("\n").find((l) => l.includes("label(name:")) ?? "";
  const labels = [...idRead.matchAll(/ -f l\d+=(\S+)/g)].map((m) => m[1]!);
  return { title, body, labels };
}

/** A REST-shaped gateway that records each create, the origin/main path's injected seam. */
function recordingGateway(open: OpenIssue[] = []) {
  const creates: Array<{ title: string; body: string; labels: string[] }> = [];
  const gateway: IssueGateway = {
    listOpen: () => open,
    create: (title, body, labels) => { creates.push({ title, body, labels }); return NEW_URL; },
  };
  return { gateway, creates };
}

const failingGateway: IssueGateway = {
  listOpen: () => { throw new Error("gh call pacer stood down: core at 0/15000, at or below the floor"); },
  create: () => { throw new Error("FALSIFIER: no issue is opened after an unreadable dedup read"); },
};

test("W1-T13690 criterion 1: a core notice makes only `api graphql` calls and records the new issue", async (t) => {
  const shim = withShim(t, graphqlRoutes());
  const path = ledger(t);
  await withLiveWritesAllowed(() => escalateQuotaExhaustion(CORE, { owner: "o", repo: "r", ledgerPath: path, runId: "D-1" }));
  const calls = callStarts(shim);
  assert.equal(calls.length, 3, `one list read, one id read and one mutation: ${calls.join(" | ")}`);
  assert.ok(calls.every((c) => c.startsWith("api graphql ")), calls.join(" | "));
  const [row] = rows(path, "daemon.quota_exhausted.escalated");
  assert.equal(row?.delivered, true);
  assert.equal(row?.issue_url, NEW_URL);
  assert.equal(rows(path, "escalation.judged").length, 0, "no model judge is asked");
});

test("W1-T13690 criterion 2: the GraphQL path sends the same notice and deduplicates as origin/main does", async (t) => {
  const shim = withShim(t, graphqlRoutes());
  const viaGraphql = ledger(t);
  await withLiveWritesAllowed(() => escalateQuotaExhaustion(CORE, { owner: "o", repo: "r", ledgerPath: viaGraphql, runId: "D-1" }));
  const rest = recordingGateway();
  const viaRest = ledger(t);
  escalateQuotaExhaustion(CORE, { owner: "o", repo: "r", ledgerPath: viaRest, runId: "D-1", issues: rest.gateway });
  assert.equal(rest.creates.length, 1);
  assert.deepEqual(sentNotice(shim), rest.creates[0], "the same title, body (options and recommendation) and labels");
  assert.deepEqual(rows(viaGraphql, "escalation.issue_opened")[0]?.labels, rows(viaRest, "escalation.issue_opened")[0]?.labels);

  // An open needs-human issue carrying the same notice is deduplicated: no mutation, the same deduped row.
  const open: OpenIssue = { number: 77, url: "https://github.com/o/r/issues/77", title: rest.creates[0]!.title, body: rest.creates[0]!.body };
  const dupShim = withShim(t, graphqlRoutes(listOf([open])));
  const dupGraphql = ledger(t);
  await withLiveWritesAllowed(() => escalateQuotaExhaustion(CORE, { owner: "o", repo: "r", ledgerPath: dupGraphql, runId: "D-2" }));
  assert.ok(!rawCalls(dupShim).includes("createIssue(input:"), "no issue is opened for a duplicate");
  const restDup = recordingGateway([open]);
  const dupRest = ledger(t);
  escalateQuotaExhaustion(CORE, { owner: "o", repo: "r", ledgerPath: dupRest, runId: "D-2", issues: restDup.gateway });
  assert.equal(restDup.creates.length, 0);
  const strip = ({ ts: _ts, actor: _a, ...rest }: Record<string, unknown>) => rest;
  const deduped = rows(dupGraphql, "escalation.deduped").map(strip);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]?.issue_url, open.url);
  assert.deepEqual(deduped, rows(dupRest, "escalation.deduped").map(strip));
  assert.equal(rows(dupGraphql, "daemon.quota_exhausted.escalated")[0]?.issue_url, open.url);
});

test("W1-T13690 criterion 3: at 0 and under the write reserve, the budget refuses a core read but sends the notice", async (t) => {
  t.after(() => configureGithubInstallationBudget(undefined));
  for (const remaining of [0, 1_496]) {
    const budget = createInstallationBudget({ consumers: 4, clock: systemClock, maxWaitMs: 0 });
    budget.record({ resource: "core", remaining, limit: 15_000, reset: Math.floor(systemClock.now() / 1000) + 3_600 });
    configureGithubInstallationBudget(budget);
    const shim = withShim(t, [...graphqlRoutes(), { when: "issues?labels=", stdout: "[]" }]);
    // Control: the REST dedup read origin/main sends is refused by this budget before any gh call.
    await assert.rejects(() => ghIssueGatewayAsync("o", "r").listOpen!("needs-human") as Promise<unknown>, GhPaceFloorStandDownError);
    const path = ledger(t);
    await withLiveWritesAllowed(() => escalateQuotaExhaustion(CORE, { owner: "o", repo: "r", ledgerPath: path, runId: `D-${remaining}` }));
    assert.deepEqual(rows(path, "daemon.quota_exhausted.escalated").map((r) => [r.delivered, r.issue_url]), [[true, NEW_URL]],
      `core at ${remaining}/15000`);
    assert.equal(rows(path, "escalation.dedup_unreadable").length, 0);
    assert.equal(callStarts(shim).filter((c) => c.startsWith("api graphql ")).length, 3);
  }
});

test("W1-T13690 criterion 4: a graphql exhaustion keeps the REST issue gateway", async (t) => {
  const shim = withShim(t, [
    { when: "issues?labels=needs-human", stdout: "[]" },
    { when: "issue create", stdout: NEW_URL },
  ]);
  const path = ledger(t);
  await withLiveWritesAllowed(() => escalateQuotaExhaustion({ bucket: "graphql", remaining: 0, resetsAt: RESETS_AT },
    { owner: "o", repo: "r", ledgerPath: path, runId: "D-1" }));
  const calls = callStarts(shim);
  assert.ok(calls.some((c) => c.startsWith("api repos/o/r/issues?labels=needs-human")), calls.join(" | "));
  assert.ok(calls.some((c) => c.startsWith("issue create --repo o/r")));
  assert.ok(!calls.some((c) => c.startsWith("api graphql")));
  assert.equal(rows(path, "daemon.quota_exhausted.escalated")[0]?.issue_url, NEW_URL);
});

const DONE_YAML = `
- id: M
  title: already merged
  repo: remudero
  type: implement
  depends_on: []
  status: queued
`;

/** One daemon process over `readings` (one core reading a tick), wired to the real notice and late hooks. */
async function daemonPass(t: TestContext, path: string, readings: number[], issues: { exhausted: IssueGateway; late: IssueGateway }) {
  const dir = tmp(t, "daemon");
  writeFileSync(join(dir, "tasks.yaml"), DONE_YAML);
  const plan = loadPlan(join(dir, "tasks.yaml"));
  let tick = 0;
  const lines: string[] = [];
  const s = await runDaemon(plan, {
    refreshMerged: () => (id) => id === "M",
    runOne: async (id) => { throw new Error(`FALSIFIER: ${id} was dispatched`); },
    readGhQuota: () => ({ core: { remaining: readings[Math.min(tick++, readings.length - 1)]!, resetsAt: RESETS_AT } }),
    onQuotaExhausted: (info) => escalateQuotaExhaustion(info, { owner: "o", repo: "r", ledgerPath: path, runId: "D", issues: issues.exhausted }),
    onQuotaRecovered: (info) => deliverQuotaExhaustionLate(info, { owner: "o", repo: "r", ledgerPath: path, runId: "D", issues: issues.late }),
    log: (step) => { lines.push(step); },
    checkStop: () => stopDetail(dir),
    sleep: async () => { if (tick >= readings.length) requestStop(dir, "test done"); },
  });
  return { s, lines };
}

test("W1-T13690 criterion 5: the first positive tick after an undelivered notice sends it once, naming the window", async (t) => {
  const path = ledger(t);
  const late = recordingGateway();
  await daemonPass(t, path, [0, 0, 9_000, 9_000, 9_000], { exhausted: failingGateway, late: late.gateway });
  const [escalated] = rows(path, "daemon.quota_exhausted.escalated");
  assert.equal(escalated?.delivered, false, "the notice at the exhaustion could not be sent");
  assert.equal(late.creates.length, 1, "sent once, on the first positive tick only");
  const title = late.creates[0]!.title;
  assert.ok(title.includes(`exhausted from ${String(escalated.ts)} to ${RESETS_AT}`), title);
  assert.ok(title.includes("sent after the reset"), title);
  const pick = (r: Record<string, unknown>) =>
    ({ step: r.step, bucket: r.bucket, resets_at: r.resets_at, issue_url: r.issue_url, delivered: r.delivered });
  assert.deepEqual(rows(path, "daemon.quota_exhausted.delivered_late").map(pick),
    [{ step: "daemon.quota_exhausted.delivered_late", bucket: "core", resets_at: RESETS_AT, issue_url: NEW_URL, delivered: true }]);
  // A restart in the same window: the bucket reads 0 then positive again, and the row stops a second send.
  await daemonPass(t, path, [0, 9_000, 9_000], { exhausted: failingGateway, late: late.gateway });
  assert.equal(late.creates.length, 1, "a restart that finds the delivered_late row sends nothing");
  await deliverQuotaExhaustionLate({ bucket: "core" }, { owner: "o", repo: "r", ledgerPath: path, runId: "D", issues: late.gateway });
  assert.equal(late.creates.length, 1);
  assert.equal(rows(path, "daemon.quota_exhausted.delivered_late").length, 1);
});

test("W1-T13690 criterion 6: a failed send on either path writes its row and never throws into the tick", async (t) => {
  withShim(t, [{ when: "", stderr: "HTTP 502", exit: 1 }]);
  const path = ledger(t);
  await withLiveWritesAllowed(() => escalateQuotaExhaustion(CORE, { owner: "o", repo: "r", ledgerPath: path, runId: "D-1" }));
  assert.deepEqual(rows(path, "daemon.quota_exhausted.escalated").map((r) => [r.delivered, r.issue_url]), [[false, null]]);
  await withLiveWritesAllowed(() => deliverQuotaExhaustionLate({ bucket: "core" }, { owner: "o", repo: "r", ledgerPath: path, runId: "D-1" }));
  assert.deepEqual(rows(path, "daemon.quota_exhausted.delivered_late").map((r) => [r.delivered, r.issue_url]), [[false, null]]);
  // Both hooks failing on the daemon tick: the loop goes on to its stop and nothing pauses dispatch.
  const loopPath = ledger(t);
  const { s, lines } = await daemonPass(t, loopPath, [0, 9_000, 9_000], { exhausted: failingGateway, late: failingGateway });
  assert.equal(s.stopReason, "stopped");
  assert.equal(lines.filter((l) => l === "daemon.escalation.failed").length, 0, "neither hook throws into the tick");
  assert.ok(!lines.some((l) => /pause|headroom_reserve/.test(l)), `no pause: ${[...new Set(lines)].join(", ")}`);
  assert.deepEqual(rows(loopPath, "daemon.quota_exhausted.delivered_late").map((r) => r.delivered), [false]);
});

test("W1-T13690 criterion 7: the delivered_late step is kept across a ledger rotation, as the escalated step is", async (t) => {
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("daemon.quota_exhausted.escalated"));
  assert.ok(DECISION_RELEVANT_LEDGER_STEPS.has("daemon.quota_exhausted.delivered_late"));
  const path = ledger(t);
  const ts = "2026-11-18T01:01:00.000Z";
  const kept = [
    { ts, run_id: "D", task_id: "daemon", step: "daemon.quota_exhausted.escalated", bucket: "core", resets_at: RESETS_AT, issue_url: null, delivered: false },
    { ts, run_id: "D", task_id: "daemon", step: "daemon.quota_exhausted.delivered_late", bucket: "core", resets_at: RESETS_AT, issue_url: NEW_URL, delivered: true },
  ];
  const filler = Array.from({ length: 400 }, (_, i) => ({ ts, run_id: "D", task_id: "daemon", step: "ci.polling", n: i }));
  writeFileSync(path, [...kept, ...filler].map((r) => JSON.stringify(r) + "\n").join(""));
  assert.equal(rotateLedger(path, { ceilingBytes: 4_000, smoothingWindowMs: 0, now: () => new Date(Date.parse(ts) + 60_000) }).rotated, true);
  const live = readLedgerLines(path);
  assert.ok(!live.some((r) => r.step === "ci.polling"), "control: the rotation archived the other rows");
  assert.deepEqual(live.filter((r) => String(r.step).startsWith("daemon.quota_exhausted.")).map((r) => r.step),
    ["daemon.quota_exhausted.escalated", "daemon.quota_exhausted.delivered_late"]);
  const late = recordingGateway();
  await deliverQuotaExhaustionLate({ bucket: "core" }, { owner: "o", repo: "r", ledgerPath: path, runId: "D", issues: late.gateway });
  assert.equal(late.creates.length, 0, "after the rotation, a restart still finds the row and sends nothing");
});
