import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { gzipSync } from "node:zlib";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const SINCE = "2026-10-13T12:00:00.000Z";
const START = Date.parse(SINCE) / 1000;
type Row = Record<string, unknown>;

function emptyWake(at: number, duration = 70, admitted = false): Row[] {
  const row = (offset: number, step: string) => ({ ts: new Date((at + offset) * 1000).toISOString(), step });
  return [
    { ...row(0, "daemon.idle_starved.engine_wake"), reason: "engine_revision_changed" },
    row(1, "daemon.boot"),
    ...(admitted ? [row(2, "dispatch.claim")] : []),
    row(duration + 1, "daemon.idle_starved.enter"),
  ];
}

function fixture(t: TestContext, history: Row[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}quiet-engine-backoff-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const github = ghShim([{ when: "api", stdoutEnv: "FIXTURE_BOARD" }]);
  t.after(() => rmSync(github.dir, { recursive: true, force: true }));
  const state = join(root, "state");
  const stubs = join(root, "stubs");
  mkdirSync(state);
  mkdirSync(stubs);
  const ledger = join(state, "ledger.ndjson");
  const marker = join(state, "idle-starved.marker");
  const encode = (rows: Row[]) => rows.map((r) => JSON.stringify(r) + "\n").join("");
  writeFileSync(ledger, encode(history));
  writeFileSync(marker, SINCE);
  writeFileSync(join(stubs, "git"), '#!/bin/sh\ncase "$*" in *rev-parse*) printf "%s\\n" "$FIXTURE_ENGINE";; *ls-remote*) printf "%s\\trefs/heads/main\\n" "$FIXTURE_TARGET";; *) exit 2;; esac\n', { mode: 0o755 });
  writeFileSync(join(stubs, "date"), '#!/bin/sh\ncase "$*" in +%s) printf "%s\\n" "$FIXTURE_NOW";; *) printf "%s\\n" "$FIXTURE_ISO";; esac\n', { mode: 0o755 });
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GH_APP_|GH_TOKEN$|GITHUB_TOKEN$|RMD_)/.test(key)));
  return {
    state,
    rows: () => readFileSync(ledger, "utf8").trim().split("\n").filter(Boolean).map((line): Row => JSON.parse(line)),
    append: (rows: Row[]) => appendFileSync(ledger, encode(rows)),
    rotate: (rows: Row[], compressed: boolean) => writeFileSync(join(state, compressed ? "ledger.older.ndjson.gz" : "ledger.newer.ndjson"), compressed ? gzipSync(encode(rows)) : encode(rows)),
    run: (opts: { elapsed?: number; mode?: string; target?: string; board?: string; engine?: string; baseline?: string } = {}) => {
      const now = START + (opts.elapsed ?? 0);
      const result = spawnSync("bash", [
        join(REPO_ROOT, "deploy", "idle-starved-probe.sh"), "fake/site", root, BASE,
        state, SINCE, marker, root, opts.mode ?? "full", opts.baseline ?? BASE,
      ], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...ambient, PATH: `${stubs}:${github.dir}:${process.env.PATH ?? ""}`, GH_TOKEN: "fixture",
          FIXTURE_NOW: String(now), FIXTURE_ISO: new Date(now * 1000).toISOString(),
          FIXTURE_ENGINE: opts.engine ?? HEAD, FIXTURE_TARGET: opts.target ?? BASE,
          FIXTURE_BOARD: opts.board ?? "[]",
        },
      });
      assert.equal(result.signal, null, result.stderr);
      return result;
    },
  };
}

test("W1-T9031: consecutive empty engine wakes defer the next engine wake", (t) => {
  for (const count of [1, 2, 5]) {
    const f = fixture(t, Array.from({ length: count }, (_, i) => emptyWake(START - (count - i) * 1000)).flat());
    const first = f.run();
    assert.equal(first.status, 0, first.stderr);
    const deferred = f.rows().at(-1)!;
    assert.equal(deferred.step, "daemon.idle_starved.engine_deferred");
    assert.equal(deferred.engine_head_sha, HEAD);
    assert.equal(deferred.empty_wake_run, count);
    assert.equal(deferred.deferral_s, count * 70);
    assert.equal(f.run({ elapsed: count * 70 - 1, mode: "pr-board" }).status, 0);
    const wake = f.run({ elapsed: count * 70, mode: "pr-board" });
    assert.equal(wake.status, 10, wake.stderr);
    assert.equal(f.rows().at(-1)!.step, "daemon.idle_starved.engine_wake");
    assert.equal(f.rows().at(-1)!.deferral_s, count * 70);
  }
});

