import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
// @ts-ignore The executable author preflight currently has no declaration file.
import { failingTestsFromTap } from "#scripts/preflight-author.mjs";
import {
  handShipArgs, handShipProduction, rerunHandShipTest, runHandShip, shipRunJournal, stopHandShip, waitForHandShipStop, withHandShipRun,
  type HandShipPorts, type HandShipReceipt,
} from "#src/lib/hand-ship.js";
import { withLiveWritesAllowed } from "#src/lib/live-write-guard.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const sha = "a".repeat(40);
const main = "b".repeat(40);
const previous = "c".repeat(40);
const branch = "run-unfiled-1795426791312";
const failure = { file: "test/ci/example.test.ts", title: "outer > fails [exactly]" };
const other = { ...failure, title: "second test" };
const body = "Acceptance:\n- The example passes | unit test: example";
const pr = { number: 7, url: "https://github.com/example/repo/pull/7", title: "fix(ci): test it", body, sha };
const mac = { name: "preferred", kind: "mac", target: "local" } as const;
const linux = { name: "fallback", kind: "linux", target: "ssh-host", donor: "/opt/donor" } as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function receipt(...failures: (typeof failure)[]): HandShipReceipt {
  const steps: HandShipReceipt["steps"] = [
    { name: "census-precheck", ok: true }, { name: "static-preflight", ok: true },
    { name: "affected-tests", ok: failures.length === 0, testSummary: { pass: 5, fail: failures.length, cancelled: 0 },
      judge: { given: 1, reported: 1 }, diagnostics: { mayBeIncomplete: false } },
  ];
  return { headSha: sha, baseSha: main, verdict: failures.length ? "failed" : "passed", steps };
}

function fixture() {
  const events: string[] = [];
  const deps: HandShipPorts = {
    signal: new AbortController().signal,
    hosts: () => [linux, mac],
    readHost: async (host) => host.kind === "mac" ? { reading: "pressure normal", normal: true } : { reading: "1024 kB available" },
    source: async () => ({ branch, sha, repo: "example/repo" }),
    preflight: async (_source, host, priority) => {
      events.push(`preflight ${host.name} ${priority}`);
      return { receipt: receipt(), failures: [] };
    },
    rerun: async (_host, ref, failed) => {
      events.push(`test ${ref} ${failed.file} :: ${failed.title}`);
      return "red";
    },
    findPr: async () => undefined,
    readTip: async () => { events.push("read tip"); return previous; },
    push: async (source, tip) => { events.push(`push ${source.sha} over ${tip}`); },
    writePr: async (_source, number) => { events.push(number === undefined ? "open" : `amend ${number}`); return 7; },
    readPr: async () => pr,
    log: (line) => events.push(line),
  };
  return { deps, events, run: () => runHandShip({ title: pr.title, body }, deps) };
}

test("W1-T12169 criterion 1 chooses the readable host and reports the reading", async () => {
  const { deps, events, run } = fixture();
  deps.readHost = async (host) => host.kind === "mac" ? undefined : { reading: "1024 kB available" };
  assert.equal(await run(), pr.url);
  assert.ok(events.includes("preferred: unreadable"));
  assert.ok(events.includes("selected fallback: 1024 kB available"));
  assert.ok(events.includes("preflight fallback normal"));
  deps.readHost = async () => undefined;
  await assert.rejects(run, /no readable/);
  assert.equal(events.filter((event) => event.startsWith("preflight ")).length, 1);
});

test("W1-T12169 criterion 2 prefers the normal Mac and requests low priority", async () => {
  const { events, run } = fixture();
  await run();
  assert.ok(events.includes("selected preferred: pressure normal"));
  assert.ok(events.includes("preflight preferred low"));
});

