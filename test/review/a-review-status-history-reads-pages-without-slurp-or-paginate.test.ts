import assert from "node:assert/strict";
import { test } from "node:test";

import { readReviewStatusHistory } from "#src/lib/review.js";

const SHA = "a".repeat(40);
const PR = "https://github.com/o/r/pull/7";
const PREFIX = "GitHub remudero-review status history unreadable";

type Row = Record<string, unknown>;
type Call = { args: string[]; options: unknown };

function status(id: number, state: string, context = "remudero-review"): Row {
  return { id, context, state, created_at: `2026-11-09T00:00:${String(id % 60).padStart(2, "0")}Z`,
    description: `d${id}`, target_url: `https://example.test/${id}` };
}

function filler(from: number, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => status(from + i, "pending", "other-context"));
}

function review(body: string, commit = SHA): Row {
  return { commit_id: commit, body };
}

/** A recording fake of the host CLI reader: serves pages of the given row lists by the page parameter. */
function fake(statusRows: Row[], reviewRows: Row[] = [], override?: (args: string[]) => unknown) {
  const calls: Call[] = [];
  const readJson = (args: string[], options: unknown): unknown => {
    calls.push({ args, options });
    if (override) {
      const out = override(args);
      if (out !== undefined) return out;
    }
    const endpoint = args[1] as string;
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1]);
    const rows = endpoint.includes("/statuses") ? statusRows : reviewRows;
    return rows.slice((page - 1) * 100, page * 100);
  };
  return { calls, readJson: readJson as (a: string[], o: { fresh: true }) => unknown };
}

const read = (readJson: (a: string[], o: { fresh: true }) => unknown) =>
  readReviewStatusHistory("o", "r", PR, SHA, readJson);

const FAIL_BODY = "remudero-review = failure\n1. first claim\nproof executed and FAILED: AssertionError at a.ts:1\n---\n";
const FAIL_BODY_TWO = "remudero-review = failure\n2. second claim\nproof executed and FAILED: Error at b.ts:2\n---\n";

test("W1-T11848 criterion 1: pages are plain per_page=100 plus page=N, never slurp or paginate, stopping at a short page", async () => {
  const rows = [...filler(1000, 100), ...filler(2000, 100), status(1, "success")];
  const f = fake(rows);
  const result = await read(f.readJson);
  assert.equal(result.kind, "readable");
  assert.deepEqual(f.calls.map((c) => c.args), [
    ["api", `repos/o/r/commits/${SHA}/statuses?per_page=100&page=1`],
    ["api", `repos/o/r/commits/${SHA}/statuses?per_page=100&page=2`],
    ["api", `repos/o/r/commits/${SHA}/statuses?per_page=100&page=3`],
  ]);
  for (const c of f.calls) {
    assert.deepEqual(c.options, { fresh: true });
    assert.ok(!c.args.some((a) => a.includes("--slurp") || a.includes("--paginate")));
  }
});

test("W1-T11848 criterion 1: a short first page is the only read", async () => {
  const f = fake([status(1, "success")]);
  assert.equal((await read(f.readJson)).kind, "readable");
  assert.equal(f.calls.length, 1);
});

test("W1-T11848 criterion 1: a wrapped full status page does not hide a later review failure", async () => {
  const f = fake([], [review(FAIL_BODY)], (args) => {
    const endpoint = args[1] as string;
    if (endpoint.includes("/statuses") && endpoint.endsWith("page=1")) return [filler(1000, 100)];
    if (endpoint.includes("/statuses") && endpoint.endsWith("page=2")) return [[status(5, "failure")]];
    return undefined;
  });
  const result = await read(f.readJson);
  assert.equal(result.kind, "readable");
  assert.deepEqual(result.kind === "readable" ? result.failures.map((x) => x.criterion) : [], [1]);
  assert.deepEqual(f.calls.filter((c) => (c.args[1] as string).includes("/statuses")).map((c) => c.args[1]), [
    `repos/o/r/commits/${SHA}/statuses?per_page=100&page=1`,
    `repos/o/r/commits/${SHA}/statuses?per_page=100&page=2`,
  ]);
});

test("W1-T11848 criterion 2: a history still full at the page cap is unreadable, never truncated", async () => {
  const f = fake([], [], (args) => (args[1] as string).includes("/statuses") ? filler(1, 100) : undefined);
  const result = await read(f.readJson);
  assert.equal(result.kind, "unreadable");
  assert.ok(result.kind === "unreadable" && result.reason.startsWith(PREFIX));
  assert.equal(f.calls.length, 10);
});

