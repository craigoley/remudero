import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { nextTaskIdCommand, type NextTaskIdReserveDeps } from "#src/run-task.js";
import { formatReservationAnchorMessage, RESERVATION_PUSH_GRACE_MS } from "#src/lib/task-id-reservation.js";
import { gitRepo } from "#test/helpers/git-repo.js";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const DAY = 86_400_000;
type Pull = { body: string; head: { ref: string }; created_at: string; state: string };

function fixture(t: TestContext) {
  const origin = gitRepo({ bare: true, scope: t, kind: "reap-origin" });
  const repo = gitRepo({ scope: t, kind: "reap-reader" });
  repo.addRemote("origin", origin.dir);
  mkdirSync(join(repo.dir, "plan"));
  const plan = join(repo.dir, "plan", "tasks.yaml");
  writeFileSync(plan, "- id: W1-T101\n  title: declared\n  type: implement\n  repo: remudero\n  depends_on: []\n  status: queued\n");
  repo.git("add", "plan");
  repo.git("commit", "-qm", "fixture plan");
  repo.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  const anchors = new Map<number, { sha: string; message: string }>();
  const pulls: Pull[] = [];
  const calls: string[][] = [];
  const logs: { step: string; fields: Record<string, unknown> }[] = [];
  const runGit: NonNullable<NextTaskIdReserveDeps["runGit"]> = (args) => {
    calls.push(args);
    const r = spawnSync("git", ["-C", repo.dir, ...args], { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const deps = {
    repoRoot: repo.dir, runGit, auditNowMs: () => NOW,
    auditPullRequests: (() => pulls) as NextTaskIdReserveDeps["auditPullRequests"],
    auditPrFetch: undefined as NextTaskIdReserveDeps["auditPrFetch"],
    log: (step: string, fields: Record<string, unknown>) => { logs.push({ step, fields }); },
  };
  function anchor(id: number, ageDays = 20, branch = `lost-${id}`) {
    const message = formatReservationAnchorMessage({ branch, startedAt: new Date(NOW - ageDays * DAY).toISOString() });
    const sha = repo.git("commit-tree", "HEAD^{tree}", "-m", message);
    repo.git("update-ref", `refs/rmd-id/W1-T${id}`, sha);
    repo.git("push", "--quiet", "origin", `refs/rmd-id/W1-T${id}`);
    anchors.set(id, { sha, message });
    return sha;
  }
  function sample(id: number, delayMs: number, ageDays = 20) {
    const branch = `filing-${id}`;
    anchor(id, ageDays, branch);
    repo.git("push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
    pulls.push({ body: `Remudero-Task: W1-T${id}`, head: { ref: branch },
      created_at: new Date(NOW - ageDays * DAY + delayMs).toISOString(), state: "open" });
  }
  const remoteIds = () => origin.git("for-each-ref", "--format=%(refname)", "refs/rmd-id/").split("\n").filter(Boolean);
  async function invoke(flags = ["--audit", "--reap"], overrides: NextTaskIdReserveDeps = {}) {
    const out: string[] = [];
    const oldLog = console.log, oldError = console.error;
    console.log = (...args) => { out.push(args.join(" ")); };
    console.error = (...args) => { out.push(args.join(" ")); };
    try {
      const code = await nextTaskIdCommand([...flags, "--plan", plan], {}, { ...deps, ...overrides });
      return { code, text: out.join("\n") };
    } finally {
      console.log = oldLog;
      console.error = oldError;
    }
  }
  return { origin, repo, plan, anchor, sample, anchors, pulls, calls, logs, runGit, deps, remoteIds, invoke };
}

test("a reap deletes only candidate reservations past the bar in one leased push", async (t) => {
  const f = fixture(t);
  f.sample(110, 3 * DAY);
  for (const id of [101, 102, 103, 104, 105, 106, 107]) f.anchor(id, id === 106 ? 3 : 20);
  f.repo.git("push", "--quiet", "origin", "HEAD:refs/heads/run-W1-T102-123");
  f.pulls.push({ body: "Remudero-Task: W1-T103", head: { ref: "run-W1-T103-456" }, created_at: new Date(NOW - 20 * DAY + 1000).toISOString(), state: "open" });
  const unknown = f.repo.git("commit-tree", "HEAD^{tree}", "-m", "legacy anchor without an age");
  f.repo.git("push", "--quiet", "--force", "origin", `${unknown}:refs/rmd-id/W1-T104`);
  const moved = f.repo.git("rev-parse", "HEAD");
  const r = await f.invoke(["--audit", "--reap", "--apply"], {
    runGit: (args) => {
      if (args[0] === "push") f.origin.git("update-ref", "refs/rmd-id/W1-T107", moved);
      return f.runGit(args);
    },
  });
  assert.equal(r.code, 1, r.text);
  assert.deepEqual(f.remoteIds(), [101, 102, 103, 104, 106, 107, 110].map(id => `refs/rmd-id/W1-T${id}`));
  const pushes = f.calls.filter(a => a[0] === "push");
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0].includes("--porcelain"));
  assert.ok(pushes[0].includes(`--force-with-lease=refs/rmd-id/W1-T105:${f.anchors.get(105)!.sha}`));
  assert.equal(f.origin.git("rev-parse", "refs/rmd-id/W1-T107"), moved);
  assert.equal(f.logs.find(l => l.fields.reserved_id === "W1-T107")?.fields.outcome, "foreign");
  assert.equal(f.calls.filter(a => a[0] === "fetch").length, 1);
  assert.equal(f.repo.git("for-each-ref", "--format=%(refname)", "refs/rmd-reap/"), "");
});

test("a reap with any unreadable surface deletes nothing", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  const before = f.remoteIds();
  for (const surface of ["refs", "heads", "anchor", "fetch", "plan-history", "open-PR", "plan"]) {
    const r = await f.invoke(["--audit", "--reap", "--apply"], {
      runGit: (args) => {
        const fail = surface === "refs" && args[0] === "ls-remote" && args[1] === "origin"
          || surface === "heads" && args[0] === "ls-remote" && args[1] === "--heads"
          || surface === "anchor" && args[0] === "log" && args.includes("--format=%B")
          || surface === "fetch" && args[0] === "fetch"
          || surface === "plan-history" && args[0] === "log" && args.includes("-p");
        if (fail) return { status: 1, stdout: "", stderr: `${surface} unavailable` };
        return f.runGit(args);
      },
      auditPullRequests: () => {
        if (surface === "open-PR") throw new Error("open-PR unavailable");
        if (surface === "plan") writeFileSync(f.plan, "invalid: [");
        return f.pulls;
      },
    });
    assert.equal(r.code, 2, `${surface}: ${r.text}`);
    assert.match(r.text, new RegExp(surface === "refs" ? "reservation ref" : surface === "heads" ? "branch" : surface));
    assert.deepEqual(f.remoteIds(), before);
  }
  assert.equal(f.calls.filter(a => a[0] === "push").length, 0);
});

test("the reap bar is derived from the measured reserve-to-PR delays", async (t) => {
  const f = fixture(t);
  f.sample(110, 34_000);
  f.sample(111, 3 * DAY);
  f.anchor(105, 2);
  f.anchor(106, 4);
  // A re-opened filing must use its FIRST PR, even if the newer PR is listed first.
  f.pulls.unshift({ ...f.pulls[0], created_at: new Date(NOW - DAY).toISOString() });
  const r = await f.invoke();
  assert.equal(r.code, 0, r.text);
  const summary = f.logs.find(l => l.step === "task_id.reservation_reap_planned")!.fields;
  assert.equal(summary.bound_ms, 3 * DAY);
  assert.deepEqual(summary.basis, { n: 2, max_ms: 3 * DAY, p50_ms: (34_000 + 3 * DAY) / 2,
    population: ["W1-T110", "W1-T111"] });
  assert.match(r.text, /max.*259200000/);
  assert.match(r.text, /W1-T105 HELD/);
  assert.match(r.text, /W1-T106 CANDIDATE/);
  f.pulls.shift();
  f.pulls.splice(1);
  const floor = await f.invoke();
  assert.equal(floor.code, 0);
  assert.equal(f.logs.at(-1)!.fields.bound_ms, RESERVATION_PUSH_GRACE_MS);
  f.pulls.length = 0;
  const empty = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(empty.code, 2);
  assert.match(empty.text, /no measured population/);
  assert.equal(f.calls.filter(a => a[0] === "push").length, 0);
});

test("a live holder branch holds a reservation", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  // Use a valid branch with an encoded slash in the holder line.
  f.anchor(105, 30, "operator/filing");
  f.repo.git("push", "--quiet", "origin", "HEAD:refs/heads/operator/filing");
  const audit = await f.invoke(["--audit"], { openPrTexts: () => [], auditHistoryIds: () => [] });
  assert.equal(audit.code, 0, audit.text);
  assert.match(audit.text, /W1-T105 HELD live holder branch operator\/filing/);
  assert.match(audit.text, /age threshold: 14 day/);
  f.calls.length = 0;
  const r = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /W1-T105 HELD live holder branch operator\/filing/);
  assert.ok(f.remoteIds().includes("refs/rmd-id/W1-T105"));
  assert.deepEqual(f.calls.filter(a => a[0] === "ls-remote" && a[1] === "--heads"), [["ls-remote", "--heads", "origin"]]);
});