test("W1-T12169 criterion 2 the local launcher stages a bundle and preserves PATH under nice", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-bundle-"));
  const work = join(dir, "work");
  const journal = shipRunJournal(dir);
  const { deps, cleanup } = handShipProduction(work, dir, journal);
  t.after(async () => {
    try { await cleanup(); }
    finally {
      journal.finish("refused");
      rmSync(dir, { recursive: true, force: true });
    }
  });
  git(dir, "init", "-b", branch, work);
  git(work, "remote", "add", "origin", "https://github.com/example/repo.git");
  mkdirSync(join(work, "scripts"));
  mkdirSync(join(work, "test", "ci"), { recursive: true });
  mkdirSync(join(work, "test", "setup"));
  writeFileSync(join(work, "package-lock.json"), "{}\n");
  writeFileSync(join(work, ".gitignore"), "node_modules\n");
  writeFileSync(join(work, "test", "setup", "tmp-hygiene.ts"), "");
  const file = "test/ci/isolated.test.mjs";
  const disagree = join(dir, "disagree");
  writeFileSync(join(work, file), 'import { test } from "node:test"; test("isolated", () => {});\n');
  writeFileSync(join(work, "scripts", "preflight-author.mjs"), `
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getPriority } from "node:os";
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const base = execFileSync("git", ["rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
if (getPriority() < 10 || !process.env.PATH.startsWith(${JSON.stringify(dir + ":")})) process.exit(2);
if (process.argv.slice(2).join(" ") !== "--head-ref ${branch} --head-sha " + commit) process.exit(3);
mkdirSync("coverage");
writeFileSync("coverage/preflight-author.json", JSON.stringify({ ...${JSON.stringify(receipt())}, headSha: commit, baseSha: base }));
if (existsSync(${JSON.stringify(disagree)})) process.exitCode = 1;
`);
  git(work, "add", ".");
  git(work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "add fixture");
  const base = git(work, "rev-parse", "HEAD");
  git(work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "head fixture");
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"), "dir");
  const commit = git(work, "rev-parse", "HEAD");
  const source = await deps.source();
  assert.deepEqual(source, { branch, sha: commit, repo: "example/repo" });
  const host = { ...mac, path: dir };
  writeFileSync(join(dir, "hand-ship-hosts.json"), JSON.stringify([host, linux]));
  assert.deepEqual(deps.hosts(), [host, linux]);
  writeFileSync(join(dir, "hand-ship-hosts.json"), JSON.stringify([{ ...linux, donor: null }]));
  assert.throws(() => deps.hosts(), /invalid hand-ship host/);
  const result = await deps.preflight(source, host, "low");
  assert.equal(result.receipt.headSha, commit);
  assert.equal(result.receipt.baseSha, base);
  assert.equal(result.receipt.verdict, "passed");
  assert.deepEqual(result.failures, []);
  const selected = { file, title: "isolated" };
  assert.equal(await deps.rerun(host, commit, selected), "green");
  assert.equal(await deps.rerun(host, base, selected), "green");
  await assert.rejects(() => deps.rerun(host, base, { ...selected, file: "../../unrelated" }), /invalid checkout path/);
  await cleanup();
  writeFileSync(disagree, "");
  await assert.rejects(() => deps.preflight(source, host, "low"), /disagrees with receipt verdict/);
  await cleanup();
  rmSync(disagree);
  await deps.preflight(source, host, "low");
  writeFileSync(join(work, "package-lock.json"), '{"different":true}\n');
  assert.equal(await deps.rerun(host, base, selected), "unmeasured");
});

test("W1-T12169 criterion 3 classifies by file and full title in head-then-main order", async () => {
  const { deps, events, run } = fixture();
  const hostOnly = { ...failure, file: "test/ci/other.test.ts" };
  deps.preflight = async () => ({ receipt: receipt(failure, other, hostOnly), failures: [failure, other, hostOnly] });
  const record = deps.rerun;
  deps.rerun = async (host, ref, failed) => {
    assert.equal(host, mac);
    await record(host, ref, failed);
    if (failed === hostOnly) return "green";
    return ref === main && failed === other ? "green" : "red";
  };
  await assert.rejects(run, /not eligible/);
  assert.deepEqual(events.filter((event) => event.startsWith("test ")), [sha, main].flatMap((ref) =>
    [failure, other, hostOnly].map(({ file, title }) => `test ${ref} ${file} :: ${title}`)));
  assert.ok(events.includes(`${failure.file} :: ${failure.title} — also failing on main`));
  assert.ok(events.includes(`${other.file} :: ${other.title} — caused by the change`));
  assert.ok(events.includes(`${hostOnly.file} :: ${hostOnly.title} — caused by the host`));
  assert.ok(!events.includes("read tip"));
});

