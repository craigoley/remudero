/**
 * W1-T2948 — A DETERMINISTIC PR-BODY REPAIR FELL THROUGH TO A MODEL WORKER BECAUSE ITS TRANSPORT
 * QUERIED DEPRECATED PROJECTS CLASSIC METADATA.
 *
 * `gh pr edit --body` is implemented over GraphQL, and its query selects
 * `repository.pullRequest.projectCards`. GitHub has deprecated Projects Classic, so the command
 * fails BEFORE the supplied edit reaches the pull request. #4228's fix rung had the complete
 * repaired body in hand, called the writer, ledgered `fix.body_gate_repair_error`, and fell through
 * to an ordinary model worker — which pushed a commit performing the same mechanical edit. A
 * zero-model edit became a worker dispatch, a commit and an extra CI cycle. The same failure was
 * reproduced from a container shell on 2026-09-07 against PR #4372.
 *
 * THE FIX IS TRANSPORT ONLY. `PATCH repos/{owner}/{repo}/pulls/{number}` is REST. No diagnosis,
 * authored body, strike accounting, review identity, provider selection, commit, merge or
 * lifecycle rule changes — which is itself asserted below, because "transport only" is a claim
 * about what did NOT change.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureTaskTrailer, prBodyRestArgs, repairRetroAcceptanceBlock, updatePrBodyViaGh, writePrBodyRest } from "../src/run-task.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const PR_URL = "https://github.com/o/r/pull/1216";

/** A recorder `gh` first on PATH — drives the REAL leaf rather than a faked seam, which is the
 *  #977/#978 shape this repo keeps meeting (a fully-injected dep leaves its default unreachable). */
function withRecorderGh<T>(script: string, run: (recordPath: string) => T): T {
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}t2948-gh-`));
  const recordPath = join(binDir, "argv.json");
  writeFileSync(join(binDir, "gh"), script.replace("__RECORD__", JSON.stringify(recordPath)));
  chmodSync(join(binDir, "gh"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  try {
    return run(recordPath);
  } finally {
    process.env.PATH = originalPath;
  }
}

const RECORDING_GH = ["#!/usr/bin/env node", 'require("fs").writeFileSync(__RECORD__, JSON.stringify(process.argv.slice(2)));', "process.exit(0);"].join("\n");
const FAILING_GH = ["#!/usr/bin/env node", 'require("fs").writeFileSync(__RECORD__, JSON.stringify(process.argv.slice(2)));', 'process.stderr.write("could not update pull request");', "process.exit(1);"].join("\n");

// ── criterion 3: the argv itself is the whole contract ──────────────────────────────────────

test("W1-T2948: the REST argv carries PATCH, the exact owner/repo/number, and the complete body as ONE argument", () => {
  const body = "line one\n\n## Acceptance\n- [x] a claim with spaces, `backticks` and \"quotes\"\n";
  assert.deepEqual(prBodyRestArgs("https://github.com/craigoley/remudero/pull/4372", body), [
    "api",
    "-X",
    "PATCH",
    "repos/craigoley/remudero/pulls/4372",
    "-f",
    `body=${body}`,
  ]);
});

test("W1-T2948: the endpoint is the SINGLE pull request — never an issue, project, GraphQL, merge or branch endpoint", () => {
  const argv = prBodyRestArgs(PR_URL, "b");
  assert.equal(argv[3], "repos/o/r/pulls/1216");
  for (const forbidden of ["issues", "projects", "graphql", "merge", "branches", "pr"]) {
    assert.ok(!argv.some((a) => a === forbidden || a.split("/").includes(forbidden)), `argv must not reach ${forbidden}: ${JSON.stringify(argv)}`);
  }
});

test("W1-T2948: `-f` (raw-field), never `-F` — a body beginning with @ is a STRING, not a filename, and {owner} is not substituted", () => {
  // Verified against the real `gh --verbose`: -f puts this in the payload verbatim, -F would read
  // /etc/hostname off disk and substitute the placeholder from the current checkout.
  const hostile = "@/etc/hostname and {owner} literal";
  const argv = prBodyRestArgs(PR_URL, hostile);
  assert.ok(argv.includes("-f"), "raw-field");
  assert.ok(!argv.includes("-F"), "never the typed field, whose @ and {owner} handling would corrupt a real body");
  assert.equal(argv[argv.length - 1], `body=${hostile}`);
});

// ── criterion 4: refuse before spawning, never guess a target ────────────────────────────────

test("W1-T2948: a malformed or non-pull-request URL fails BEFORE gh is invoked, so no repository or PR target is guessed", () => {
  const calls: string[][] = [];
  const exec = (args: string[]): unknown => {
    calls.push(args);
    return undefined;
  };
  for (const bad of ["", "not a url", "https://github.com/o/r/issues/7", "https://github.com/o/r/pull/", "https://github.com/o/r/pull/abc", "o/r#1216"]) {
    assert.throws(() => writePrBodyRest(bad, "body", exec), /refusing to guess/, `must refuse: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(calls, [], "not one process was spawned — guessing the target is how a repair lands on the wrong pull request");
});

// ── criterion 1: the acceptance-gate repair leaf, driven for real ────────────────────────────