test("a reap is a dry run unless applied, and an applied reap ledgers every id", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  f.anchor(106);
  const before = f.remoteIds();
  const dry = await f.invoke();
  assert.equal(dry.code, 0, dry.text);
  assert.deepEqual(f.remoteIds(), before);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].step, "task_id.reservation_reap_planned");
  assert.equal(f.logs[0].fields.candidates, 2);
  assert.match(dry.text, /dry.run/);
  const applied = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(applied.code, 0, applied.text);
  const released = f.logs.filter(l => l.step === "task_id.reservation_released");
  assert.deepEqual(released.map(l => l.fields.reserved_id), ["W1-T105", "W1-T106"]);
  for (const row of released) {
    const id = Number(String(row.fields.reserved_id).slice(4));
    assert.equal(row.fields.lane, "reap");
    assert.equal(row.fields.sha, f.anchors.get(id)!.sha);
    assert.equal(row.fields.anchor, f.anchors.get(id)!.message);
    assert.match(String(row.fields.holder), /^rmd-id holder /);
    assert.match(String(row.fields.reason), /^reaped: no shard\/branch\/PR; age .* > bound /);
  }
  assert.deepEqual(f.remoteIds(), ["refs/rmd-id/W1-T110"]);
});

test("a reap refuses offline, missing audit, an unpaired apply, and a fixed age override", async (t) => {
  const f = fixture(t);
  for (const flags of [["--audit", "--reap", "--offline"], ["--reap"], ["--apply"],
    ["--audit", "--apply"], ["--audit", "--reap", "--audit-age-days", "0"]]) {
    assert.equal((await f.invoke(flags)).code, 2);
  }
  assert.equal(f.calls.length, 0);
});