test("W1-T12169 criterion 4 publishes all named main reds with an exact SHA and propagates a stale lease", async () => {
  const { deps, events, run } = fixture();
  deps.preflight = async () => ({ receipt: receipt(failure, other), failures: [failure, other] });
  deps.findPr = async () => pr;
  await run();
  assert.ok(events.some((line) => line.includes(failure.title) && line.includes("also failing on main")));
  assert.ok(events.some((line) => line.includes(other.title) && line.includes("also failing on main")));
  assert.deepEqual(events.filter((line) => /^(read tip|push |amend )/.test(line)),
    ["read tip", `push ${sha} over ${previous}`, "amend 7"]);
  deps.push = async () => { throw new Error("stale lease"); };
  await assert.rejects(run, /stale lease/);
  assert.equal(events.filter((event) => event === "amend 7").length, 1);
});

test("a named static failure stops without rerunning or publishing", async () => {
  const { deps, events, run } = fixture();
  const failed = receipt(failure);
  failed.steps[1] = { name: "static-preflight", ok: false };
  deps.preflight = async () => ({ receipt: failed, failures: [failure] });
  await assert.rejects(run, /static-preflight failed/);
  assert.ok(!events.some((event) => event.startsWith("test ") || event === "read tip"));
});

test("amendment metadata needs Acceptance and the stored PR must match the tested SHA", async () => {
  const { deps, events, run } = fixture();
  deps.findPr = async () => ({ ...pr, body: "An amendment missing its evidence." });
  await assert.rejects(() => runHandShip({}, deps), /parseable Acceptance block/);
  assert.equal(events.length, 0);
  deps.preflight = async () => ({ receipt: { ...receipt(), headSha: main }, failures: [] });
  await assert.rejects(run, /does not bind the requested head/);
  assert.ok(!events.includes("read tip"));
  deps.preflight = async () => ({ receipt: receipt(), failures: [] });
  deps.readPr = async () => ({ ...pr, sha: main });
  await assert.rejects(run, /stored PR .* differs/);
  assert.ok(events.includes("amend 7"));
});

test("the publication adapter uses REST for lookup, open, amendment and stored-body verification", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-pr-"));
  const journal = shipRunJournal(dir);
  t.after(() => {
    journal.finish("refused");
    rmSync(dir, { recursive: true, force: true });
  });
  const row = { number: 7, state: "open", html_url: pr.url, title: pr.title, body, head: { sha } };
  const calls: string[][] = [];
  const { deps } = handShipProduction(dir, dir, journal, () => {}, async (args) => {
    calls.push(args);
    return JSON.stringify(args[1]?.includes("?state=all") ? [row] : row);
  });
  const source = { branch, sha, repo: "example/repo" };
  assert.deepEqual(await deps.findPr(source), pr);
  await withLiveWritesAllowed(async () => {
    assert.equal(await deps.writePr(source, undefined, pr.title, body), 7);
    assert.equal(await deps.writePr(source, 7, pr.title, body), 7);
  });
  assert.deepEqual(await deps.readPr(source, 7), pr);
  assert.deepEqual(calls, [
    ["api", `repos/example/repo/pulls?state=all&head=example%3A${branch}&base=main`],
    ["api", "-X", "POST", "repos/example/repo/pulls", "-f", "base=main", "-f", `head=${branch}`, "-f", `title=${pr.title}`, "-f", `body=${body}`],
    ["api", "-X", "PATCH", "repos/example/repo/pulls/7", "-f", `title=${pr.title}`, "-f", `body=${body}`],
    ["api", "repos/example/repo/pulls/7"],
  ]);
});

