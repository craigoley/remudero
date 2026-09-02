import assert from "node:assert/strict";
import { test } from "node:test";
import { mapBoardPr, type RestPullRow } from "../src/lib/open-prs-rest.js";
import { buildBatchedGithub, type BatchedPr, type PrRef } from "../src/lib/status.js";

const HEAD_ONE = "1111111111111111111111111111111111111111";
const HEAD_TWO = "2222222222222222222222222222222222222222";
const BRANCH = "run-W1-T2727-1";

function openRow(number: number, sha?: string): RestPullRow {
  return {
    number,
    html_url: `https://github.com/craigoley/remudero/pull/${number}`,
    state: "open",
    merged_at: null,
    body: "Remudero-Task: W1-T2727\n",
    updated_at: "2026-09-02T19:30:00Z",
    head: { ref: BRANCH, ...(sha === undefined ? {} : { sha }) },
    title: "fix(board): preserve the current PR head",
  };
}

test("the board row and open-PR projection carry REST head.sha on the existing fetch", () => {
  assert.equal(mapBoardPr(openRow(3708, HEAD_ONE)).headRefOid, HEAD_ONE);

  const calls: string[][] = [];
  const gateway = buildBatchedGithub("craigoley", "remudero", {
    exec: (args) => {
      calls.push(args);
      return JSON.stringify([openRow(3708, HEAD_ONE)]);
    },
  });

  const open = gateway.listOpenHeadBranches?.();
  assert.equal(open?.[0]?.headRefOid, HEAD_ONE);
  assert.equal(calls.length, 1, "head identity adds no REST, GraphQL or per-PR request");
  assert.match(calls[0]?.[1] ?? "", /\/pulls\?state=open/);
});

test("an expired open-half refresh replaces the SHA after a push while the branch stays the same", () => {
  let now = 0;
  let sha = HEAD_ONE;
  const calls: string[][] = [];
  const gateway = buildBatchedGithub("craigoley", "remudero", {
    ttlMs: 1_000,
    now: () => now,
    exec: (args) => {
      calls.push(args);
      return JSON.stringify([openRow(3708, sha)]);
    },
  });

  const before = gateway.listOpenHeadBranches?.()?.[0];
  sha = HEAD_TWO;
  now = 1_001;
  const after = gateway.listOpenHeadBranches?.()?.[0];

  assert.equal(before?.headRefName, BRANCH);
  assert.equal(after?.headRefName, BRANCH);
  assert.equal(before?.headRefOid, HEAD_ONE);
  assert.equal(after?.headRefOid, HEAD_TWO);
  assert.equal(calls.length, 2, "one existing open-board request per refresh, no SHA lookup");
});

test("legacy injected rows remain valid and an omitted head is distinct from an exact match", () => {
  const legacyRef: PrRef = { number: 1, url: "u1", state: "OPEN" };
  const legacyRow: BatchedPr = { number: 2, url: "u2", state: "OPEN", headRefName: BRANCH };
  const exactRow: BatchedPr = { number: 3, url: "u3", state: "OPEN", headRefName: BRANCH, headRefOid: HEAD_ONE };
  const gateway = buildBatchedGithub("craigoley", "remudero", { fetchAll: () => [legacyRow, exactRow] });

  assert.equal(legacyRef.headRefOid, undefined);
  const open = gateway.listOpenHeadBranches?.() ?? [];
  assert.equal(open.find((row) => row.number === 2)?.headRefOid, undefined);
  assert.equal(open.find((row) => row.number === 3)?.headRefOid, HEAD_ONE);
});

test("failure and truncation signals are unchanged and rows without REST head.sha gain no identity", () => {
  const failed = buildBatchedGithub("craigoley", "remudero", {
    exec: () => {
      throw new Error("transport down");
    },
  });
  assert.equal(failed.listOpenHeadBranches?.(), null);
  assert.equal(failed.readFailed?.(), true);
  assert.equal(failed.readTruncated?.(), false);

  let calls = 0;
  const truncated = buildBatchedGithub("craigoley", "remudero", {
    exec: (args) => {
      calls += 1;
      const url = args[1] ?? "";
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? "1");
      return JSON.stringify(Array.from({ length: 100 }, (_, i) => openRow(page * 100 + i)));
    },
  });

  const open = truncated.listOpenHeadBranches?.() ?? [];
  assert.equal(calls, 50, "the existing board ceiling is unchanged");
  assert.equal(truncated.readTruncated?.(), true);
  assert.equal(open.length, 5_000);
  assert.equal(open.every((row) => row.headRefOid === undefined), true);
});