test("a reap's default git runner reads and deletes against the supplied fixture repository", async (t) => {
  const f = fixture(t);
  f.sample(110, 34_000);
  f.anchor(105);
  const r = await f.invoke(["--audit", "--reap", "--apply"], { runGit: undefined });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(f.remoteIds(), ["refs/rmd-id/W1-T110"]);
  assert.equal(f.logs.filter(l => l.step === "task_id.reservation_released").length, 1);
});

test("a reap journals recovery before pushing and refuses a failed journal", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  const before = f.remoteIds();
  const refused = await f.invoke(["--audit", "--reap", "--apply"], {
    log: () => { throw new Error("journal full"); },
  });
  assert.equal(refused.code, 2);
  assert.match(refused.text, /journal full/);
  assert.deepEqual(f.remoteIds(), before);
  assert.equal(f.calls.filter(a => a[0] === "push").length, 0);
  const applied = await f.invoke(["--audit", "--reap", "--apply"], {
    runGit: args => {
      if (args[0] === "push") {
        const recovery = f.logs[0].fields.recovery as { sha: string; anchor: string }[];
        assert.equal(recovery[0].sha, f.anchors.get(105)!.sha);
        assert.equal(recovery[0].anchor, f.anchors.get(105)!.message);
      }
      return f.runGit(args);
    },
  });
  assert.equal(applied.code, 0, applied.text);
});

