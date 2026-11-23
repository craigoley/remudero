import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { RMD_TMP_PREFIX } from "#src/lib/tmp.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const SINCE = "2026-11-23T12:00:00.000Z";
const START = Date.parse(SINCE) / 1000;
const DAY = 86_400;
type Row = Record<string, unknown>;

/** One engine wake that booted at `at` and went back to quiet mode 70 s later without work. */
function emptyWake(at: number): Row[] {
  const row = (offset: number, step: string) => ({ ts: new Date((at + offset) * 1000).toISOString(), step });
  return [{ ...row(-1, "daemon.idle_starved.engine_wake"), reason: "engine_revision_changed" }, row(0, "daemon.boot"), row(70, "daemon.idle_starved.enter")];
}

function probe(t: TestContext, history: Row[]) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}idle-engine-day-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const github = ghShim([{ when: "api", stdoutEnv: "FIXTURE_BOARD" }]);
  t.after(() => rmSync(github.dir, { recursive: true, force: true }));
  const state = join(root, "state");
  const stubs = join(root, "stubs");
  mkdirSync(state);
  mkdirSync(stubs);
  const ledger = join(state, "ledger.ndjson");
  const marker = join(state, "idle-starved.marker");
  writeFileSync(ledger, history.map((r) => JSON.stringify(r) + "\n").join(""));
  writeFileSync(marker, SINCE);
  writeFileSync(join(stubs, "git"), '#!/bin/sh\ncase "$*" in *rev-parse*) printf "%s\\n" "$FIXTURE_ENGINE";; *ls-remote*) printf "%s\\trefs/heads/main\\n" "$FIXTURE_TARGET";; *) exit 2;; esac\n', { mode: 0o755 });
  writeFileSync(join(stubs, "date"), '#!/bin/sh\ncase "$*" in +%s) printf "%s\\n" "$FIXTURE_NOW";; *) printf "%s\\n" "$FIXTURE_ISO";; esac\n', { mode: 0o755 });
  const ambient = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GH_APP_|GH_TOKEN$|GITHUB_TOKEN$|RMD_)/.test(key)));
  return {
    last: (): Row => JSON.parse(readFileSync(ledger, "utf8").trim().split("\n").at(-1)!),
    run: (elapsed: number, board = "[]") => {
      const now = START + elapsed;
      const result = spawnSync("bash", [join(REPO_ROOT, "deploy", "idle-starved-probe.sh"), "fake/arcade", root, BASE, state, SINCE, marker, root, "pr-board", BASE], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...ambient, PATH: `${stubs}:${github.dir}:${process.env.PATH ?? ""}`, GH_TOKEN: "fixture",
          FIXTURE_NOW: String(now), FIXTURE_ISO: new Date(now * 1000).toISOString(),
          FIXTURE_ENGINE: HEAD, FIXTURE_TARGET: BASE, FIXTURE_BOARD: board,
        },
      });
      assert.equal(result.signal, null, result.stderr);
      return result;
    },
  };
}

test("W1-T14550: an engine change inside a day of the last boot defers", (t) => {
  const p = probe(t, emptyWake(START - 1000));
  // The learned back-off (70 s) has long passed; only the day keeps the daemon quiet.
  for (const elapsed of [0, 3_600, DAY - 1000 - 1]) {
    const result = p.run(elapsed);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(p.last().step, "daemon.idle_starved.engine_deferred");
  }
});

test("W1-T14550: an engine change a day after the last boot wakes", (t) => {
  const p = probe(t, emptyWake(START - 1000));
  assert.equal(p.run(0).status, 0);
  // One second short of the day still defers; the wake comes at the day, not at the learned 70 s.
  assert.equal(p.run(DAY - 1000 - 1).status, 0);
  assert.equal(p.last().step, "daemon.idle_starved.engine_deferred");
  const wake = p.run(DAY - 1000);
  assert.equal(wake.status, 10, wake.stderr);
  assert.equal(p.last().step, "daemon.idle_starved.engine_wake");
  assert.equal(p.last().reason, "engine_revision_changed");
});

test("W1-T14550: an open PR wakes inside the engine day", (t) => {
  const p = probe(t, emptyWake(START - 1000));
  assert.equal(p.run(0).status, 0);
  // An hour in, past the learned back-off: the engine change stays deferred, and the open PR is the wake.
  const wake = p.run(3_600, '[{"number":125}]');
  assert.equal(wake.status, 10, wake.stderr);
  assert.equal(p.last().step, "daemon.idle_starved.engine_deferred");
});
