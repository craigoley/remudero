/**
 * test/every-inbox-message-is-plain-language.test.ts — W1-T4087.
 *
 * On 2026-09-22 every live inbox item showed its producer's raw diagnostic. Every item now carries
 * a plain message with the operator message standard's four parts and no machine text, written
 * once and stored; the raw summary stays for Details.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { inboxKind } from "../src/lib/inbox-owner.js";
import {
  backfillPlainMessages,
  checkPlainMessage,
  machineTokens,
  plainInboxMessage,
  plainStorePath,
  plainTemplate,
  readPlainStore,
  startPlainBackfill,
  TEMPLATED_KINDS,
  writePlainMessage,
  type PlainInboxMessage,
} from "../src/lib/inbox-plain.js";
import { runDaemon } from "../src/lib/daemon.js";
import { buildPanelGraphRoutes, type PanelGraphDeps } from "../src/lib/panel-graph.js";
import { loadPlan } from "../src/lib/plan.js";
import { createService } from "../src/lib/service.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { plainInboxWriter, type RunResult } from "../src/run-task.js";

// Verbatim live summaries, 2026-09-22 (one per kind, truncated where the live text ran on).
const LIVE = [
  {
    id: "adoption:field-no-writer:src/lib/plan.ts:context:",
    summary:
      'adoption-debt: "context:" (field-no-writer) in src/lib/plan.ts has shipped since 2026-07-14T07:15:30-04:00 with no adopter found — 0 raw `context:` key hits across plan/ — declared optional on Task, never written (rmd measurement-cadence\'s adoption report).',
  },
  {
    id: "rule-efficacy:CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition",
    summary:
      'promote-to-instrument: "CLAUDE.md#investigation-discipline:bound-fires-on-healthy-condition" (W1-T312, W1-T380/#1392, W1-T382/#1401) has recurred 31 time(s) since its effective date 2026-08-06',
  },
  { id: "proof-debt:W1-T2", summary: 'proof-debt: W1-T2 criterion 0 (name-filtered-zero-match) cannot resolve its proof against the checkout (rmd proof-queue-audit).' },
  { id: "followup:W1-T3999:research", summary: "follow-up harvest [research]: the PR title still carries a `DO NOT MERGE —` prefix" },
  { id: "skill-draft:implement-clean-single-strike-a4ce515f", summary: "--- name: implement-clean-single-strike-a4ce515f description: A procedure shape proven across 78 merged implement run(s)" },
  { id: "codeql-quality:js/unneeded-defensive-code", summary: "CodeQL quality debt for rule js/unneeded-defensive-code: 1 open alert tagged quality and maintainability (#144)." },
  { id: "verify-human-automate:W1-T216", summary: "W1-T216 was filed `verify: human` 63 days ago and a judge reads it as safe to enter the self-improvement flow" },
  { id: "FD-2026-09-10-fb-repair-conflicted-2957", summary: 'Feedback docket 2026-09-03..2026-09-10: 1 item(s) indict "fb-repair-conflicted-2957".' },
  { id: "verify-human:W1-T235", summary: "W1-T235 was filed `verify: human` 49 days ago and a judge reads it as still needing you: locked-login-keychain spawns can fail" },
  { id: "ruling:operator-owned", summary: "operator-owned" },
];

const CLEAN: PlainInboxMessage = {
  headline: "A planned task needs you to check it",
  whatHappened: "This task has waited a long time for a person to check it.",
  whatWeNeed: "Decide whether the fleet should go ahead or drop it.",
  ifNothingHappens: "The task stays blocked.",
  options: [
    { label: "Go ahead", consequence: "The fleet starts the work." },
    { label: "Drop it", consequence: "The item is closed." },
  ],
  source: "writer",
};
const asCard = (m: PlainInboxMessage) => ({ headline: m.headline, what_happened: m.whatHappened, decision: m.whatWeNeed, options: m.options });

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}w1t4087-`));
}

function seed(root: string, items: Array<{ id: string; summary: string }>): void {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "inbox-proposals.json"), JSON.stringify({ proposals: items.map((p) => ({ ...p, evidenceAnchors: [] })) }));
}

async function getInbox(root: string): Promise<Record<string, unknown>> {
  const planPath = join(root, "plan", "tasks.yaml");
  mkdirSync(join(root, "plan"), { recursive: true });
  writeFileSync(planPath, "[]\n");
  const deps: PanelGraphDeps = {
    root,
    inboxRoot: root,
    planPath,
    ledgerPath: join(root, "state", "ledger.ndjson"),
    github: { prView: () => null },
    statusGithub: { prByRef: () => null, findMergedByTrailer: () => null, headRefName: () => undefined, prBody: () => undefined },
    ratify: { approve: () => undefined, reframe: () => undefined },
  };
  const server = createService({ tokens: { read: "r", write: "w" }, routes: buildPanelGraphRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/inbox`, { headers: { authorization: "Bearer r" } });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  } finally {
    server.close();
  }
}

type Item = { proposalId: string; summary: string; plain: PlainInboxMessage };

test("W1-T4087: every inbox item carries a plain message with the four parts", async () => {
  const root = tmpRoot();
  seed(root, LIVE);
  // One item has a stored writer message; the rest fall back to their templates.
  writeFileSync(plainStorePath(join(root, "state")), JSON.stringify({ "verify-human:W1-T235": CLEAN }));
  const body = await getInbox(root);
  const items = (["ready", "drafting", "notReady", "declined"] as const).flatMap((lane) => body[lane] as Item[]);
  assert.equal(items.length, LIVE.length, "control: every live item is on the route");
  for (const item of items) {
    assert.deepEqual(checkPlainMessage(item.plain).problems, [], `${item.proposalId} has a plain message`);
    assert.notEqual(item.plain.whatHappened, item.summary, "the plain text is never the raw summary");
    assert.equal(item.summary, LIVE.find((l) => l.id === item.proposalId)!.summary, "the raw summary is kept for Details");
  }
  assert.equal(items.find((i) => i.proposalId === "verify-human:W1-T235")!.plain.source, "writer", "a stored message is served");
  for (const item of body.fleet as Item[]) assert.ok(item.plain.headline, `${item.proposalId} carries its plain message on the fleet list`);
});

test("W1-T4087: a plain message with code, paths or ids is refused and rewritten", async () => {
  // Control: the live adoption summary itself is full of machine text.
  const tokens = machineTokens(LIVE[0]!.summary);
  assert.ok(tokens.some((t) => t.startsWith("code span")), tokens.join(", "));
  assert.ok(tokens.some((t) => t.startsWith("file path")), tokens.join(", "));
  assert.ok(machineTokens("W1-T235 is waiting").some((t) => t.startsWith("task id")));
  assert.ok(machineTokens("run rmd approve now").some((t) => t.startsWith("command")));

  const contexts: string[] = [];
  const answers = [
    { ...asCard(CLEAN), what_happened: "The `context:` field in src/lib/plan.ts has no writer (W1-T3518)." },
    asCard(CLEAN),
  ];
  const message = await writePlainMessage(LIVE[0]!, {
    summarize: ({ context }) => {
      contexts.push(context);
      return answers.shift();
    },
  });
  assert.equal(contexts.length, 2, "the writer was asked twice");
  assert.match(contexts[1]!, /refused for: .*code span/, "the second ask names what was wrong");
  assert.equal(message.source, "writer");
  assert.deepEqual(checkPlainMessage(message).problems, []);

  // A stored message that no longer passes is not served.
  const stale = { ...CLEAN, headline: "Run rmd approve for W1-T235" };
  assert.equal(plainInboxMessage(LIVE[8]!, { [LIVE[8]!.id]: stale }).source, "template");
});

test("W1-T4087: a writer that keeps failing falls back to the plain template, never the raw summary", async () => {
  for (const proposal of LIVE) {
    const raw = { headline: "status", what_happened: proposal.summary, decision: "rmd approve it", options: [{ label: "a", consequence: "b" }, { label: "c", consequence: "d" }] };
    const echoed = await writePlainMessage(proposal, { summarize: () => raw });
    assert.equal(echoed.source, "template", `${proposal.id}: an echo of the raw text falls back`);
    assert.notEqual(echoed.whatHappened, proposal.summary);
    const thrown = await writePlainMessage(proposal, { summarize: () => { throw new Error("writer down"); } });
    assert.equal(thrown.source, "template");
    const junk = await writePlainMessage(proposal, { summarize: () => "not json" });
    assert.equal(junk.source, "template");
    assert.equal((await writePlainMessage(proposal)).source, "template", "no writer at all");
  }
});

test("W1-T4087: every live fleet kind has a plain template", () => {
  for (const proposal of LIVE) {
    const kind = inboxKind(proposal.id);
    assert.ok(TEMPLATED_KINDS.includes(kind), `${kind} has its own template`);
    const t = plainTemplate(proposal);
    assert.deepEqual(checkPlainMessage(t).problems, [], `${kind}'s template is plain`);
  }
  const unknown = plainTemplate({ id: "brand-new:x", summary: "x" });
  assert.deepEqual(checkPlainMessage(unknown).problems, [], "an unknown kind still gets a plain message");
  assert.match(plainTemplate(LIVE[8]!).whatHappened, /49 days/, "the verify-human template says how long it has waited");
});

test("W1-T4087: the backfill writes one operator item at a time and skips the fleet's", async () => {
  const root = tmpRoot();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const asked: string[] = [];
  const deps = {
    stateDir,
    readProposals: () => LIVE,
    summarize: ({ context }: { context: string }) => {
      asked.push(context);
      return asCard(CLEAN);
    },
  };
  assert.equal(await backfillPlainMessages(deps, 1), 1);
  assert.equal(await backfillPlainMessages(deps, 5), 1, "only two operator items exist");
  assert.equal(await backfillPlainMessages(deps, 5), 0, "nothing left to write");
  assert.deepEqual(Object.keys(readPlainStore(plainStorePath(stateDir))).sort(), ["ruling:operator-owned", "verify-human:W1-T235"]);
  assert.equal(asked.length, 2, "fleet items are never sent to the writer");

  writeFileSync(plainStorePath(stateDir), "{ not json");
  assert.deepEqual(readPlainStore(plainStorePath(stateDir)), {}, "an unreadable store reads as empty");
  writeFileSync(plainStorePath(stateDir), "[]");
  assert.deepEqual(readPlainStore(plainStorePath(stateDir)), {}, "a store of the wrong shape reads as empty");
});

test("W1-T4087: the backfill runs on its own timer and logs a failure without stopping", async () => {
  const root = tmpRoot();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const lines: string[] = [];
  let reads = 0;
  const pump = startPlainBackfill(
    {
      stateDir,
      readProposals: () => {
        reads += 1;
        if (reads === 1) throw new Error("registry unreadable");
        return LIVE;
      },
    },
    10,
    (step) => lines.push(step),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  pump.stop();
  await pump.settled();
  assert.ok(lines.includes("inbox.plain_failed"), "the throwing read is logged");
  assert.ok(lines.includes("inbox.plain_written"), "a later tick still writes");
  assert.equal(Object.keys(JSON.parse(readFileSync(plainStorePath(stateDir), "utf8"))).length, 2);
});

test("W1-T4087: the daemon's writer is built from the cheapest mount, or left out when it cannot be", () => {
  const root = tmpRoot();
  const lines: string[] = [];
  // The real settings template in this checkout: the writer is built.
  const built = plainInboxWriter({ claudeBin: "/bin/true", root, installRoot: process.cwd() } as never, (s) => lines.push(s));
  assert.equal(typeof built, "function");
  // An install root with no settings template: the writer is left out, and the backfill writes templates.
  const missing = plainInboxWriter({ claudeBin: "/bin/true", root, installRoot: tmpRoot() } as never, (s) => lines.push(s));
  assert.equal(missing, undefined);
  assert.deepEqual(lines, ["inbox.plain_writer_unavailable"]);
});

test("W1-T4087: the daemon writes plain messages while its main loop is busy", async () => {
  const root = tmpRoot();
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(root, "tasks.yaml"), "- id: A\n  title: a\n  repo: remudero\n  type: implement\n  depends_on: []\n  status: queued\n");
  let writtenWhileBusy = false;
  let busy = false;
  await runDaemon(
    loadPlan(join(root, "tasks.yaml")),
    {
      refreshMerged: () => () => false,
      runOne: async (id): Promise<RunResult> => {
        busy = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
        busy = false;
        return { taskId: id, runId: `${id}-run`, merged: true, costUsd: 0, verdict: "merged" };
      },
      plainBackfill: {
        stateDir,
        readProposals: () => LIVE,
        summarize: () => {
          if (busy) writtenWhileBusy = true;
          return asCard(CLEAN);
        },
      },
      sleep: async () => {},
      log: () => {},
    },
    { headroomEnabled: false, max: 1, pollIntervalMs: 20 },
  );
  assert.equal(writtenWhileBusy, true, "a plain message was written while the loop was inside runOne");
  assert.ok(Object.keys(readPlainStore(plainStorePath(stateDir))).length >= 1);
});