test("a reap records guarded, thrown and failed pushes as skips", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  const before = f.remoteIds();
  for (const mode of ["guard", "throw", "failed", "rejected"]) {
    const r = await f.invoke(["--audit", "--reap", "--apply"], {
      runGit: args => {
        if (mode === "guard" && args[0] === "remote") return { status: 0, stdout: "https://example.invalid/live.git", stderr: "" };
        if (args[0] === "push") {
          if (mode === "throw") throw new Error("push threw");
          if (mode === "rejected") return { status: 1, stdout: "!\t:refs/rmd-id/W1-T105\t[remote rejected] (hook declined)\n", stderr: "" };
          return { status: 1, stdout: "", stderr: "push unavailable" };
        }
        return f.runGit(args);
      },
    });
    assert.equal(r.code, 1, r.text);
    assert.deepEqual(f.remoteIds(), before);
    assert.equal(f.logs.at(-1)!.step, "task_id.reservation_release_skipped");
    assert.equal(f.logs.at(-1)!.fields.outcome, "failed");
    assert.match(String(f.logs.at(-1)!.fields.detail), /REFUSED|push threw|push unavailable|hook declined/);
  }
});

test("a reap splits a batch only after the platform refuses its argument list", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  f.anchor(106);
  let attempts = 0;
  const r = await f.invoke(["--audit", "--reap", "--apply"], {
    runGit: args => {
      if (args[0] === "push") {
        attempts++;
        if (args.filter(a => a.startsWith(":refs/")).length > 1) return { status: 1, stdout: "", stderr: "spawnSync git E2BIG" };
      }
      return f.runGit(args);
    },
  });
  assert.equal(r.code, 0, r.text);
  assert.equal(attempts, 3);
  assert.deepEqual(f.remoteIds(), ["refs/rmd-id/W1-T110"]);
  assert.equal(f.logs.filter(l => l.step === "task_id.reservation_released").length, 2);
});

test("a reap includes a closed filing's first PR in its measured population", async (t) => {
  const f = fixture(t);
  f.sample(110, 5 * DAY);
  f.pulls[0].state = "closed";
  f.repo.git("push", "--quiet", "origin", ":refs/heads/filing-110");
  writeFileSync(f.plan, "- id: W1-T110\n  title: filed\n  type: implement\n  repo: remudero\n  depends_on: []\n  status: queued\n");
  f.repo.git("add", "plan");
  f.repo.git("commit", "-qm", "file then fold");
  f.repo.git("push", "--quiet", "origin", "HEAD:refs/heads/main");
  f.anchor(105, 4);
  f.anchor(106, 6);
  const r = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(r.code, 0, r.text);
  assert.equal(f.logs[0].fields.bound_ms, 5 * DAY);
  assert.deepEqual(f.remoteIds(), ["refs/rmd-id/W1-T105", "refs/rmd-id/W1-T110"]);
});

test("a reap pages the complete PR population and fails closed on a malformed page", async (t) => {
  const f = fixture(t);
  f.sample(110, 3 * DAY);
  f.anchor(105, 4);
  const calls: string[][] = [];
  const paged = await f.invoke(["--audit", "--reap"], {
    auditPullRequests: undefined,
    auditPrFetch: args => {
      calls.push(args);
      return args[1].endsWith("page=1") ? Array.from({ length: 100 }, () => f.pulls[0]) : [];
    },
  });
  assert.equal(paged.code, 0, paged.text);
  assert.equal(calls.length, 2);
  assert.match(calls[1][1], /state=all.*page=2$/);
  assert.equal(f.logs.at(-1)!.fields.bound_ms, 3 * DAY);
  const broken = await f.invoke(["--audit", "--reap", "--apply"], {
    auditPullRequests: undefined, auditPrFetch: () => ({ message: "incomplete" }),
  });
  assert.equal(broken.code, 2, broken.text);
  assert.match(broken.text, /invalid PR page/);
  assert.ok(f.remoteIds().includes("refs/rmd-id/W1-T105"));
});

