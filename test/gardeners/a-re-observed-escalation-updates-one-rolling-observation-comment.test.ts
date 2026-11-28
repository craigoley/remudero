import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  escalate,
  escalateAsync,
  ghIssueGatewayAsync,
  ROLLING_OBSERVATION_RE,
  type Escalation,
  type IssueComment,
  type IssueGateway,
} from "#src/lib/escalate.js";
import { clockFromIsoFn } from "#src/lib/clock.js";
import { conditionReobserved, parseIssueCommentsRest } from "#src/lib/issue-revalidation-garden.js";
// W1-T14998: an escalation files in the host's escalation repository; this suite's gh fixture answers for craigoley/remudero.
process.env.RMD_ESCALATION_REPOSITORY ??= "craigoley/remudero";

const ISSUE_URL = "https://github.com/craigoley/remudero/issues/500";

function escalation(over: Partial<Escalation> = {}): Escalation {
  return {
    class: "BLOCKED",
    taskId: "W1-TROLL",
    summary: "blocked_review fix rung exhausted — https://github.com/craigoley/remudero/pull/77",
    detail: "the review gate is still failing.",
    options: [
      { label: "retry", detail: "resume the run with a fresh worker" },
      { label: "abandon", detail: "drop the task and re-plan" },
    ],
    recommendation: "retry",
    ...over,
  };
}

/** An issue store holding one OPEN issue that every escalation above dedups onto, with comments
 *  that can be listed by update time and edited by id, like the REST API. */
function store(opts: { failList?: boolean; failEdit?: boolean } = {}) {
  let seq = 1;
  const comments: Array<IssueComment & { url: string }> = [];
  const edits: number[] = [];
  let clock = "2026-11-16T09:00:00.000Z";
  const issues: IssueGateway = {
    create() {
      throw new Error("no new issue expected: the open one dedups");
    },
    listOpen: () => [{ number: 500, url: ISSUE_URL, title: "[BLOCKED] W1-TROLL: PR #77 review", body: "**Class:** BLOCKED\n**Task:** W1-TROLL\nPR #77" }],
    comment(url, body) {
      comments.push({ url, id: seq++, body, createdAt: clock, updatedAt: clock });
    },
    listCommentsSince(_url, sinceIso) {
      if (opts.failList) throw new Error("gh api: HTTP 502");
      return comments.filter((c) => Date.parse(c.updatedAt) >= Date.parse(sinceIso)).map(({ url: _u, ...c }) => c);
    },
    editComment(id, body) {
      if (opts.failEdit) throw new Error("gh api: HTTP 404");
      const c = comments.find((x) => x.id === id);
      if (!c) throw new Error(`no comment ${id}`);
      c.body = body;
      c.updatedAt = clock;
      edits.push(id);
    },
  };
  return { issues, comments, edits, at: (iso: string) => { clock = iso; }, clock: clockFromIsoFn(() => clock) };
}

function ledgerDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-rolling-observation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ledger.ndjson");
}

function dedupRows(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.step === "escalation.deduped");
}

