import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { nextTaskIdCommand, type NextTaskIdReserveDeps } from "#src/run-task.js";
import { formatReservationAnchorMessage, RESERVATION_PUSH_GRACE_MS } from "#src/lib/task-id-reservation.js";
import { appendLedger, rotateLedger } from "#src/lib/ledger.js";
import { realLedgerFs } from "#src/lib/ledger-union.js";
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
  const ledgerPath = join(repo.dir, "state", "ledger.ndjson");
  const readRows = () => readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const deps = {
    repoRoot: repo.dir, runGit, auditNowMs: () => NOW, reapLedgerPath: ledgerPath,
    auditPullRequests: (() => pulls) as NextTaskIdReserveDeps["auditPullRequests"],
    auditPrFetch: undefined as NextTaskIdReserveDeps["auditPrFetch"],
    log: (step: string, fields: Record<string, unknown>) => {
      appendLedger(ledgerPath, { run_id: "reap-test", task_id: "REAP", step, ...fields });
      logs.push({ step, fields });
    },
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
  return { origin, repo, plan, anchor, sample, anchors, pulls, calls, logs, runGit, deps, remoteIds, invoke, ledgerPath, readRows };
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
  assert.equal(f.logs.find(l => l.step === "task_id.reservation_release_skipped" && l.fields.reserved_id === "W1-T107")?.fields.outcome, "foreign");
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
  const applied = await f.invoke(["--audit", "--reap", "--apply"], {
    runGit: args => {
      if (args[0] === "push") {
        const rows = f.readRows();
        const pending = rows.filter(row => row.step === "task_id.reservation_reap_pending");
        assert.deepEqual(pending.map(row => row.reserved_id), ["W1-T105", "W1-T106"]);
        assert.equal(rows.filter(row => row.step === "task_id.reservation_released").length, 0);
        assert.equal(new Set(pending.map(row => row.batch_id)).size, 1);
        for (const row of pending) {
          const anchor = f.anchors.get(Number(row.reserved_id.slice(4)))!;
          assert.equal(row.intent_status, "PENDING");
          assert.match(row.reason, /^eligible:/);
          assert.equal(row.ref, `refs/rmd-id/${row.reserved_id}`);
          assert.equal(row.sha, anchor.sha);
          assert.equal(row.anchor, anchor.message);
          assert.match(row.holder, /^rmd-id holder /);
          assert.equal(row.repository, f.origin.dir);
          assert.equal(row.bound_ms, DAY);
          assert.deepEqual(row.basis, { n: 1, max_ms: DAY, p50_ms: DAY, population: ["W1-T110"] });
          assert.deepEqual(row.eligibility, { status: "CANDIDATE", age_ms: 20 * DAY,
            reasons: ["no holding evidence older than threshold"] });
        }
      }
      return f.runGit(args);
    },
  });
  assert.equal(applied.code, 0, applied.text);
  const released = f.logs.filter(l => l.step === "task_id.reservation_released");
  assert.deepEqual(released.map(l => l.fields.reserved_id), ["W1-T105", "W1-T106"]);
  for (const row of released) {
    const id = Number(String(row.fields.reserved_id).slice(4));
    assert.equal(row.fields.intent_status, "RESOLVED");
    assert.equal(row.fields.deletion_actor, row.fields.batch_id);
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
    ["--audit", "--apply"], ["--audit", "--reap", "--audit-age-days", "0"],
    ["--reconcile"], ["--audit", "--reap", "--reconcile", "--apply"],
    ["--audit", "--reap", "--reconcile", "--offline"]]) {
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

test("a reap records guarded and explicitly rejected pushes as skips", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  const before = f.remoteIds();
  for (const mode of ["guard", "rejected"]) {
    const r = await f.invoke(["--audit", "--reap", "--apply"], {
      runGit: args => {
        if (mode === "guard" && args[0] === "remote") return { status: 0, stdout: "https://example.invalid/live.git", stderr: "" };
        if (args[0] === "push") return { status: 1, stdout: "!\t:refs/rmd-id/W1-T105\t[remote rejected] (hook declined)\n", stderr: "" };
        return f.runGit(args);
      },
    });
    assert.equal(r.code, 1, r.text);
    assert.deepEqual(f.remoteIds(), before);
    assert.equal(f.logs.at(-1)!.step, "task_id.reservation_release_skipped");
    assert.equal(f.logs.at(-1)!.fields.outcome, "failed");
    assert.equal(f.logs.at(-1)!.fields.intent_status, "RESOLVED");
    assert.match(String(f.logs.at(-1)!.fields.reason), /^reap skipped/);
    assert.match(String(f.logs.at(-1)!.fields.detail), /REFUSED|hook declined/);
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

test("a reap's default logger persists verified per-id intents and outcomes in a contained ledger", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  const r = await f.invoke(["--audit", "--reap", "--apply"], { log: undefined });
  assert.equal(r.code, 0, r.text);
  const rows = f.readRows();
  assert.deepEqual(rows.map(row => row.step), ["task_id.reservation_reap_planned",
    "task_id.reservation_reap_pending", "task_id.reservation_released"]);
  assert.equal(rows[1].sha, f.anchors.get(105)!.sha);
  assert.equal(rows[1].anchor, f.anchors.get(105)!.message);
  assert.equal(rows[1].intent_status, "PENDING");
  assert.equal(rows[2].intent_status, "RESOLVED");
  assert.equal(rows[1].batch_id, rows[2].batch_id);
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

test("a reap refuses unwritten intents and preserves unknown post-push outcomes", async (t) => {
  for (const mode of ["first-write", "second-write", "readback-missing", "readback-partial", "readback-torn", "readback-unreadable", "earlier-lost", "first-outcome", "second-outcome", "outcome-readback"]) {
    await t.test(mode, async t => {
      const f = fixture(t);
      f.sample(110, DAY);
      f.anchor(105);
      f.anchor(106);
      const before = f.remoteIds();
      let intents = 0, outcomes = 0;
      const afterPush = mode.includes("outcome");
      const r = await f.invoke(["--audit", "--reap", "--apply"], {
        log: (step, fields) => {
          if (step === "task_id.reservation_reap_pending") {
            intents++;
            if ((mode === "first-write" && intents === 1) || (mode === "second-write" && intents === 2)) throw new Error("intent disk full");
            if (mode === "readback-missing") return;
            if (mode === "readback-partial") { f.deps.log(step, { ...fields, holder: null }); return; }
          }
          if (step === "task_id.reservation_released") {
            outcomes++;
            if ((mode === "first-outcome" && outcomes === 1) || (mode === "second-outcome" && outcomes === 2)) throw new Error("outcome disk full");
            if (mode === "outcome-readback") return;
          }
          f.deps.log(step, fields);
          if (step === "task_id.reservation_reap_pending") {
            if (mode === "readback-torn") appendFileSync(f.ledgerPath, '{"step":');
            if (mode === "readback-unreadable") { rmSync(f.ledgerPath); mkdirSync(f.ledgerPath); }
            if (mode === "earlier-lost" && intents === 2) writeFileSync(f.ledgerPath,
              f.readRows().filter(row => row.reserved_id !== "W1-T105").map(row => JSON.stringify(row) + "\n").join(""));
          }
        },
      });
      assert.equal(r.code, 2, r.text);
      assert.match(r.text, /UNKNOWN/);
      if (afterPush) {
        assert.deepEqual(f.remoteIds(), ["refs/rmd-id/W1-T110"]);
        assert.equal(f.readRows().filter(row => row.step === "task_id.reservation_reap_pending").length, 2);
        f.anchor(107);
        const pushed = f.calls.filter(args => args[0] === "push").length;
        const retry = await f.invoke(["--audit", "--reap", "--apply"]);
        assert.equal(retry.code, 2, retry.text);
        assert.match(retry.text, /unresolved batch/);
        assert.equal(f.calls.filter(args => args[0] === "push").length, pushed);
      } else {
        assert.deepEqual(f.remoteIds(), before);
        assert.equal(f.calls.filter(args => args[0] === "push").length, 0);
      }
    });
  }
});

test("an unavailable reap push stays unknown with its pending intents", async (t) => {
  for (const mode of ["throw", "failed", "missing-success", "lost-after-delete", "malformed-status"]) {
    await t.test(mode, async t => {
      const f = fixture(t);
      f.sample(110, DAY);
      f.anchor(105);
      const r = await f.invoke(["--audit", "--reap", "--apply"], {
        runGit: args => {
          if (args[0] === "push") {
            if (mode === "throw") throw new Error("push result lost");
            if (mode === "lost-after-delete") f.runGit(args);
            if (mode === "malformed-status") return { status: 1, stdout: "x\t:refs/rmd-id/W1-T105\t[rejected] (stale info)\n", stderr: "" };
            return { status: mode === "missing-success" ? 0 : 1, stdout: "", stderr: "push result unavailable" };
          }
          return f.runGit(args);
        },
      });
      assert.equal(r.code, 2, r.text);
      assert.match(r.text, /W1-T105 UNKNOWN/);
      const outcome = f.readRows().at(-1);
      assert.equal(outcome.outcome, "unknown");
      assert.equal(outcome.intent_status, "PENDING");
      assert.match(outcome.reason, /^reap outcome unknown:/);
      assert.equal(f.readRows().filter(row => row.step === "task_id.reservation_released").length, 0);
      f.anchor(106);
      const pushes = f.calls.filter(args => args[0] === "push").length;
      assert.equal((await f.invoke(["--audit", "--reap", "--apply"])).code, 2);
      assert.equal(f.calls.filter(args => args[0] === "push").length, pushes);
    });
  }
});

test("pending reap intents reconcile truthfully across ledger rotation without another deletion", async (t) => {
  const f = fixture(t);
  f.sample(110, DAY);
  for (const id of [105, 106, 107]) f.anchor(id);
  const interrupted = await f.invoke(["--audit", "--reap", "--apply"], {
    runGit: args => args[0] === "push" ? { status: 1, stdout: "", stderr: "result unavailable" } : f.runGit(args),
  });
  assert.equal(interrupted.code, 2, interrupted.text);
  const pending = f.readRows().filter(row => row.step === "task_id.reservation_reap_pending");
  assert.equal(pending.length, 3);
  const state = join(f.repo.dir, "state");
  // Real rotation must preserve the pending records even though the live file need not carry them.
  rotateLedger(f.ledgerPath, { ceilingBytes: 1 });
  writeFileSync(join(state, "ledger.2026-10-22T00-00-00-000Z.ndjson.gz"), gzipSync(JSON.stringify(pending[0]) + "\n"));
  writeFileSync(join(state, "ledger.2026-10-23T00-00-00-000Z.ndjson"), pending.slice(1).map(row => JSON.stringify(row) + "\n").join(""));
  writeFileSync(f.ledgerPath, JSON.stringify({ step: "task_id.reservation_reap_planned" }) + "\n");
  f.origin.git("update-ref", "-d", "refs/rmd-id/W1-T105");
  const moved = f.repo.git("rev-parse", "HEAD");
  f.origin.git("update-ref", "refs/rmd-id/W1-T106", moved);
  f.calls.length = 0;
  const reconcileFlags = ["--audit", "--reap", "--reconcile"];
  await t.test("unreadable directory enumeration cannot hide rotated pending intents", async t => {
    const before = f.remoteIds();
    const list = realLedgerFs.readdirSync;
    let attempts = 0;
    const denied = t.mock.method(realLedgerFs, "readdirSync", (directory: string) => {
      if (directory === state) {
        attempts++;
        throw Object.assign(new Error("EACCES: ledger directory enumeration denied"), { code: "EACCES" });
      }
      return list(directory);
    });
    try {
      for (const flags of [reconcileFlags, ["--audit", "--reap", "--apply"]]) {
        const refused = await f.invoke(flags);
        assert.equal(refused.code, 2, refused.text);
        assert.match(refused.text, /history UNKNOWN: directories=.*EACCES.*enumeration denied/);
        assert.deepEqual(f.remoteIds(), before);
        assert.equal(f.calls.filter(args => args[0] === "push").length, 0);
        assert.equal(f.readRows().filter(row => row.intent_status).length, 0);
      }
      assert.equal(attempts, 2);
    } finally { denied.mock.restore(); }
  });
  f.calls.length = 0;
  const reconciled = await f.invoke(reconcileFlags, { log: undefined });
  assert.equal(reconciled.code, 0, reconciled.text);
  const resolutions = f.readRows().filter(row => row.step === "task_id.reservation_reap_reconciled");
  assert.deepEqual(resolutions.map(row => [row.reserved_id, row.outcome, row.deletion_actor, row.intent_status]), [
    ["W1-T105", "observed_absent", "UNKNOWN", "RESOLVED"],
    ["W1-T106", "foreign", "UNKNOWN", "RESOLVED"],
    ["W1-T107", "unchanged", "UNKNOWN", "RESOLVED"],
  ]);
  assert.equal(resolutions[0].observed_sha, null);
  assert.equal(resolutions[1].observed_sha, moved);
  assert.equal(resolutions[2].observed_sha, f.anchors.get(107)!.sha);
  assert.deepEqual(f.calls, [105, 106, 107].map(id => ["ls-remote", "origin", `refs/rmd-id/W1-T${id}`]).toSpliced(0, 0, ["remote", "get-url", "origin"]));
  assert.equal(f.origin.git("rev-parse", "refs/rmd-id/W1-T106"), moved);
  assert.equal(f.origin.git("rev-parse", "refs/rmd-id/W1-T107"), f.anchors.get(107)!.sha);
  const again = await f.invoke(reconcileFlags);
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /0 pending intent/);
  assert.equal(f.readRows().filter(row => row.step === "task_id.reservation_reap_reconciled").length, 3);
  assert.equal(f.calls.filter(args => args[0] === "push").length, 0);
  // A subsequent explicit apply performs a fresh complete audit rather than replaying the old batch.
  const fresh = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(fresh.code, 0, fresh.text);
  assert.deepEqual(f.remoteIds(), ["refs/rmd-id/W1-T106", "refs/rmd-id/W1-T110"]);
});

test("reconciliation refuses incomplete ledger history and unknown exact-ref readings", async (t) => {
  for (const mode of ["gzip", "plain", "unread-plain", "live", "unknown-file", "ref", "malformed-ref", "resolution-write", "resolution-readback"]) {
    await t.test(mode, async t => {
      const f = fixture(t);
      f.sample(110, DAY);
      f.anchor(105);
      assert.equal((await f.invoke(["--audit", "--reap", "--apply"], {
        runGit: args => args[0] === "push" ? { status: 1, stdout: "", stderr: "unknown" } : f.runGit(args),
      })).code, 2);
      assert.equal(f.readRows().filter(row => row.step === "task_id.reservation_reap_pending").length, 1);
      const before = f.remoteIds();
      const archive = join(f.repo.dir, "state", `ledger.2026-10-23T00-00-00-000Z.ndjson${mode === "gzip" ? ".gz" : ""}`);
      if (mode === "gzip") writeFileSync(archive, "invalid gzip");
      if (mode === "plain") writeFileSync(archive, '{"step":');
      if (mode === "unread-plain") mkdirSync(archive);
      if (mode === "live") appendFileSync(f.ledgerPath, '{"step":');
      if (mode === "unknown-file") writeFileSync(join(f.repo.dir, "state", "ledger.unknown"), "unknown history");
      f.calls.length = 0;
      const refusedApply = await f.invoke(["--audit", "--reap", "--apply"]);
      assert.equal(refusedApply.code, 2, refusedApply.text);
      assert.deepEqual(f.remoteIds(), before);
      assert.equal(f.calls.filter(args => args[0] === "push").length, 0);
      const result = await f.invoke(["--audit", "--reap", "--reconcile"], {
        runGit: args => {
          if (args[0] === "ls-remote" && mode === "ref") return { status: 1, stdout: "", stderr: "remote unavailable" };
          if (args[0] === "ls-remote" && mode === "malformed-ref") return { status: 0, stdout: "garbled", stderr: "" };
          return f.runGit(args);
        },
        log: (step, fields) => {
          if (step === "task_id.reservation_reap_reconciled") {
            if (mode === "resolution-write") throw new Error("resolution unavailable");
            if (mode === "resolution-readback") return;
          }
          f.deps.log(step, fields);
        },
      });
      assert.equal(result.code, 2, `${mode}: ${result.text}`);
      assert.match(result.text, /UNKNOWN/);
      assert.deepEqual(f.remoteIds(), before);
      assert.equal(f.calls.filter(args => args[0] === "push").length, 0);
      assert.equal(readFileSync(f.ledgerPath, "utf8").includes('"step":"task_id.reservation_reap_reconciled"'), false);
    });
  }
});

test("reconciliation's default git reader observes the fixture without deleting", async t => {
  const f = fixture(t);
  f.sample(110, DAY);
  f.anchor(105);
  assert.equal((await f.invoke(["--audit", "--reap", "--apply"], {
    runGit: args => args[0] === "push" ? { status: 1, stdout: "", stderr: "unknown" } : f.runGit(args),
  })).code, 2);
  const before = f.remoteIds();
  const result = await f.invoke(["--audit", "--reap", "--reconcile"], { runGit: undefined, log: undefined });
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /W1-T105 unchanged; actor UNKNOWN/);
  assert.deepEqual(f.remoteIds(), before);
  assert.equal(f.readRows().at(-1).outcome, "unchanged");
});


test("the reap bar keeps later qualifying filing delays when a holder branch has an older unrelated PR", async (t) => {
  const f = fixture(t);
  f.sample(110, 3 * DAY);
  f.sample(111, 7 * DAY);
  f.pulls.unshift({ body: "Remudero-Task: W1-T9999", head: { ref: "filing-111" },
    created_at: new Date(NOW - 30 * DAY).toISOString(), state: "closed" });
  f.anchor(112, 5);
  const before = f.remoteIds();
  const result = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(result.code, 0, result.text);
  const summary = f.logs.find((row) => row.step === "task_id.reservation_reap_planned")!.fields;
  assert.equal(summary.bound_ms, 7 * DAY, JSON.stringify({ actualBound: summary.bound_ms, before, after: f.remoteIds() }));
  assert.deepEqual(f.remoteIds(), before, "a five-day reservation is younger than the actual seven-day filing delay");
  assert.equal(f.calls.filter((args) => args[0] === "push").length, 0);
});


test("the reap compares each reused holder reservation with its own anchor", async (t) => {
  const f = fixture(t);
  f.sample(110, 3 * DAY);
  f.pulls[0]!.state = "closed";
  f.anchor(111, 10, "filing-110");
  f.pulls.push({ body: "Remudero-Task: W1-T111", head: { ref: "filing-110" },
    created_at: new Date(NOW - 3 * DAY).toISOString(), state: "open" });
  f.anchor(112, 5);
  const before = f.remoteIds();
  const result = await f.invoke(["--audit", "--reap", "--apply"]);
  assert.equal(result.code, 0, result.text);
  const summary = f.logs.find((row) => row.step === "task_id.reservation_reap_planned")!.fields;
  assert.equal(summary.bound_ms, 7 * DAY);
  assert.deepEqual(summary.basis, { n: 2, max_ms: 7 * DAY, p50_ms: 5 * DAY, population: ["W1-T110", "W1-T111"] });
  assert.deepEqual(f.remoteIds(), before);
  assert.equal(f.calls.filter((args) => args[0] === "push").length, 0);
});
