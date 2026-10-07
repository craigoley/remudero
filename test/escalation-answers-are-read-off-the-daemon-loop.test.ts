import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ghEscalationAnswerGateway, type EscalationAnswerGateway } from "../src/lib/escalation-answers.js";
import type { GhAsyncExecutor } from "../src/lib/github-transport.js";
import type { Config } from "../src/lib/config.js";
import type { GitHub } from "../src/lib/status.js";

const sweepRoot = mkdtempSync(join(tmpdir(), "rmd-escalation-sweep-"));
let sweepModule: typeof import("../src/run-task.js") | undefined;

async function loadSweepModule() {
  if (sweepModule) return sweepModule;
  // The module resolves its root at import time. An explicit scratch root prevents a git
  // root probe and keeps the reader and view builder on the same isolated question store.
  const savedArgv = [...process.argv];
  process.argv.splice(2, process.argv.length - 2, "--repo-root", sweepRoot);
  try {
    sweepModule = await import("../src/run-task.js");
    return sweepModule;
  } finally {
    process.argv.splice(0, process.argv.length, ...savedArgv);
  }
}

test("W1-T6248: the escalation-answer gateway never reads GitHub synchronously", async (t) => {
  const syncSpawn = t.mock.method(childProcess, "execFileSync", () => assert.fail("unexpected synchronous spawn"));
  syncBuiltinESMExports();
  t.after(() => { syncSpawn.mock.restore(); syncBuiltinESMExports(); });
  const calls: string[][] = [];
  const execAsync: GhAsyncExecutor = async (file, args) => {
    assert.equal(file, "gh");
    calls.push([...args]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const stdout = args[1].includes("comments")
      ? '[{"id":3,"body":"retry","author_association":"OWNER","user":{"login":"o"}}][{"id":4}]'
      : args[1].includes("reactions")
        ? '[{"id":5,"content":"+1","user":{"login":"o"}}][{"id":6}]'
        : '[{"number":2,"html_url":"u2","body":"**Task:** W1-T6248"}]';
    return { stdout, stderr: "" };
  };
  const writes: string[][] = [];
  const gateway = ghEscalationAnswerGateway("o", "r", {
    exec: (args) => {
      assert.ok(args.includes("content=+1"), "a synchronous read must never reach the write transport");
      writes.push(args);
      return "";
    },
  }, execAsync);
  assert.deepEqual((await gateway.listOpen("needs-question")).map((i) => [i.number, i.url, i.body]), [[2, "u2", "**Task:** W1-T6248"]]);
  assert.deepEqual((await gateway.listComments(2)).map((c) => c.id), [3, 4]);
  assert.deepEqual((await gateway.listReactions!(2)).map((r) => r.id), [5, 6]);
  assert.deepEqual(calls, [
    ["api", "repos/o/r/issues?labels=needs-question&state=open&per_page=100", "--paginate"],
    ["api", "repos/o/r/issues/2/comments?per_page=100", "--paginate"],
    ["api", "repos/o/r/issues/2/reactions?per_page=100", "--paginate"],
  ]);
  gateway.reactPlusOne(3);
  gateway.reactPlusOneOnIssue!(2);
  assert.deepEqual(writes, [
    ["api", "repos/o/r/issues/comments/3/reactions", "-f", "content=+1"],
    ["api", "repos/o/r/issues/2/reactions", "-f", "content=+1"],
  ]);
});

test("W1-T6248: a reply read this tick is landed before open-PR views are built", async (t) => {
  const { buildSweepHook, buildOpenPrViews } = await loadSweepModule();
  const root = sweepRoot;
  rmSync(join(root, "plan", "questions.ndjson"), { force: true });
  const events: string[] = [];
  const gateway: EscalationAnswerGateway = {
    listOpen: async () => [{ number: 2, url: "u2", body: "**Task:** W1-T6248" }],
    listComments: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push("reply");
      return [{ id: 3, body: "retry", authorAssociation: "OWNER", authorLogin: "o", authorType: "User" }];
    },
    reactPlusOne: () => { events.push("ack"); },
  };
  let observed: Array<Record<string, unknown>> = [];
  const originalRead = fs.readFileSync;
  const storeRead = t.mock.method(fs, "readFileSync", (path: fs.PathOrFileDescriptor, options: Parameters<typeof fs.readFileSync>[1]) => {
    const contents = originalRead(path, options);
    if (path === join(root, "plan", "questions.ndjson")) {
      events.push("views");
      observed = JSON.parse(`[${contents.toString().trim()}]`);
    }
    return contents;
  });
  syncBuiltinESMExports();
  t.after(() => { storeRead.mock.restore(); syncBuiltinESMExports(); });
  const hook = buildSweepHook("o", "r", { root } as Config, join(root, "ledger.ndjson"), "RUN",
    { tasks: [], byId: new Map() }, () => {}, undefined, {} as GitHub,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    gateway, undefined, async () => {
      buildOpenPrViews("o", "r", join(root, "ledger.ndjson"), {
        openPrRows: [], requiredContexts: () => [], readCiGateRequired: () => [],
      });
      // Stop before any downstream rung can fetch GitHub, reap worktrees, or dispatch.
      throw new Error("stop after observing the view input");
    });
  await assert.rejects(hook(), /stop after observing the view input/);
  assert.deepEqual(events, ["reply", "ack", "views"]);
  assert.equal(observed[0]?.answer, "retry");
  assert.equal(observed[0]?.origin, "issue#2:comment:3");
});

test("W1-T6248: a reply read this tick refreshes a prebuilt view without mutating its snapshot", async (t) => {
  const { buildSweepHook } = await loadSweepModule();
  const root = sweepRoot;
  rmSync(join(root, "plan", "questions.ndjson"), { force: true });
  const events: string[] = [];
  const gateway: EscalationAnswerGateway = {
    listOpen: async () => [{ number: 2, url: "u2", body: "**Task:** W1-T6248" }],
    listComments: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      events.push("reply");
      return [{ id: 3, body: "retry", authorAssociation: "OWNER", authorLogin: "o", authorType: "User" }];
    },
    reactPlusOne: () => {},
  };
  let observed: Array<{ pendingAnswer?: { constraint: string } }> = [];
  const clone = structuredClone;
  t.mock.method(globalThis, "structuredClone", (value: unknown) => {
    const result = clone(value);
    observed = result as typeof observed;
    return result;
  });
  const snapshot = {
    openPrViews: [{ taskId: "W1-T6248" }, {}],
    get mergedFixPrNumbers(): number[] {
      events.push("views");
      // The first downstream rung asks for merge facts only after local answers were refreshed.
      throw new Error("stop after observing the view input");
    },
  };
  type TickRead = NonNullable<Awaited<ReturnType<NonNullable<Parameters<typeof buildSweepHook>[20]>>>>;
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const hook = buildSweepHook("o", "r", { root } as Config, join(root, "ledger.ndjson"), "RUN",
    { tasks: [], byId: new Map() }, (step, extra) => { logs.push({ step, extra }); }, undefined, {} as GitHub,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    gateway, undefined, async () => { events.push("snapshot"); return snapshot as TickRead; });
  await hook();
  assert.deepEqual(events, ["reply", "snapshot", "views"]);
  assert.equal(observed[0]?.pendingAnswer?.constraint, "retry");
  assert.equal(observed[1]?.pendingAnswer, undefined, "a view without a task acquires no steering");
  assert.deepEqual(snapshot.openPrViews, [{ taskId: "W1-T6248" }, {}]);
  assert.deepEqual(logs, [{ step: "sweep.error", extra: { error: "stop after observing the view input" } }]);
});
