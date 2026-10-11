// test/a-closing-keyword-never-closes-another-open-pr.test.ts
//
// LIVE 2026-10-11: remudero-console #2035's body said "(root cause and fix: craigoley/remudero#10856)".
// The fleet merged #2035 at 12:45:52Z, and GitHub closed core #10856, an open PR, at 12:45:54Z (its
// ClosedEvent's closer is #2035). No fleet code closed it, so no ledger row said why.
//
// (1) the parser finds GitHub's closing-keyword references, and none inside code or after a non-keyword;
// (2) the rewrite keeps the link, and the rewritten text parses as no reference at all;
// (3) the guard rewrites only references to another OPEN pull request, and writes a ledger row per rewrite
//     naming the merging PR, the referenced PR and the reason;
// (4) attemptArm runs the guard before any arm or merge, and withholds both when the body cannot be
//     read or rewritten;
// (5) the production arm deps carry the guard, and it reaches gh and the ledger.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CLOSING_REFERENCE_DEFUSED_STEP,
  CLOSING_REFERENCE_READ_BOUND,
  closingReferenceGuardSteps,
  closingReferencesInBody,
  defuseClosingReferences,
  recordClosingReferenceToLedger,
  type ClosingReferenceGuardResult,
} from "../src/lib/closing-reference-guard.js";
import { attemptArm, realArmDeps, realArmDepsAsync } from "../src/lib/arm-auto-merge.js";
import { runStepsSync } from "../src/lib/git-push.js";
import { withLiveWritesAllowed } from "../src/lib/live-write-guard.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import type { Config } from "../src/lib/config.js";
import { ghShim } from "./helpers/gh-shim.js";

const CONSOLE = { owner: "craigoley", repo: "remudero-console" };
const MERGING = "https://github.com/craigoley/remudero-console/pull/2035";
const BODY_2035 =
  "This PR had been red and untouched since 2026-10-10 02:16Z. The console daemon's fix-progress latch held it " +
  "after #2038 amended CONSOLE-T99's plan (root cause and fix: craigoley/remudero#10856). Commits on this branch:";

// ── (1) the parser ───────────────────────────────────────────────────────────────────────────

test("the parser finds the cross-repo closing reference in #2035's body", () => {
  const refs = closingReferencesInBody(BODY_2035, CONSOLE);
  assert.deepEqual(
    refs.map((r) => ({ text: r.text, owner: r.owner, repo: r.repo, number: r.number })),
    [{ text: "fix: craigoley/remudero#10856", owner: "craigoley", repo: "remudero", number: 10856 }],
  );
});

test("the parser reads every keyword and reference shape, and skips code and non-keywords", () => {
  const body = [
    "Fixes #12",
    "closes: https://github.com/craigoley/remudero/pull/5",
    "Resolved GH-7",
    "close craigoley/remudero#8",
    "hotfix: #3 and fixed in #4 and prefixes #6",
    "`fixes #9` is code",
    "```",
    "fixes #10",
    "```",
  ].join("\n");
  const refs = closingReferencesInBody(body, CONSOLE);
  assert.deepEqual(
    refs.map((r) => `${r.keyword}|${r.owner}/${r.repo}#${r.number}`),
    [
      "Fixes|craigoley/remudero-console#12",
      "closes|craigoley/remudero#5",
      "Resolved|craigoley/remudero-console#7",
      "close|craigoley/remudero#8",
    ],
  );
});

// ── (2) the rewrite ──────────────────────────────────────────────────────────────────────────

