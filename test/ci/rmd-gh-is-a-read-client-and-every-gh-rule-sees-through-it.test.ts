import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import { ghCommand } from "#src/lib/gh-read-broker.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// OBSERVED 2026-10-21 at origin/main 0c4dc0601: in the worker lane `./bin/rmd gh -- pr merge 1`,
// `rmd gh -- api -X PUT …/pulls/1/merge`, an auth logout and `rmd gh -- api -X POST …/statuses/…` all
// passed hooks/deny-floor.sh (exit 0), and ghCommand then ran each write with gh directly. Rules 2, 4 and
// 5 grepped the raw text for `gh pr merge` and the like; only rule 10 read through the `rmd gh --` wrapper.
// Rule 4 also missed gh's implicit POST (`gh api …/statuses/<sha> -f state=success`), `-XPOST` and a
// quoted method. Two fixes, each with its own falsifier here: `rmd gh` refuses every write and auth call,
// and the hook normalises the wrapper once for every gh rule, with rule 4 judging the method by
// gh_api_is_write, the one write rule.

const HOOK = join(REPO_ROOT, "hooks/deny-floor.sh");

function tmp(t: TestContext, tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `rmd-read-client-${tag}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The worker-lane hook on one Bash command. A private cache root and no read floor, so only the gh
 *  rules under test can answer. */
function workerHook(t: TestContext, command: string): { status: number | null; stderr: string } {
  const cache = tmp(t, "hook");
  const r = spawnSync("bash", [HOOK, "--confine-file-tools"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, XDG_CACHE_HOME: cache, RMD_GH_CACHE_HOME: cache, RMD_GH_COOLDOWN_S: "0" },
  });
  return { status: r.status, stderr: r.stderr };
}

/** The three spellings a session uses for one gh call. */
const forms = (args: string) => [`gh ${args}`, `./bin/rmd gh -- ${args}`, `rmd gh --class agent --fresh -- ${args}`];

const AUTH_LOGOUT = ["auth", "logout"].join(" "); // assembled, so this file's own text never trips rule 2

/** A live broker heartbeat, so `rmd gh` would broker a read. */
function liveHeartbeat(cacheHome: string): void {
  const dir = ghBrokerDir({ RMD_GH_CACHE_HOME: cacheHome })!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "heartbeat"), "10\n");
  const at = (Date.now() - 1_000) / 1000;
  utimesSync(join(dir, "heartbeat"), at, at);
}

/** ghCommand with injected seams: every runDirect and broker read is recorded, never executed. */
async function runGhCommand(args: readonly string[], env: NodeJS.ProcessEnv) {
  const direct: string[][] = [];
  const brokered: string[][] = [];
  let out = "";
  let err = "";
  const code = await ghCommand(["--class", "agent", "--", ...args], env,
    (a) => { direct.push(a); return 0; },
    async (_socket, a) => { brokered.push([...a]); return { stdout: "served\n", stderr: "", exitCode: 0, outcome: "upstream-200" }; },
    (stream, text) => { if (stream === "stdout") out += text; else err += text; });
  return { code, direct, brokered, out, err };
}

test("every gh rule sees through the rmd gh wrapper: a worker's merge, arm, auth and status forge are refused in every form", (t) => {
  const cases: Array<[string, RegExp]> = [
    ["pr merge 1", /only the orchestrator may merge or arm it/],
    ["pr merge 1 --auto --squash", /only the orchestrator may merge or arm it/],
    ["api -X PUT repos/o/r/pulls/1/merge", /PUT to a pull-request merge endpoint/],
    [AUTH_LOGOUT, /gh auth mutation/],
    ["api -X POST repos/o/r/statuses/abc123 -f context=remudero-review -f state=success", /commit-status endpoint/],
  ];
  const wrong: string[] = [];
  let judged = 0;
  for (const [args, reason] of cases) {
    for (const command of forms(args)) {
      judged += 1;
      const r = workerHook(t, command);
      if (r.status !== 2 || !reason.test(r.stderr)) wrong.push(`exit ${r.status} ${r.stderr.trim() || "(allowed)"} | ${command}`);
    }
  }
  assert.equal(judged, cases.length * 3, "every case is judged in all three forms");
  assert.deepEqual(wrong, []);
});

test("rule 4 judges the method by gh_api_is_write: an implicit POST, -XPOST or quoted POST to a commit-status endpoint is refused", (t) => {
  const forges = [
    "api repos/o/r/statuses/abc123 -f state=success",
    "api repos/o/r/statuses/abc123 -f context=remudero-review -F state=success",
    "api repos/o/r/statuses/abc123 --input status.json",
    "api -XPOST repos/o/r/statuses/abc123 -f state=success",
    "api -X 'POST' repos/o/r/statuses/abc123 -f state=success",
    'api --method "POST" repos/o/r/statuses/abc123 -f state=success',
    "api --method=POST repos/o/r/statuses/abc123 -f state=success",
  ];
  const wrong: string[] = [];
  for (const args of forges) {
    for (const command of forms(args)) {
      const r = workerHook(t, command);
      if (r.status !== 2 || !/commit-status endpoint/.test(r.stderr)) wrong.push(`exit ${r.status} ${r.stderr.trim() || "(allowed)"} | ${command}`);
    }
  }
  // The explicit-POST text backstop: a gh call inside a quoted string, which the tokens cannot open.
  for (const command of [`bash -c "gh api -X POST repos/o/r/statuses/abc123 -f state=success"`, `x="$(gh api --method POST repos/o/r/statuses/abc123 -f state=success)"`]) {
    const r = workerHook(t, command);
    if (r.status !== 2 || !/commit-status endpoint/.test(r.stderr)) wrong.push(`exit ${r.status} ${r.stderr.trim() || "(allowed)"} | ${command}`);
  }
  assert.deepEqual(wrong, []);
});

test("rule 4 still lets a commit-status read and an unrelated api write through", (t) => {
  for (const command of [
    "gh api repos/o/r/commits/abc123/statuses",
    "gh api repos/o/r/commits/abc123/statuses --jq '.[].state'",
    "gh api -X GET repos/o/r/commits/abc123/statuses -f per_page=100",
    "gh api repos/o/r/issues/1/comments -f body=hi",
    "gh api repos/o/r/commits/abc123/statuses; gh api repos/o/r/issues/1/comments -f body=hi",
  ]) {
    const r = workerHook(t, command);
    assert.equal(r.status, 0, `expected allowed: ${command}\n${r.stderr}`);
  }
});

test("rmd gh refuses a write and any auth call with exit 2, and never runs gh directly or through the broker", async (t) => {
  const live = tmp(t, "live");
  liveHeartbeat(live);
  const none = tmp(t, "none");
  const calls = [
    ["pr", "merge", "1"],
    ["pr", "edit", "7", "--body", "x"],
    ["api", "-X", "PUT", "repos/o/r/pulls/1/merge"],
    ["api", "repos/o/r/statuses/abc123", "-f", "state=success"],
    ["api", "graphql", "-f", "query=mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }"],
    ["auth", "logout"],
    ["auth", "token"],
    ["auth", "status"],
  ];
  const wrong: string[] = [];
  for (const cache of [live, none]) {
    for (const args of calls) {
      const r = await runGhCommand(args, { RMD_GH_CACHE_HOME: cache });
      const refused = r.code === 2 && r.direct.length === 0 && r.brokered.length === 0 &&
        /serves GitHub reads only/.test(r.err) && /plain `gh` call/.test(r.err) && /deny floor/.test(r.err);
      if (!refused) wrong.push(`${cache === live ? "live" : "no broker"} code=${r.code} direct=${r.direct.length} brokered=${r.brokered.length} | ${args.join(" ")} | ${r.err.trim()}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("rmd gh still serves reads: pr view and api pulls reach the broker when it is live, and gh directly when it is not", async (t) => {
  const live = tmp(t, "serve-live");
  liveHeartbeat(live);
  const none = tmp(t, "serve-none");
  for (const args of [["pr", "view", "1"], ["api", "repos/o/r/pulls/1"]]) {
    const brokered = await runGhCommand(args, { RMD_GH_CACHE_HOME: live });
    assert.deepEqual([brokered.code, brokered.brokered, brokered.direct, brokered.out], [0, [args], [], "served\n"], args.join(" "));
    const direct = await runGhCommand(args, { RMD_GH_CACHE_HOME: none });
    assert.deepEqual([direct.code, direct.brokered, direct.direct], [0, [], [args]], args.join(" "));
    for (const command of [`./bin/rmd gh -- ${args.join(" ")}`, `rmd gh --class agent -- ${args.join(" ")}`]) {
      assert.equal(workerHook(t, command).status, 0, `the hook lets the read run: ${command}`);
    }
  }
});
