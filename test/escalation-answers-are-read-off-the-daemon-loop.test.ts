import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config } from "../src/lib/config.js";
import { renderIssueBody, type OpenIssue } from "../src/lib/escalate.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { buildSweepHook } from "../src/run-task.js";
// A NAMESPACE import: the reader's async shape is what this file tests, and a named import of a symbol that
// changes shape would fail the whole file at load rather than red the one test that names it.
import * as answers from "../src/lib/escalation-answers.js";
import { ghShim } from "./helpers/gh-shim.js";

/**
 * W1-T6248 — ESCALATION ANSWERS ARE READ OFF THE DAEMON LOOP. The gateway ran every list and comment read through
 * synchronous ghExec and the tick called the reader synchronously each pass: a 20.3 s loop block in a live CPU profile,
 * 14.6 s of it the transport's blocking cadence wait. Reads now go through the async transport and the tick awaits them.
 *
 * FIXTURES ONLY: the gh stand-in, the question store and the ledger live in throwaway directories.
 */

const later = <T>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 5));

test("W1-T6248: the escalation-answer gateway never reads GitHub synchronously", async () => {
  const shim = ghShim([{ when: "", stdout: "[]" }], { kind: "t6248-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    const gateway = answers.ghEscalationAnswerGateway("o", "r");
    const listing = gateway.listOpen("needs-question");
    const comments = gateway.listComments(7);
    // A synchronous read has already run gh by the time the call returns; an async one has not started a child yet.
    assert.equal(shim.calls().length, 0, "no gh read ran on the calling thread");
    assert.ok(listing instanceof Promise && comments instanceof Promise, "each read is awaited, never returned whole");
    assert.deepEqual(await listing, []);
    assert.deepEqual(await comments, []);
    assert.ok(shim.calls().length >= 2, "control: the reads did reach gh once awaited");
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("W1-T6248: a reply read this tick is landed before open-PR views are built", async () => {
  // The reader resolves only once an async gateway's reply is in the question store buildOpenPrViews reads next.
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6248-reply-`));
  const issue: OpenIssue = { number: 601, url: "https://github.com/o/r/issues/601",
    body: renderIssueBody({ class: "BLOCKED", taskId: "W1-T9601", summary: "s", detail: "d",
      options: [{ label: "retry", detail: "r" }], recommendation: "retry" }) };
  const result = await answers.readEscalationAnswers(root, "RUN-T6248", {
    listOpen: () => later([issue]),
    listComments: () => later([{ id: 9601, body: "retry", authorLogin: "o", authorAssociation: "OWNER", authorType: "User" }]),
    reactPlusOne: () => {},
  }, { ledgerPath: join(root, "state", "ledger.ndjson") });
  assert.equal(result.accepted, 1);
  const store = join(root, "plan", "questions.ndjson");
  assert.ok(existsSync(store) && readFileSync(store, "utf8").includes("W1-T9601"), "the reply is in the store when the read resolves");

  // In the tick, an async read that fails is awaited inside the same pass: counted unreadable, never an unawaited throw.
  const logs: Array<{ step: string; extra: Record<string, unknown> }> = [];
  const tickRoot = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t6248-tick-`));
  const shim = ghShim([{ when: "", stdout: "[]" }], { kind: "t6248-tick-gh" });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${oldPath ?? ""}`;
  try {
    const hook = buildSweepHook("o", "r", { root: tickRoot, claudeBin: "/bin/true" } as Config, join(tickRoot, "ledger.ndjson"),
      "DAEMON-T6248", { tasks: [], byId: new Map() }, (step, extra = {}) => logs.push({ step, extra }),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { listOpen: () => Promise.reject(new Error("gh api: HTTP 502")), listComments: () => [], reactPlusOne: () => {} });
    await assert.doesNotReject(hook());
  } finally {
    process.env.PATH = oldPath;
    rmSync(shim.dir, { recursive: true, force: true });
  }
  assert.deepEqual(logs.find((l) => l.step === "escalation_answers.unreadable")?.extra, { accepted: 0, ignored: 0, unreadable: 1 });
  assert.ok(!logs.some((l) => l.step === "escalation_answers.error"), "the failed async read is awaited and counted, not thrown past");
});