test("a reap's default logger persists recovery and per-id outcomes in a contained ledger", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  const configDir = join(homedir(), ".config", "remudero");
  const config = join(configDir, "config.json");
  const original = existsSync(config) ? readFileSync(config, "utf8") : undefined;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(config, JSON.stringify({ root: f.repo.dir, claudeBin: process.execPath }));
  try {
    const r = await f.invoke(["--audit", "--reap", "--apply"], { log: undefined });
    assert.equal(r.code, 0, r.text);
    const rows = readFileSync(join(f.repo.dir, "state", "ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.step), ["task_id.reservation_reap_planned", "task_id.reservation_released"]);
    assert.equal(rows[1].sha, f.anchors.get(105)!.sha);
    assert.equal(rows[0].recovery[0].anchor, f.anchors.get(105)!.message);
  } finally {
    if (original === undefined) rmSync(config);
    else writeFileSync(config, original);
  }
});

test("a reap treats malformed readings, shallow history and failed cleanup as unreadable", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  const before = f.remoteIds();
  for (const mode of ["refs", "noncanonical", "heads", "empty-anchor", "shallow", "cleanup", "PR"]) {
    const r = await f.invoke(["--audit", "--reap", "--apply"], {
      runGit: args => {
        const answer = (stdout: string) => ({ status: 0, stdout, stderr: "" });
        if (args[0] === "ls-remote" && args[1] === "origin") {
          if (mode === "refs") return answer("invalid listing");
          if (mode === "noncanonical") return answer(`${"a".repeat(40)}\trefs/rmd-id/W1-T0105\n`);
        }
        if (mode === "heads" && args[0] === "ls-remote" && args[1] === "--heads") return answer("missing sha");
        if (mode === "empty-anchor" && args.includes("--format=%B")) return answer("");
        if (mode === "shallow" && args.includes("--is-shallow-repository")) return answer("true");
        if (mode === "cleanup" && args[0] === "for-each-ref") return answer("refs/heads/main");
        return f.runGit(args);
      },
      auditPullRequests: () => mode === "PR" ? [{ ...f.pulls[0], created_at: "invalid" }] : f.pulls,
    });
    assert.equal(r.code, 2, `${mode}: ${r.text}`);
    assert.match(r.text, /DEGRADED/);
    assert.deepEqual(f.remoteIds(), before);
  }
  assert.equal(f.calls.filter(a => a[0] === "push").length, 0);
});

test("a reap measures encoded hand-mint timestamps and preserves malformed holder rows", async (t) => {
  const f = fixture(t);
  f.sample(110, 3 * DAY);
  const encoded = f.anchors.get(110)!.message.split("\n\n")[1];
  const sha = f.repo.git("commit-tree", "HEAD^{tree}", "-m", `reserve W1-T110 filing-110\n\n${encoded}`);
  f.repo.git("push", "--quiet", "--force", "origin", `${sha}:refs/rmd-id/W1-T110`);
  f.anchor(105);
  const bad = f.repo.git("commit-tree", "HEAD^{tree}", "-m", `reservation 2026-09-01T00:00:00.000Z\n\nrmd-id holder branch=%ZZ`);
  f.repo.git("push", "--quiet", "origin", `${bad}:refs/rmd-id/W1-T106`);
  const r = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(r.code, 0, r.text);
  assert.equal(f.logs[0].fields.bound_ms, 3 * DAY);
  assert.match(r.text, /W1-T106 UNKNOWN anchor holder unreadable/);
  assert.deepEqual(f.remoteIds(), ["refs/rmd-id/W1-T106", "refs/rmd-id/W1-T110"]);
});