test("W1-T12169 criterion 3 a changed assertion message retains the nested test identity", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-rerun-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "rerun.log");
  const file = "test/ci/example.test.mjs";
  const writeTree = (name: string, message: string, value: number) => {
    const tree = join(dir, name);
    mkdirSync(join(tree, "test", "ci"), { recursive: true });
    symlinkSync(join(REPO_ROOT, "node_modules"), join(tree, "node_modules"), "dir");
    mkdirSync(join(tree, "test", "setup"));
    writeFileSync(join(tree, "test", "setup", "tmp-hygiene.ts"), "");
    writeFileSync(join(tree, file), `
import { strictEqual } from "node:assert";
import { describe, it } from "node:test";
describe("outer", () => {
  it("fails [exactly]", () => strictEqual(${value}, 2, ${JSON.stringify(message)}));
});
describe("unrelated", () => {
  it("fails [exactly]", () => strictEqual(1, 2, "different full title"));
});
`);
    return tree;
  };
  const host = { name: "local fixture", kind: "linux", target: "local" } as const;
  const testId = { file, title: "outer > fails [exactly]" };
  const head = writeTree("head", "edited by this branch", 1);
  assert.equal(await rerunHandShipTest(host, head, testId, false, { log }), "red");
  assert.deepEqual(failingTestsFromTap(readFileSync(log, "utf8"), head), [{ ...testId, fileLevel: false }]);
  assert.equal(await rerunHandShipTest(host, writeTree("main", "original message", 1), testId, true, { log }), "red");
  assert.equal(await rerunHandShipTest(host, writeTree("green-main", "original message", 2), testId, true, { log }), "green");
});

test("W1-T12169 criterion 4 an actual lease rejects a competing fast-forward and a coalesced push", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-lease-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  const journal = shipRunJournal(dir);
  t.after(() => {
    journal.finish("refused");
    rmSync(dir, { recursive: true, force: true });
  });
  git(dir, "init", "--bare", origin);
  git(dir, "init", "-b", branch, work);
  git(work, "config", "user.name", "Hand Ship Fixture");
  git(work, "config", "user.email", "fixture@example.invalid");
  git(work, "remote", "add", "origin", origin);
  const commit = (message: string) => {
    git(work, "commit", "--allow-empty", "-m", message);
    return git(work, "rev-parse", "HEAD");
  };
  const first = commit("first");
  const moved = commit("other writer");
  const intended = commit("intended head");
  const ref = `refs/heads/${branch}`;
  git(origin, "fetch", work, ref);
  git(origin, "update-ref", ref, first);
  const { deps } = handShipProduction(work, dir, journal);
  const source = { branch, sha: intended, repo: "example/repo" };
  assert.equal(await deps.readTip(source), first);
  const ship = (expected: string | null, desired = intended) =>
    withLiveWritesAllowed(() => deps.push({ branch, sha: desired, repo: "example/repo" }, expected));
  git(origin, "update-ref", ref, moved);
  await assert.rejects(() => ship(first), /stale lease/);
  assert.equal(git(origin, "rev-parse", ref), moved);
  await ship(moved);
  assert.equal(git(origin, "rev-parse", ref), intended);
  await assert.rejects(() => ship(moved), /stale lease/);
  await assert.rejects(() => ship(intended, first), /merge-base/);
  assert.equal(git(origin, "rev-parse", ref), intended);
  await assert.rejects(() => ship(null), /stale lease/);
  git(origin, "update-ref", "-d", ref);
  assert.equal(await deps.readTip(source), null);
  await ship(null);
  assert.equal(git(origin, "rev-parse", ref), intended);
});

test("W1-T12169 criterion 5 stops a live run by id without inspecting processes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-test-"));
  const journal = shipRunJournal(dir);
  t.after(() => {
    journal.finish("stopped");
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(stopHandShip(dir, journal.id), true);
  assert.equal(journal.signal.aborted, false);
  await new Promise<void>((resolve) => journal.signal.addEventListener("abort", () => resolve(), { once: true }));
  const settled = waitForHandShipStop(dir, journal.id);
  journal.finish("stopped");
  assert.equal(await settled, "stopped");
  assert.equal(stopHandShip(dir, journal.id), false);
  assert.equal(stopHandShip(dir, "../other"), false);
});