test("W1-T11848 criterion 2: a non-list page is unreadable", async () => {
  const f = fake([], [], () => ({ message: "nope" }));
  const result = await read(f.readJson);
  assert.equal(result.kind, "unreadable");
  assert.ok(result.kind === "unreadable" && result.reason.startsWith(PREFIX));
});

test("W1-T11848 criterion 2: a row without its context or state is unreadable", async () => {
  for (const bad of [{ state: "success" }, { context: "remudero-review" }, { context: "x", state: "bogus" }]) {
    const f = fake([bad]);
    const result = await read(f.readJson);
    assert.equal(result.kind, "unreadable");
    assert.ok(result.kind === "unreadable" && result.reason.startsWith(PREFIX));
  }
});

test("W1-T11848 criterion 3: reviews are read the same way and only when a remudero-review failure exists", async () => {
  const none = fake([status(1, "success")]);
  await read(none.readJson);
  assert.ok(none.calls.every((c) => (c.args[1] as string).includes("/statuses")));

  const rows = [...filler(1000, 100), status(5, "failure")];
  const f = fake(rows, [review(FAIL_BODY)]);
  const result = await read(f.readJson);
  assert.equal(result.kind, "readable");
  const reviewCalls = f.calls.filter((c) => (c.args[1] as string).includes("/pulls/7/reviews"));
  assert.deepEqual(reviewCalls.map((c) => c.args), [["api", "repos/o/r/pulls/7/reviews?per_page=100&page=1"]]);
  assert.ok(f.calls.every((c) => !c.args.some((a) => a.includes("--slurp") || a.includes("--paginate"))));
});

test("W1-T11848 criterion 3: review rows keep their order across pages", async () => {
  const pad = Array.from({ length: 99 }, () => review("unrelated", "b".repeat(40)));
  const ordered = [review(FAIL_BODY), ...pad, review(FAIL_BODY_TWO)];
  const f = fake([status(5, "failure")], ordered);
  const result = await read(f.readJson);
  assert.equal(result.kind, "readable");
  assert.deepEqual(result.kind === "readable" ? result.failures.map((x) => x.criterion) : [], [1, 2]);
  const pages = f.calls.filter((c) => (c.args[1] as string).includes("/reviews")).map((c) => c.args[1]);
  assert.deepEqual(pages, [
    "repos/o/r/pulls/7/reviews?per_page=100&page=1",
    "repos/o/r/pulls/7/reviews?per_page=100&page=2",
  ]);
});

test("W1-T11848 criterion 3: a wrapped full review page does not hide the next failure", async () => {
  const pad = Array.from({ length: 99 }, () => review("unrelated", "b".repeat(40)));
  const f = fake([status(5, "failure")], [], (args) => {
    const endpoint = args[1] as string;
    if (!endpoint.includes("/reviews")) return undefined;
    if (endpoint.endsWith("page=1")) return [[review(FAIL_BODY), ...pad]];
    if (endpoint.endsWith("page=2")) return [[review(FAIL_BODY_TWO)]];
    return [];
  });
  const result = await read(f.readJson);
  assert.equal(result.kind, "readable");
  assert.deepEqual(result.kind === "readable" ? result.failures.map((x) => x.criterion) : [], [1, 2]);
  assert.deepEqual(f.calls.filter((c) => (c.args[1] as string).includes("/reviews")).map((c) => c.args[1]), [
    "repos/o/r/pulls/7/reviews?per_page=100&page=1",
    "repos/o/r/pulls/7/reviews?per_page=100&page=2",
  ]);
});

test("W1-T11848 criterion 4: a multi-page history gives the same verdict as the same rows in one page", async () => {
  const head = [status(9, "failure"), status(8, "success"), status(7, "failure")];
  const fillers = filler(100, 97);
  const rows = [...head, ...fillers, status(3, "failure"), status(2, "success"), status(1, "failure")];
  const multi = await read(fake(rows, [review(FAIL_BODY)]).readJson);
  const small = [...head, status(3, "failure"), status(2, "success"), status(1, "failure")];
  const single = await read(fake(small, [review(FAIL_BODY)]).readJson);
  assert.equal(multi.kind, "readable");
  assert.deepEqual(multi, single);
  assert.ok(multi.kind === "readable" && multi.revision !== undefined);

  const terminalSuccess = [status(4, "success"), ...filler(100, 99), status(3, "failure")];
  const a = await read(fake(terminalSuccess, [review(FAIL_BODY)]).readJson);
  const b = await read(fake([status(4, "success"), status(3, "failure")], [review(FAIL_BODY)]).readJson);
  assert.deepEqual(a, b);
});