test("W1-T13218 criterion 1: later matches the same UTC day edit the one observation comment in place", (t) => {
  const s = store();
  const ledgerPath = ledgerDir(t);
  const deps = { issues: s.issues, ledgerPath, runId: "RUN-1", clock: s.clock };
  s.at("2026-11-16T09:00:00.000Z");
  escalate(escalation(), deps);
  s.at("2026-11-16T11:30:00.000Z");
  escalate(escalation({ detail: "the review gate failed again on the newest head." }), deps);
  s.at("2026-11-16T23:59:00.000Z");
  escalate(escalation({ detail: "third observation, newest body." }), deps);

  assert.equal(s.comments.length, 1, "one observation comment for the day, not three");
  assert.equal(s.edits.length, 2, "the second and third matches edited it");
  const body = s.comments[0]!.body;
  assert.match(body, /^Another escalation observed the same condition \(task W1-TROLL, PR #77\)/, "the heading the reader and the garden match on still leads");
  assert.match(body, /Observed 3 time\(s\) on 2026-11-16 \(UTC\): first 2026-11-16T09:00:00\.000Z, newest 2026-11-16T23:59:00\.000Z/);
  assert.match(body, /third observation, newest body\./, "the newest rendered body replaces the older one");
  assert.doesNotMatch(body, /failed again on the newest head/);
  assert.match(body, /<!-- rmd-observation:W1-TROLL count=3 first=2026-11-16T09:00:00\.000Z -->$/);
  assert.deepEqual(dedupRows(ledgerPath).map((r) => r.observation_comment), ["posted", "edited", "edited"]);
});

test("W1-T13218 criterion 2: a match on a later UTC day posts a new comment, and every match is still ledgered", async (t) => {
  const s = store();
  const ledgerPath = ledgerDir(t);
  const deps = { issues: s.issues, ledgerPath, runId: "RUN-1", clock: s.clock };
  s.at("2026-11-16T22:00:00.000Z");
  await escalateAsync(escalation(), deps);
  s.at("2026-11-16T23:00:00.000Z");
  await escalateAsync(escalation(), deps);
  s.at("2026-11-17T00:05:00.000Z");
  await escalateAsync(escalation(), deps);
  s.at("2026-11-17T08:00:00.000Z");
  await escalateAsync(escalation(), deps);

  assert.equal(s.comments.length, 2, "at most one observation comment per UTC day");
  assert.match(s.comments[0]!.body, /Observed 2 time\(s\) on 2026-11-16/);
  assert.match(s.comments[1]!.body, /Observed 2 time\(s\) on 2026-11-17 \(UTC\): first 2026-11-17T00:05:00\.000Z/);
  const rows = dedupRows(ledgerPath);
  assert.equal(rows.length, 4, "escalation.deduped is written once per match");
  assert.ok(rows.every((r) => r.issue_url === ISSUE_URL));
  assert.deepEqual(rows.map((r) => r.observation_comment), ["posted", "edited", "posted", "edited"]);
});

test("W1-T13218 criterion 3: an edited observation comment keeps the issue re-observed by its updated_at", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");
  const issue = { createdAt: "2026-11-01T00:00:00Z" };
  const raw = JSON.stringify([
    {
      user: { login: "remudero-fleet[bot]", type: "Bot" },
      author_association: "NONE",
      created_at: "2026-11-10T00:00:00Z",
      updated_at: "2026-11-20T11:00:00Z",
      body: "Another escalation observed the same condition (task W1-TROLL, PR #77) while this issue was already open",
    },
  ]);
  const comments = parseIssueCommentsRest(raw);
  assert.equal(comments[0]!.updatedAt, "2026-11-20T11:00:00Z", "the REST parse keeps updated_at");
  assert.equal(conditionReobserved(issue, comments, now), true, "edited an hour ago: live");
  assert.equal(
    conditionReobserved(issue, [{ ...comments[0]!, updatedAt: undefined }], now),
    false,
    "the same comment read by createdAt alone (10 days old) would not be live",
  );
});

test("W1-T13218 criterion 4: invariant:dedup-never-blocks-the-probe — a failed read or edit posts a new comment and never throws", async (t) => {
  const failedEdit = store({ failEdit: true });
  const ledgerA = ledgerDir(t);
  const depsA = { issues: failedEdit.issues, ledgerPath: ledgerA, runId: "RUN-1", clock: failedEdit.clock };
  failedEdit.at("2026-11-16T09:00:00.000Z");
  await escalateAsync(escalation(), depsA);
  failedEdit.at("2026-11-16T10:00:00.000Z");
  await assert.doesNotReject(escalateAsync(escalation(), depsA));
  assert.equal(failedEdit.comments.length, 2, "the failed edit fell back to a new comment");
  assert.deepEqual(dedupRows(ledgerA).map((r) => r.observation_comment), ["posted", "posted-after-edit-failed"]);

  const failedRead = store({ failList: true });
  const ledgerB = ledgerDir(t);
  failedRead.at("2026-11-16T09:00:00.000Z");
  assert.equal(escalate(escalation(), { issues: failedRead.issues, ledgerPath: ledgerB, runId: "RUN-1", clock: failedRead.clock }), ISSUE_URL);
  assert.equal(failedRead.comments.length, 1, "an unreadable list still posts the observation");
  assert.deepEqual(dedupRows(ledgerB).map((r) => r.observation_comment), ["posted-after-read-failed"]);

  const missing = store();
  const ledgerC = ledgerDir(t);
  missing.at("2026-11-16T09:00:00.000Z");
  const { listCommentsSince: _l, editComment: _e, ...appendOnly } = missing.issues;
  escalate(escalation(), { issues: appendOnly, ledgerPath: ledgerC, runId: "RUN-1" });
  escalate(escalation(), { issues: appendOnly, ledgerPath: ledgerC, runId: "RUN-1" });
  assert.equal(missing.comments.length, 2, "a gateway without list/edit keeps the old append path");
  assert.doesNotMatch(missing.comments[0]!.body, /rmd-observation/);
});

test("W1-T13218: the gh gateway reads today's comments with ?since= and edits a comment by id", async () => {
  const calls: string[][] = [];
  const gateway = ghIssueGatewayAsync("craigoley", "remudero", {
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1]?.includes("/comments?since=")) {
        return JSON.stringify([{ id: 42, body: "x", created_at: "2026-11-16T01:00:00Z", updated_at: "2026-11-16T02:00:00Z" }]);
      }
      return "";
    },
  });
  const listed = await gateway.listCommentsSince!(ISSUE_URL, "2026-11-16T00:00:00.000Z");
  assert.deepEqual(listed, [{ id: 42, body: "x", createdAt: "2026-11-16T01:00:00Z", updatedAt: "2026-11-16T02:00:00Z" }]);
  assert.deepEqual(calls[0], ["api", "repos/craigoley/remudero/issues/500/comments?since=2026-11-16T00%3A00%3A00.000Z&per_page=100", "--paginate"]);
  await gateway.editComment!(42, "new body");
  assert.deepEqual(calls[1], ["api", "-X", "PATCH", "repos/craigoley/remudero/issues/comments/42", "-f", "body=new body"]);
  await assert.rejects(Promise.resolve(gateway.listCommentsSince!("https://github.com/craigoley/remudero/pull/9/files", "2026-11-16T00:00:00.000Z")), /no issue number/);
});

test("W1-T13218: the observation marker reads task, count and first time, and refuses an unmarked comment", () => {
  assert.equal(ROLLING_OBSERVATION_RE.exec("Another escalation observed the same condition (task W1-TX)"), null);
  assert.equal(ROLLING_OBSERVATION_RE.exec("<!-- rmd-observation:W1-TX count=4 first=2026-11-16T09:00:00.000Z -->")?.[2], "4");
});