test("the session records completed and stopped outcomes and reads the exact body file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "hand-ship");
  const terminalStatuses = () => readdirSync(root).filter((id) => id !== "preflight.lock")
    .map((id) => JSON.parse(readFileSync(join(root, id, "status.json"), "utf8")).status).sort();
  writeFileSync(join(dir, "body.md"), body);
  assert.deepEqual(handShipArgs(["--title", pr.title, "--body-file", "body.md"], dir), { title: pr.title, body });
  assert.throws(() => handShipArgs(["--title"], dir), /expected a value/);
  assert.throws(() => handShipArgs(["--unknown", "value"], dir), /unknown/);
  assert.equal(await withHandShipRun(dir, dir, async () => pr.url), 0);
  assert.deepEqual(terminalStatuses(), ["shipped"]);
  assert.equal(await withHandShipRun(dir, dir, async ({ signal }) => {
    const running = readdirSync(root).find((id) => /^[a-f0-9-]{36}$/.test(id) && stopHandShip(dir, id));
    assert.ok(running);
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    signal!.throwIfAborted();
    return pr.url;
  }), 1);
  assert.deepEqual(terminalStatuses(), ["shipped", "stopped"]);
});

test("W1-T12169 criterion 5 the stop marker cancels an active SSH-supervised rerun", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-ssh-stop-"));
  const journal = shipRunJournal(dir);
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    journal.finish("stopped");
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "ssh"), `#!/bin/sh
for word do remote=$word; done
case "$remote" in
  *kern.memorystatus_vm_pressure_level*) echo 1; exit 0 ;;
  *"/proc/meminfo"*) if [ -f "$0.fail-memory-probe" ]; then exit 2; fi
    echo "MemAvailable: 3000 kB"; exit 0 ;;
esac
exec /bin/sh -c "$remote"
`, { mode: 0o700 });
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(dir, "test", "setup"), { recursive: true });
  writeFileSync(join(dir, "test", "setup", "tmp-hygiene.ts"), "");
  const file = "test/isolated.test.mjs";
  const started = join(dir, "started");
  writeFileSync(join(dir, file), `
import { test } from "node:test";
import { writeFileSync } from "node:fs";
test("holds", () => {
  writeFileSync("started", "");
  return new Promise(() => setInterval(() => {}, 1000));
});
`);
  const { deps } = handShipProduction(dir, dir, journal, () => {});
  assert.deepEqual(await deps.readHost({ ...linux, kind: "mac" }), { reading: "memory pressure normal (1)", normal: true });
  assert.deepEqual(await deps.readHost(linux), { reading: "3000 kB available" });
  writeFileSync(join(dir, "ssh.fail-memory-probe"), "");
  assert.equal(await deps.readHost(linux), undefined);
  const rerun = rerunHandShipTest(linux, dir, { file, title: "holds" }, false, { signal: journal.signal, log: join(dir, "run.log") });
  const stopped = assert.rejects(rerun, /ssh stopped/);
  try {
    const limit = Date.now() + 5_000;
    while (!existsSync(started) && Date.now() < limit) await delay(20);
    assert.ok(existsSync(started), "the SSH-owned process must be running before it is stopped");
  } finally {
    stopHandShip(dir, journal.id);
    await stopped;
  }
});

test("a failed run log write stops the local child and preserves the error", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hand-ship-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  mkdirSync(join(dir, "test", "setup"), { recursive: true });
  writeFileSync(join(dir, "test", "setup", "tmp-hygiene.ts"), "");
  const file = "test/isolated.test.mjs";
  writeFileSync(join(dir, file), `
import { test } from "node:test";
import { mkdirSync, renameSync } from "node:fs";
test("cannot log", () => {
  renameSync("run.log", "old.log");
  mkdirSync("run.log");
  console.log("the pipe still has output to record");
});
`);
  const rerun = () => rerunHandShipTest({ ...linux, target: "local" }, dir, { file, title: "cannot log" }, false, { log: join(dir, "run.log") });
  await assert.rejects(rerun, /could not write the hand-ship log/);
  rmSync(join(dir, "run.log"), { recursive: true });
  const signalGroup = process.kill;
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    if (pid < 0 && signal === "SIGTERM") throw Object.assign(new Error("signal refused"), { code: "EPERM" });
    return signalGroup(pid, signal);
  });
  await assert.rejects(rerun, /could not signal .* signal refused/);
});
