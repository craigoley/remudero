/**
 * W1-T12954: the batched gateway's trailer lookups answer from one trailer index for each merged index. Before, each
 * call built a regular expression and tested it against every merged PR body; the retro trigger's shippedSince made
 * one such call for each run and blocked the core loop for 58.6 s.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBatchedGithub, type BatchedPr, type PrRef } from "#src/lib/status.js";

const url = (n: number) => `https://github.com/o/r/pull/${n}`;
const merged = (number: number, body: string, state = "MERGED"): BatchedPr => ({ number, url: url(number), state, body });

/** Today's answer, the regular expression each call built before W1-T12954, over the newest-first merged list. */
function oracle(rows: readonly BatchedPr[], taskId: string): number[] {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchored = new RegExp(`^Remudero-Task:\\s*${escaped}\\s*$`, "m");
  return rows.filter((p) => p.state === "MERGED").sort((a, b) => b.number - a.number)
    .filter((p) => anchored.test(p.body ?? "")).map((p) => p.number);
}

test("W1-T12954 criterion 4: 500 lookups over 14,000 merged PRs make one pass over the bodies", () => {
  let bodyReads = 0;
  const rows: BatchedPr[] = Array.from({ length: 14_000 }, (_, i) => {
    const number = i + 1;
    const body = number % 7 === 0 ? "no trailer here" : `fix things\n\nRemudero-Task: W1-T${number}\n`;
    return Object.defineProperty({ number, url: url(number), state: "MERGED" }, "body", {
      enumerable: true, get: () => { bodyReads++; return body; },
    }) as BatchedPr;
  });
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => rows, ttlMs: 3_600_000, commitTrailerIndex: () => new Map() });
  bodyReads = 0;
  let refs = 0;
  for (let i = 0; i < 500; i++) {
    const id = `W1-T${1 + i * 28}`;
    const one = i % 2 === 0 ? gh.findMergedByTrailer(id) : null;
    const all = i % 2 === 1 ? gh.findMergedByTrailerAll!(id) : [];
    refs += (one ? 1 : 0) + (all?.length ?? 0);
  }
  assert.ok(refs > 400, `most lookups hit (${refs})`);
  assert.equal(bodyReads, 14_000 + refs, "each body is read once for the index and once for each PR handed back");
});

test("W1-T12954 criterion 5: the index gives today's PR for every task id, null on a failed fetch, and the commit fallback", () => {
  const rows = [
    merged(10, "x\n\nRemudero-Task: W1-T5\n"),
    merged(11, "Remudero-Task: W1-T5\r\nCo-Authored-By: someone"),
    merged(12, "Remudero-Task:\tW1-T6  \n"),
    merged(13, "Remudero-Task:W1-T7"),
    merged(14, "Remudero-Task:\n\nW1-T8\n"),
    merged(15, "see Remudero-Task: W1-T9\n"),
    merged(16, "Remudero-Task: W1-T55\nRemudero-Task: W1-T10\n"),
    merged(17, "Remudero-Task: W1-T11 and more\n"),
    merged(18, "a Remudero-Task: W1-T12 b"),
    merged(19, "Remudero-Task:\nRemudero-Task: W1-T13\n"),
    merged(20, "Remudero-Task: W1-T5\nRemudero-Task: W1-T5\n"),
    merged(21, "Remudero-Task:   \n"),
    merged(22, "Remudero-Task: W1-T14 x\n"),
    merged(23, "Remudero-Task: W1-T5\n", "OPEN"),
    merged(9, "Remudero-Task: W1-T15.x\n"),
  ];
  const gh = buildBatchedGithub("o", "r", { fetchAll: () => rows, ttlMs: 3_600_000, commitTrailerIndex: () => new Map() });
  const ids = ["W1-T5", "W1-T6", "W1-T7", "W1-T8", "W1-T9", "W1-T10", "W1-T55", "W1-T11", "W1-T12", "W1-T13",
    "Remudero-Task:", "W1-T14", "W1-T14 x", "W1-T15.x", "W1-T15", "W1-T1", "", "W1-T999"];
  for (const id of ids) {
    const want = oracle(rows, id);
    assert.equal(gh.findMergedByTrailer(id)?.number ?? null, want[0] ?? null, `findMergedByTrailer(${JSON.stringify(id)})`);
    assert.deepEqual(gh.findMergedByTrailerAll!(id)!.map((p) => p.number), want, `findMergedByTrailerAll(${JSON.stringify(id)})`);
  }
  assert.equal(gh.findMergedByTrailer("W1-T5")?.number, 20, "the newest merged PR wins; an open PR never does");
  assert.deepEqual(gh.findMergedByTrailerAll!("W1-T5")!.map((p) => p.number), [20, 11, 10], "newest first, each PR once");

  // W1-T119: a failed fetch is null, never a miss.
  const failed = buildBatchedGithub("o", "r", {
    fetchAll: () => { throw Object.assign(new Error("boom"), { status: 1, stderr: "gh: API rate limit exceeded" }); },
    commitTrailerIndex: () => new Map(),
  });
  assert.equal(failed.findMergedByTrailer("W1-T5"), null);
  assert.equal(failed.findMergedByTrailerAll!("W1-T5"), null);

  // W1-T2387: the commit trailer answers only when no body carries the trailer.
  const commitRef: PrRef = { number: 77, url: url(77), state: "merged" };
  const withCommits = buildBatchedGithub("o", "r", {
    fetchAll: () => rows, ttlMs: 3_600_000, commitTrailerIndex: () => new Map([["W1-T999", [commitRef]], ["W1-T5", [commitRef]]]),
  });
  assert.equal(withCommits.findMergedByTrailer("W1-T999")?.number, 77);
  assert.deepEqual(withCommits.findMergedByTrailerAll!("W1-T999")!.map((p) => p.number), [77]);
  assert.equal(withCommits.findMergedByTrailer("W1-T5")?.number, 20, "a body trailer still wins over the commit surface");
});