test("W1-T2948: the acceptance-gate body repair updates one pull request through the REST pulls endpoint and never invokes `gh pr edit`", async () => {
  const argv = withRecorderGh(RECORDING_GH, (recordPath) => {
    return updatePrBodyViaGh(PR_URL, "the corrected body").then(() => JSON.parse(readFileSync(recordPath, "utf8")) as string[]);
  });
  assert.deepEqual(await argv, ["api", "-X", "PATCH", "repos/o/r/pulls/1216", "-f", "body=the corrected body"]);
});

// ── criterion 2: the other two writers reuse it rather than keeping their own copy ───────────

test("W1-T2948: the trailer stamp reuses the same REST writer rather than retaining an independent `gh pr edit` call site", () => {
  const written: string[][] = [];
  ensureTaskTrailer(
    PR_URL,
    "W1-T2948",
    () => {},
    () => ({ body: "an existing body" }),
    (args) => {
      written.push(args);
      return undefined;
    },
  );
  assert.equal(written.length, 1);
  assert.equal(written[0][0], "api");
  assert.deepEqual(written[0].slice(0, 4), ["api", "-X", "PATCH", "repos/o/r/pulls/1216"]);
  assert.match(written[0][5], /^body=an existing body\n\nRemudero-Task: W1-T2948\n$/, "the authored body is unchanged — only its transport moved");
});

test("W1-T2948: the retro body repair reuses the same REST writer, driven through its REAL default editBody", () => {
  const stale = "a retro body with no judgeable acceptance block";
  const argv = withRecorderGh(RECORDING_GH, (recordPath) => {
    const outcome = repairRetroAcceptanceBlock(PR_URL, () => {}, { fetchBody: () => stale });
    assert.equal(outcome, "repaired", "the repair itself is unchanged — this task moved its transport, not its diagnosis");
    return JSON.parse(readFileSync(recordPath, "utf8")) as string[];
  });
  assert.deepEqual(argv.slice(0, 5), ["api", "-X", "PATCH", "repos/o/r/pulls/1216", "-f"]);
  assert.match(argv[5], /^body=/);
});

// ── criterion 5: each caller's existing failure contract survives the transport swap ─────────

test("W1-T2948: a write failure still PROPAGATES out of the acceptance repair — a swallowed failure would leave a stale claim the rung believes it fixed", async () => {
  await withRecorderGh(FAILING_GH, async () => {
    await assert.rejects(() => updatePrBodyViaGh(PR_URL, "body"));
  });
});

test("W1-T2948: a write failure still leaves the trailer stamp FAIL-SOFT, ledgering trailer_stamp.failed with phase `write`", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  ensureTaskTrailer(
    PR_URL,
    "W1-T2948",
    (step, extra) => logs.push({ step, extra }),
    () => ({ body: "an existing body" }),
    () => {
      throw new Error("PATCH refused");
    },
  );
  const row = logs.find((l) => l.step === "trailer_stamp.failed");
  assert.ok(row, "the existing diagnostic row is still written");
  assert.equal(row?.extra?.phase, "write", "and still names WHICH of the two calls threw");
  assert.equal(row?.extra?.task_id, "W1-T2948", "the id it was HANDED, never inferred from the URL");
});

test("W1-T2948: an UNRESOLVABLE url leaves the trailer stamp fail-soft too — it refuses the target and ledgers, rather than throwing at its caller", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const written: string[][] = [];
  assert.doesNotThrow(() =>
    ensureTaskTrailer(
      "https://github.com/o/r/issues/7",
      "W1-T2948",
      (step, extra) => logs.push({ step, extra }),
      () => ({ body: "an existing body" }),
      (args) => {
        written.push(args);
        return undefined;
      },
    ),
  );
  assert.deepEqual(written, [], "the refusal happens before the sink is reached");
  assert.match(String(logs.find((l) => l.step === "trailer_stamp.failed")?.extra?.error ?? ""), /refusing to guess/);
});

test("W1-T2948: a write failure still leaves the retro repair best-effort, returning `error` and ledgering acceptance.repair.error", () => {
  const logs: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  const outcome = withRecorderGh(FAILING_GH, () =>
    repairRetroAcceptanceBlock(PR_URL, (step, extra) => logs.push({ step, extra }), { fetchBody: () => "a retro body with no judgeable acceptance block" }),
  );
  assert.equal(outcome, "error", "retroCommand must never fail because a repair attempt failed");
  assert.ok(logs.some((l) => l.step === "acceptance.repair.error"), "and the existing reason row is unchanged");
});

// ── criterion 6: what this change did NOT add ────────────────────────────────────────────────

test("W1-T2948: the change adds no worker dispatch, commit, merge, provider-selection, timer, polling or lifecycle action", () => {
  const calls: string[][] = [];
  writePrBodyRest(PR_URL, "b", (args) => {
    calls.push(args);
    return undefined;
  });
  assert.equal(calls.length, 1, "exactly ONE effect per write — no retry timer, no poll loop, no second read");
  // Every argv token, checked against the vocabulary of the actions this task must not perform.
  for (const forbidden of ["merge", "push", "commit", "run", "workflow", "review", "close", "ready", "comment"]) {
    assert.ok(!calls[0].includes(forbidden), `no ${forbidden} action: ${JSON.stringify(calls[0])}`);
  }
  assert.equal(calls[0][0], "api", "the only verb is a REST call");
});