test("the rewrite keeps the reference and no longer parses as a closing reference", () => {
  const body = `${BODY_2035}\nFixes #12, closes: #13`;
  const rewritten = defuseClosingReferences(body, closingReferencesInBody(body, CONSOLE));
  assert.match(rewritten, /\(root cause and fix: PR craigoley\/remudero#10856\)/);
  assert.match(rewritten, /Fixes PR #12, closes: PR #13$/);
  assert.deepEqual(closingReferencesInBody(rewritten, CONSOLE), [], "the rewritten body names nothing to close");
  assert.equal(defuseClosingReferences(rewritten, closingReferencesInBody(rewritten, CONSOLE)), rewritten, "idempotent");
});

// ── (3) the guard ────────────────────────────────────────────────────────────────────────────

function fakeGitHub(body: string | null, items: Record<string, { pull_request?: object; state: string } | Error>) {
  const reads: string[][] = [];
  const writes: string[][] = [];
  return {
    reads,
    writes,
    read: (args: string[]) => {
      reads.push(args);
      if (args[1] === "repos/craigoley/remudero-console/pulls/2035") return { body };
      const item = items[args[1]!];
      if (item instanceof Error) throw item;
      if (!item) throw new Error(`unexpected read ${args.join(" ")}`);
      return item;
    },
    write: (args: string[]) => void writes.push(args),
  };
}

test("the guard rewrites a reference to another open PR, leaves issues and closed PRs, and ledgers the rewrite", () => {
  const body = `${BODY_2035}\nFixes #40 (an issue). Closes craigoley/remudero#9000 (a merged PR). fixes #2035 (itself).`;
  const gh = fakeGitHub(body, {
    "repos/craigoley/remudero/issues/10856": { pull_request: {}, state: "open" },
    "repos/craigoley/remudero-console/issues/40": { state: "open" },
    "repos/craigoley/remudero/issues/9000": { pull_request: {}, state: "closed" },
  });
  const rows: Array<Record<string, unknown>> = [];
  const result = runStepsSync(closingReferenceGuardSteps(MERGING, gh.read, gh.write, (row) => void rows.push(row)));

  assert.equal(result.state, "defused");
  assert.equal(gh.writes.length, 1, "one body rewrite");
  const [, method, verb, path, field, value] = gh.writes[0]!;
  assert.deepEqual([method, verb, path, field], ["--method", "PATCH", "repos/craigoley/remudero-console/pulls/2035", "-f"]);
  assert.match(value!, /^body=/);
  assert.match(value!, /fix: PR craigoley\/remudero#10856/);
  assert.match(value!, /Fixes #40 \(an issue\)/, "an issue reference still closes its issue");
  assert.match(value!, /Closes craigoley\/remudero#9000/, "a closed PR is left as written");
  assert.match(value!, /fixes #2035 \(itself\)/, "a self-reference is never read or rewritten");
  assert.equal(gh.reads.some((r) => r[1] === "repos/craigoley/remudero-console/issues/2035"), false);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.step, CLOSING_REFERENCE_DEFUSED_STEP);
  assert.equal(rows[0]!.pr_url, MERGING);
  assert.equal(rows[0]!.referenced_pr_url, "https://github.com/craigoley/remudero/pull/10856");
  assert.equal(rows[0]!.resolution, "open-pr");
  assert.equal(rows[0]!.outcome, "defused");
  assert.match(String(rows[0]!.reason), /GitHub closes that pull request when this PR merges/);
});

test("the guard rewrites a reference it cannot read, and one past the read bound, without guessing", () => {
  const refs = Array.from({ length: CLOSING_REFERENCE_READ_BOUND + 1 }, (_, i) => `fixes #${100 + i}`).join("\n");
  const items: Record<string, { state: string } | Error> = {};
  for (let i = 0; i < CLOSING_REFERENCE_READ_BOUND; i++) items[`repos/craigoley/remudero-console/issues/${100 + i}`] = { state: "open" };
  items["repos/craigoley/remudero-console/issues/100"] = new Error("HTTP 404");
  const gh = fakeGitHub(refs, items);
  const rows: Array<Record<string, unknown>> = [];
  const result = runStepsSync(closingReferenceGuardSteps(MERGING, gh.read, gh.write, (row) => void rows.push(row)));
  assert.equal(result.state, "defused");
  assert.deepEqual(rows.map((r) => r.resolution), ["unreadable", "over-read-bound"]);
  assert.equal(gh.reads.length, 1 + CLOSING_REFERENCE_READ_BOUND, "the body plus the bounded reference reads");
});

test("a body with no closing reference to an open PR is never rewritten", () => {
  for (const body of [null, "", "Nothing to close here.", "Fixes #40"]) {
    const gh = fakeGitHub(body, { "repos/craigoley/remudero-console/issues/40": { state: "open" } });
    const rows: Array<Record<string, unknown>> = [];
    assert.deepEqual(runStepsSync(closingReferenceGuardSteps(MERGING, gh.read, gh.write, (row) => void rows.push(row))), { state: "clean", defused: [] });
    assert.deepEqual(gh.writes, []);
    assert.deepEqual(rows, []);
  }
});

test("a failed body read or rewrite fails the guard, and a failed rewrite is ledgered as an error", () => {
  const unreadable = runStepsSync(closingReferenceGuardSteps(MERGING, () => { throw new Error("HTTP 502"); }, () => {}, () => {}));
  assert.equal(unreadable.state, "failed");
  assert.match(unreadable.detail ?? "", /could not read this PR's body: HTTP 502/);

  const gh = fakeGitHub(BODY_2035, { "repos/craigoley/remudero/issues/10856": { pull_request: {}, state: "open" } });
  const rows: Array<Record<string, unknown>> = [];
  const failed = runStepsSync(closingReferenceGuardSteps(MERGING, gh.read, () => { throw { stderr: "HTTP 403: Resource not accessible" }; }, (row) => void rows.push(row)));
  assert.equal(failed.state, "failed");
  assert.match(failed.detail ?? "", /could not rewrite this PR's body: HTTP 403/);
  assert.deepEqual(rows.map((r) => [r.outcome, r.referenced_pr_url]), [["error", "https://github.com/craigoley/remudero/pull/10856"]]);
});

// ── (4) attemptArm runs it first ─────────────────────────────────────────────────────────────

function armWith(guard: () => ClosingReferenceGuardResult) {
  const calls: string[] = [];
  const said: string[] = [];
  const result = attemptArm(MERGING, {
    closingReferences: () => {
      calls.push("guard");
      return guard();
    },
    armAuto: () => {
      calls.push("armAuto");
      throw { stderr: "Pull request is in clean status" };
    },
    mergeDirect: () => void calls.push("mergeDirect"),
    isMerged: () => false,
    say: (m) => void said.push(m),
  });
  return { result, calls, said };
}

test("attemptArm rewrites the body before it arms or merges", () => {
  const { result, calls, said } = armWith(() => ({
    state: "defused",
    defused: [{ reference: "fix: craigoley/remudero#10856", url: "https://github.com/craigoley/remudero/pull/10856", resolution: "open-pr" }],
  }));
  assert.equal(result.outcome, "direct-merged");
  assert.deepEqual(calls, ["guard", "armAuto", "mergeDirect"]);
  assert.ok(said.some((m) => m.startsWith("automerge.closing_reference_defused") && m.includes("craigoley/remudero#10856")));
});

test("attemptArm withholds the arm and the merge when the guard fails or throws", () => {
  for (const guard of [
    (): ClosingReferenceGuardResult => ({ state: "failed", defused: [], detail: "could not rewrite this PR's body: HTTP 403" }),
    (): ClosingReferenceGuardResult => { throw new Error("transport down"); },
  ]) {
    const { result, calls, said } = armWith(guard);
    assert.equal(result.outcome, "arm-error-ignored");
    assert.deepEqual(calls, ["guard"], "neither armAuto nor mergeDirect ran");
    assert.ok(said.some((m) => m.startsWith("automerge.closing_reference_refused")));
  }
});

// ── (5) production wiring ────────────────────────────────────────────────────────────────────

test("the production arm deps, sync and async, carry the closing-reference guard", () => {
  assert.equal(typeof realArmDeps().closingReferences, "function");
  assert.equal(typeof realArmDepsAsync().closingReferences, "function");
});

test("the production guard reaches gh for the reads and the body rewrite, and ledgers the rewrite (PATH-stubbed gh)", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}closing-reference-root-`));
  const shim = ghShim([
    { when: "--method PATCH", stdout: "{}" },
    { when: "pulls/7", stdout: '{"body":"Fixes #8 before merging"}' },
    { when: "issues/8", stdout: '{"pull_request":{},"state":"open"}' },
  ], { kind: "closing-reference-gh" });
  const config = { root: dir } as Config;
  const savedPath = process.env.PATH;
  process.env.PATH = `${shim.dir}:${savedPath}`;
  try {
    const url = "https://github.com/acme/widgets/pull/7";
    const sync = withLiveWritesAllowed(() => realArmDeps(() => config).closingReferences!(url)) as ClosingReferenceGuardResult;
    const viaAsync = await withLiveWritesAllowed(() => realArmDepsAsync(() => config).closingReferences!(url));
    for (const result of [sync, viaAsync]) {
      assert.equal(result.state, "defused");
      assert.deepEqual(result.defused.map((d) => d.url), ["https://github.com/acme/widgets/pull/8"]);
    }
    const patches = shim.calls().filter((l) => l.includes("--method PATCH"));
    assert.equal(patches.length, 2, "one body rewrite per driver");
    assert.ok(patches.every((l) => l.includes("repos/acme/widgets/pulls/7 -f body=Fixes PR #8 before merging")));
    const rows = readFileSync(join(dir, "state", "ledger.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(rows.map((r) => [r.step, r.pr_url, r.referenced_pr_url, r.outcome]), [
      [CLOSING_REFERENCE_DEFUSED_STEP, url, "https://github.com/acme/widgets/pull/8", "defused"],
      [CLOSING_REFERENCE_DEFUSED_STEP, url, "https://github.com/acme/widgets/pull/8", "defused"],
    ]);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
    rmSync(shim.dir, { recursive: true, force: true });
  }
});

test("a ledger row that cannot be written is reported and never stops the guard", () => {
  const warned: string[] = [];
  const saved = console.warn;
  console.warn = (m: string) => void warned.push(m);
  try {
    recordClosingReferenceToLedger(() => { throw new Error("no config"); })({ pr_url: MERGING });
  } finally {
    console.warn = saved;
  }
  assert.deepEqual(warned, [`closing-reference-guard: the ${CLOSING_REFERENCE_DEFUSED_STEP} row could not be written: no config`]);
});

test("the guard fails on a URL it cannot resolve or a body that is not text, and the parser skips #0", () => {
  const noop = () => {};
  assert.equal(runStepsSync(closingReferenceGuardSteps("not-a-pr-url", () => ({}), noop, noop)).state, "failed");
  const nonText = runStepsSync(closingReferenceGuardSteps(MERGING, () => ({ body: 42 }), noop, noop));
  assert.deepEqual([nonText.state, nonText.detail], ["failed", "the PR's body was not readable text"]);
  assert.deepEqual(closingReferencesInBody("fixes #0", CONSOLE), []);
});
