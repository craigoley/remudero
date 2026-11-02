import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { fixedClock } from "#src/lib/clock.js";
import {
  defaultGardenGhRun,
  gardenClosePr,
  gardenStatePath,
  readGardenState,
  runGarden,
  runGardenAsync,
  type GardenAction,
  type GardenCheckout,
  type GardenCloseOutcome,
  type GardenSpec,
  type PrState,
} from "#src/lib/gardener.js";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghStubPath, pathWith } from "#test/helpers/gh-stub.js";

const AT = Date.parse("2026-10-29T19:27:16Z");
const BACKSTOP = 24 * 3_600_000;
const HELD = "https://github.com/acme/demo/pull/15551";
const NEXT = "https://github.com/acme/demo/pull/15600";
type Class = "refresh";

function fixture(closePr?: (url: string, reason: string) => GardenCloseOutcome | Promise<GardenCloseOutcome>) {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-close-`));
  const path = gardenStatePath(dir, "review-replay");
  const classes = { refresh: { alpha: 100, beta: 1 } };
  writeFileSync(path, JSON.stringify({ classes, pending: { prUrl: HELD, actionClass: "refresh", baseline: { trials: 0, successes: 0 } },
    pendingRecordedAt: new Date(AT).toISOString(), lastCheap: "stable", lastPass: { fingerprint: "stable" } }));
  let at = AT;
  let pr: PrState = "open";
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const action: GardenAction<Class> = { class: "refresh", target: "sample", reason: "newer recorded inputs" };
  const spec: GardenSpec<Class, null, GardenAction<Class>, GardenCheckout> = {
    name: "review-replay", classes: ["refresh"], decision: ["refresh"],
    cheapFingerprint: () => "stable", inventory: () => null, fingerprint: () => "stable",
    candidates: () => [action], scorecard: () => ({}),
    apply: () => ({ paths: ["test/fixtures/review-replay/sample.ndjson"], title: "chore(test): refresh recorded review inputs", body: "refresh" }),
  };
  const deps = () => ({
    stateDir: dir, repoRoot: dir, clock: fixedClock(at), seed: 1,
    prState: (): PrState => pr,
    openWorkspace: (): GardenCheckout => ({ root: dir, land: () => NEXT, dispose: () => {} }),
    log: (step: string, extra?: Record<string, unknown>) => rows.push({ step, extra }),
    ...(closePr ? { closePr } : {}),
  });
  return {
    dir, spec, deps, rows, read: () => readGardenState(path, spec.classes),
    at: (v: number) => { at = v; }, pr: (v: PrState) => { pr = v; },
    closed: () => rows.filter((r) => r.step === "review-replay.pending_closed").map((r) => r.extra),
  };
}

test("garden release: a decision PR released past its backstop is closed with a reason before the newer refresh files", async () => {
  const calls: Array<{ url: string; reason: string }> = [];
  const g = fixture(async (url, reason) => { calls.push({ url, reason }); return { closed: true }; });
  try {
    g.at(AT + BACKSTOP - 1);
    await runGardenAsync(g.spec, g.deps());
    assert.equal(calls.length, 0, "not yet overdue: nothing is closed");
    g.at(AT + BACKSTOP);
    const pass = await runGardenAsync(g.spec, g.deps());
    assert.equal(pass.prUrl, NEXT, "the newer refresh still files in the same pass");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, HELD);
    assert.match(calls[0].reason, /^Closed by the review-replay gardener: .*24h backstop unjudged.*supersedes this one\.$/);
    assert.deepEqual(g.closed(), [{ pr_url: HELD, closed: true }]);
    assert.equal(g.read().pending?.prUrl, NEXT);
  } finally { rmSync(g.dir, { recursive: true, force: true }); }
});

test("garden release: a refused or failing close is ledgered with its reason and never aborts the pass", async () => {
  for (const close of [
    (): GardenCloseOutcome => ({ closed: false, reason: "a non-bot author's review comments keep a conversation open" }),
    (): GardenCloseOutcome => { throw new Error("gh exited 1"); },
  ]) {
    const g = fixture(close);
    try {
      g.at(AT + BACKSTOP);
      assert.equal((await runGardenAsync(g.spec, g.deps())).prUrl, NEXT);
      const [row] = g.closed();
      assert.equal(row?.closed, false);
      assert.match(String(row?.reason), /conversation open|close failed: gh exited 1/);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  }
});

test("garden release: a terminal or unknown PR is judged, never closed by the garden", () => {
  for (const state of ["merged", "closed", "unknown"] as const) {
    let calls = 0;
    const g = fixture(() => { calls++; return { closed: true }; });
    try {
      g.at(AT + 2 * BACKSTOP);
      g.pr(state);
      runGarden(g.spec, g.deps());
      assert.equal(calls, 0, state);
      assert.deepEqual(g.closed(), [], state);
    } finally { rmSync(g.dir, { recursive: true, force: true }); }
  }
});

function closer(over: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    "repos/acme/demo/pulls/15551": { state: "open", merged: false, user: { login: "remudero-fleet[bot]", type: "Bot" } },
    "repos/acme/demo/pulls/15551/reviews?per_page=100": [{ user: { login: "remudero-fleet[bot]", type: "Bot" }, state: "COMMENTED" }],
    "repos/acme/demo/pulls/15551/comments?per_page=100": [],
    "repos/acme/demo/issues/15551/comments?per_page=100": [{ user: { login: "remudero-fleet[bot]", type: "Bot" }, body: "stall report" }],
    ...over,
  };
  const runs: string[][] = [];
  const close = () => gardenClosePr("acme", "demo", HELD, "garden reason", (args) => {
    if (!(args[1] in responses)) throw new Error(`unexpected ${args[1]}`);
    return responses[args[1]];
  }, async (args) => { runs.push([...args]); });
  return { close, runs };
}

test("gardenClosePr closes an open bot-authored PR with no human conversation, preserving the branch", async () => {
  const c = closer();
  assert.deepEqual(await c.close(), { closed: true });
  assert.deepEqual(c.runs, [["pr", "close", HELD, "--comment", "garden reason"]]);
});

test("gardenClosePr never ends a human's open conversation or touches a PR it does not own", async () => {
  const human = { login: "craigoley", type: "User" };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["human review", { "repos/acme/demo/pulls/15551/reviews?per_page=100": [{ user: human, state: "CHANGES_REQUESTED" }] }],
    ["human review comment", { "repos/acme/demo/pulls/15551/comments?per_page=100": [{ user: human, body: "hold on" }] }],
    ["unreadable author", { "repos/acme/demo/pulls/15551/comments?per_page=100": [{ body: "who" }] }],
    ["human conversation comment", { "repos/acme/demo/issues/15551/comments?per_page=100": [{ user: human, body: "please keep this open" }] }],
    ["non-bot author", { "repos/acme/demo/pulls/15551": { state: "open", merged: false, user: human } }],
    ["already closed", { "repos/acme/demo/pulls/15551": { state: "closed", merged: false, user: { login: "x[bot]" } } }],
    ["merged", { "repos/acme/demo/pulls/15551": { state: "open", merged: true, user: { login: "x[bot]" } } }],
    ["reviews unreadable", { "repos/acme/demo/pulls/15551/reviews?per_page=100": { message: "rate limited" } }],
    ["reviews unbounded", { "repos/acme/demo/pulls/15551/reviews?per_page=100": Array.from({ length: 100 }, () => ({ user: { login: "x[bot]" } })) }],
  ];
  for (const [name, over] of cases) {
    const c = closer(over);
    const result = await c.close();
    assert.equal(result.closed, false, name);
    assert.deepEqual(c.runs, [], name);
  }
  const bad = await gardenClosePr("acme", "demo", "https://github.com/acme/demo/issues/1", "r", () => assert.fail("no read"), async () => assert.fail("no run"));
  assert.deepEqual(bad, { closed: false, reason: "no PR number in the url" });
});

test("gardenClosePr never closes a PR whose Conversation tab carries a human comment", async () => {
  const human = { login: "craigoley", type: "User" };
  const talked = closer({ "repos/acme/demo/issues/15551/comments?per_page=100": [
    { user: { login: "remudero-fleet[bot]", type: "Bot" }, body: "stall report" },
    { user: human, body: "I am still looking at this" },
  ] });
  assert.deepEqual(await talked.close(), { closed: false, reason: "a non-bot author's conversation comments keep a conversation open" });
  assert.deepEqual(talked.runs, []);
  const unread = closer({ "repos/acme/demo/issues/15551/comments?per_page=100": { message: "rate limited" } });
  assert.deepEqual(await unread.close(), { closed: false, reason: "conversation comments unreadable or unbounded" });
  assert.deepEqual(unread.runs, []);
});

test("defaultGardenGhRun really shells out to gh with the close argv, and rejects on a nonzero exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}garden-gh-`));
  const saved = process.env.PATH;
  try {
    const record = join(dir, "argv");
    const bin = ghStubPath(`#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n[ "$1" = "fail" ] && { echo refused >&2; exit 1; }\nexit 0\n`);
    process.env.PATH = pathWith(bin);
    await defaultGardenGhRun(["pr", "close", HELD, "--comment", "garden reason"]);
    assert.equal(readFileSync(record, "utf8"), `pr\nclose\n${HELD}\n--comment\ngarden reason\n`);
    await assert.rejects(defaultGardenGhRun(["fail"]), /refused|Command failed/);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