test("W1-T9031: live and archive overlap preserves consecutive empty engine wakes", (t) => {
  const first = emptyWake(START - 2000);
  const second = emptyWake(START - 1000);
  const f = fixture(t, [first[1]!, ...second]);
  f.rotate(first, true);

  const deferred = f.run();
  assert.equal(deferred.status, 0, deferred.stderr);
  assert.equal(f.rows().at(-1)!.empty_wake_run, 2);
  assert.equal(f.rows().at(-1)!.deferral_s, 140);
  assert.equal(f.run({ elapsed: 139, mode: "pr-board" }).status, 0);
  const wake = f.run({ elapsed: 140, mode: "pr-board" });
  assert.equal(wake.status, 10, wake.stderr);
  assert.equal(f.rows().at(-1)!.deferral_s, 140);
});

test("W1-T9031: a target change wakes at once during an engine deferral", (t) => {
  for (const kind of ["board", "main", "approval", "kick", "inbox", "uncertain"]) {
    const f = fixture(t, [...emptyWake(START - 2000), ...emptyWake(START - 1000)]);
    assert.equal(f.run().status, 0);
    if (kind === "approval") f.append([{ ts: SINCE, step: "ratify.approved" }]);
    if (kind === "kick") writeFileSync(join(f.state, "KICK_REQUESTED-task"), "{}");
    if (kind === "inbox") writeFileSync(join(f.state, "inbox-proposals.json"), "{}");
    const wake = f.run({
      elapsed: 1, mode: kind === "board" ? "pr-board" : "full",
      board: kind === "board" ? '[{"number":1}]' : kind === "uncertain" ? "bad json" : "[]",
      target: kind === "main" ? "c".repeat(40) : BASE,
    });
    assert.equal(wake.status, kind === "uncertain" ? 2 : 10, `${kind}: ${wake.stderr}`);
    assert.equal(f.rows().filter((row) => row.step === "daemon.idle_starved.engine_wake").length, 2);
  }
});

test("W1-T9031: an engine wake that admits work resets the deferral", (t) => {
  const f = fixture(t, [...emptyWake(START - 3000), ...emptyWake(START - 2000)]);
  assert.equal(f.run().status, 0);
  assert.equal(f.rows().at(-1)!.empty_wake_run, 2);
  f.append(emptyWake(START - 1000, 70, true));
  const wake = f.run({ elapsed: 1 });
  assert.equal(wake.status, 10, wake.stderr);
  assert.equal(f.rows().at(-1)!.empty_wake_run, 0);
  assert.equal(f.rows().at(-1)!.deferral_s, 0);
  assert.equal(f.rows().at(-1)!.reason, "engine_revision_changed");
});

test("W1-T9031: rotation forms and changing revisions preserve the pending boundary", (t) => {
  const f = fixture(t, []);
  const first = emptyWake(START - 2000, 90);
  f.rotate(first.slice(0, 2), true);
  f.rotate([...first.slice(2), ...emptyWake(START - 1000, 110)], false);
  assert.equal(f.run().status, 0);
  assert.equal(f.rows().at(-1)!.deferral_s, 200);
  assert.equal(f.rows().at(-1)!.empty_wake_run, 2);
  const newest = "c".repeat(40);
  assert.equal(f.run({ elapsed: 199, engine: newest }).status, 0);
  assert.equal(f.rows().at(-1)!.engine_head_sha, newest);
  assert.equal(f.run({ elapsed: 200, engine: newest }).status, 10);
  assert.equal(f.rows().at(-1)!.engine_head_sha, newest);
  assert.equal(f.rows().at(-1)!.deferral_s, 200);
});

test("W1-T9031: a reverted pending engine still wakes and uncertainty bypasses backoff", (t) => {
  for (const kind of ["revert", "baseline", "head", "history"]) {
    const f = fixture(t, emptyWake(START - 1000));
    assert.equal(f.run().status, 0);
    if (kind === "history") f.rotate([{ ts: "unreadable", step: "daemon.boot" }], false);
    const wake = f.run({ elapsed: 70, engine: kind === "head" ? "unknown" : kind === "revert" ? BASE : HEAD, baseline: kind === "baseline" ? "unknown" : BASE });
    assert.equal(wake.status, kind === "revert" ? 10 : 2, `${kind}: ${wake.stderr}`);
    if (kind === "revert") assert.equal(f.rows().at(-1)!.deferral_s, 70);
  }
});
