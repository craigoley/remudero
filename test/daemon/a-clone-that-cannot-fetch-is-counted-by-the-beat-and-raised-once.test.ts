// W1-T13410: a clone that cannot fetch is counted by the beat and raised once.
// Criteria 1 and 2 run the real script with real git: an install clone whose remote `origin` is a
// local bare repository. Criteria 3 to 6 drive the gardener pass with fixture beats.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixedClock } from "#src/lib/clock.js";
import type { Escalation } from "#src/lib/escalate.js";
import { CLONE_GC_RAISE_AFTER_MS, runHostResourcePass, type HostResourcePorts } from "#src/lib/host-resource-gardener.js";
import { meaningOfStep } from "#src/lib/ledger-steps.js";
import { installFixtureDuGuard } from "#test/helpers/fixture-du.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const BRANCH = "heartbeat-fixture";
const SCRIPT_REL = "scripts/fleet-heartbeat.sh";
const REAL_GIT = String(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout).trim();
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
  GIT_COMMITTER_NAME: GIT_REPO_FIXTURE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: GIT_REPO_FIXTURE_IDENTITY.email,
};

interface Fx {
  dir: string;
  rmdRoot: string;
  binDir: string;
  bare: GitRepo;
  install: GitRepo;
  script: string;
  cleanup: () => void;
}

function fixture(): Fx {
  const dir = mkdtempSync(join(tmpdir(), "rmd-hbclone-"));
  const rmdRoot = join(dir, "root");
  const binDir = join(dir, "stubbin");
  for (const d of [join(rmdRoot, "state"), join(dir, "home"), join(dir, "tmp"), binDir]) mkdirSync(d, { recursive: true });
  installFixtureDuGuard(binDir, [dir]);
  // Beat 1 of every 1000 walks no consumer, so each run publishes one beat.
  writeFileSync(join(rmdRoot, "state", "heartbeat-count.txt"), "1\n");

  const bare = gitRepo({ bare: true, kind: "hbclone-remote" });
  const install = gitRepo({ kind: "hbclone-install" });
  mkdirSync(join(install.dir, "scripts"), { recursive: true });
  const script = join(install.dir, SCRIPT_REL);
  copyFileSync(join(REPO_ROOT, SCRIPT_REL), script);
  chmodSync(script, 0o755);
  install.git("add", SCRIPT_REL);
  install.git("commit", "--quiet", "-m", "the install carries the beat");
  install.addRemote("origin", bare.dir);
  install.git("push", "--quiet", "origin", "main");
  install.git("fetch", "--quiet", "origin");
  const cleanup = (): void => {
    for (const d of [dir, bare.dir, install.dir]) rmSync(d, { recursive: true, force: true });
  };
  return { dir, rmdRoot, binDir, bare, install, script, cleanup };
}

function beat(f: Fx, env: Record<string, string> = {}) {
  return spawnSync("bash", [f.script], {
    encoding: "utf8",
    // A backstop for the suite only: a beat that never ends fails here instead of hanging the file.
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${f.binDir}:${process.env.PATH ?? ""}`,
      HOME: join(f.dir, "home"),
      TMPDIR: join(f.dir, "tmp"),
      RMD_ROOT: f.rmdRoot,
      RMD_HEARTBEAT_BRANCH: BRANCH,
      RMD_HEARTBEAT_DOCKER: join(f.binDir, "no-such-runtime"),
      RMD_HEARTBEAT_CONTAINER: "none",
      RMD_CONSUMER_EVERY: "1000",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      ...env,
    },
  });
}

const field = (payload: string, key: string): string | undefined => {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
};

const git = (dir: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync(REAL_GIT, ["-C", dir, ...args], { encoding: "utf8", input, env: { ...process.env, ...IDENTITY_ENV, ...env } });

const refListing = (r: GitRepo): string => git(r.dir, ["for-each-ref", "--format=%(objectname) %(refname)"]).stdout;

/** Point each ref at a commit that only a removed object directory held. */
function danglingRefs(f: Fx, names: string[]): string {
  const store = join(f.dir, "removed-objects");
  mkdirSync(store);
  const env = { GIT_OBJECT_DIRECTORY: store };
  const blob = git(f.install.dir, ["hash-object", "-w", "--stdin"], env, "a lost object\n").stdout.trim();
  const tree = git(f.install.dir, ["mktree"], env, `100644 blob ${blob}\tlost.txt\n`).stdout.trim();
  const commit = git(f.install.dir, ["commit-tree", tree, "-m", "lost"], env).stdout.trim();
  assert.match(commit, /^[0-9a-f]{40,64}$/, "fixture sanity: the removed store built a commit");
  for (const name of names) assert.equal(git(f.install.dir, ["update-ref", name, commit], env).status, 0);
  rmSync(store, { recursive: true, force: true });
  return commit;
}

test("W1-T13410 criterion 1: invariant:the-count-is-read-not-constant — a clone whose refs resolve publishes 0 and none, two refs naming a missing id publish 2 and the first ref, and the probe changes no ref", () => {
  const f = fixture();
  try {
    const clean = beat(f, { RMD_HEARTBEAT_DRY_RUN: "1" });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(field(clean.stdout, "unresolvable_refs"), "0", "every ref resolves");
    assert.equal(field(clean.stdout, "unresolvable_ref_first"), "none");

    danglingRefs(f, ["refs/remotes/origin/lost-b", "refs/heads/lost-a"]);
    const before = refListing(f.install);
    assert.match(before, /refs\/heads\/lost-a/, "fixture sanity: for-each-ref lists the dangling refs");
    const dangling = beat(f, { RMD_HEARTBEAT_DRY_RUN: "1" });
    assert.equal(dangling.status, 0, dangling.stderr);
    assert.equal(field(dangling.stdout, "unresolvable_refs"), "2");
    assert.equal(field(dangling.stdout, "unresolvable_ref_first"), "refs/heads/lost-a", "the first such ref in for-each-ref order");
    assert.equal(refListing(f.install), before, "the probe changes no ref");
  } finally {
    f.cleanup();
  }
});

test("W1-T13410 criterion 2: invariant:the-count-is-bounded — a cat-file that does not end inside the BACKSTOP is stopped, the beat publishes unknown and its other fields", () => {
  const f = fixture();
  const pidFile = join(f.dir, "sleeper.pid");
  try {
    writeFileSync(join(f.binDir, "git"), [
      "#!/usr/bin/env bash",
      `case " $* " in *" cat-file --batch-check "*) echo $$ > ${JSON.stringify(pidFile)}; exec sleep 300 ;; esac`,
      `exec ${JSON.stringify(REAL_GIT)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    danglingRefs(f, ["refs/heads/lost-a"]);
    const r = beat(f, { RMD_HEARTBEAT_REFS_BACKSTOP_S: "1", GH_TOKEN: "fixture-token" });
    assert.equal(r.signal, null, `the beat ended by itself: ${r.stderr}`);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(pidFile), "fixture sanity: the probe reached the sleeping cat-file");

    const published = f.bare.git("show", `${BRANCH}:heartbeat.txt`);
    assert.equal(field(published, "unresolvable_refs"), "unknown", "a probe that did not finish is unknown, never 0");
    assert.equal(field(published, "unresolvable_ref_first"), "none");
    for (const key of ["beat_ts", "beat_host", "gc_verdict", "install_dir", "daemon_verdict"]) {
      assert.notEqual(field(published, key), undefined, `the beat still publishes ${key}`);
    }
  } finally {
    if (existsSync(pidFile)) spawnSync("kill", [readFileSync(pidFile, "utf8").trim()]);
    f.cleanup();
  }
});

const HOST = "azure";
const INSTALL = "/home/fleet/daemon-install";

function garden(t: TestContext) {
  const stateDir = mkdtempSync(join(tmpdir(), "rmd-hbclone-garden-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const escalations: Escalation[] = [];
  const rows: Array<{ step: string; extra?: Record<string, unknown> }> = [];
  let beats: Array<{ host: string; payload: string }> = [];
  const ports: HostResourcePorts = {
    stateDir,
    clock: fixedClock(Date.parse("2026-11-17T16:00:00Z")),
    log: (step, extra) => rows.push({ step, extra }),
    readHeartbeats: () => beats,
    planOrigins: () => [],
    escalate: (e) => {
      escalations.push(e);
      return `https://issue/${escalations.length}`;
    },
  };
  const pass = (...lines: Array<Record<string, string>>): void => {
    beats = lines.map((l) => ({ host: l["host"] ?? HOST, payload: Object.entries({ install_dir: INSTALL, ...l }).filter(([k]) => k !== "host").map(([k, v]) => `${k}=${v}`).join("\n") }));
    runHostResourcePass(ports);
  };
  const count = (step: string): number => rows.filter((r) => r.step === step).length;
  return { stateDir, escalations, rows, pass, count };
}

const at = (minutes: number): string => new Date(Date.parse("2026-11-17T14:00:00Z") + minutes * 60_000).toISOString();

test("W1-T13410 criterion 3: invariant:one-incident-per-episode — a count above zero raises once per host and episode, 0 ends it, unknown and a missing field do neither", (t) => {
  const g = garden(t);
  const refs = (minutes: number, n: string) => ({ beat_ts: at(minutes), unresolvable_refs: n, unresolvable_ref_first: "refs/remotes/origin/heartbeat-azure" });
  g.pass(refs(0, "1"));
  g.pass(refs(0, "1"));
  g.pass(refs(5, "2"));
  assert.equal(g.escalations.length, 1, "one escalation for the episode");
  assert.equal(g.escalations[0]!.taskId, `host-clone-refs-${HOST}`);
  assert.equal(g.escalations[0]!.class, "MANUAL");
  assert.equal(g.escalations[0]!.headDedup, "independent");
  assert.deepEqual(g.escalations[0]!.options.map((o) => o.kind?.type), ["operator-only"]);
  assert.equal(g.count("host_resource.clone_refs_unresolvable"), 1);

  g.pass(refs(10, "unknown"));
  g.pass({ beat_ts: at(15) });
  g.pass(refs(20, "3"));
  assert.equal(g.escalations.length, 1, "unknown and a missing field do not end the episode");
  assert.equal(g.count("host_resource.clone_refs_recovered"), 0);

  g.pass(refs(25, "0"));
  g.pass(refs(30, "0"));
  assert.equal(g.count("host_resource.clone_refs_recovered"), 1, "the first count of 0 ends the episode once");
  g.pass(refs(20, "4"));
  assert.equal(g.escalations.length, 1, "an older beat cannot open an episode");
  g.pass(refs(35, "1"));
  assert.equal(g.escalations.length, 2, "a later count above zero raises again");
  g.pass({ host: "mini", ...refs(35, "1") });
  assert.equal(g.escalations.length, 3, "episodes belong to each host");
  assert.equal(g.count("host_resource.clone_refs_unresolvable"), 3);

  // An old state file with no clone key loads and keeps its other episodes.
  const g2 = garden(t);
  writeFileSync(join(g2.stateDir, "host-resource-state.json"), JSON.stringify({ episodes: {}, filed: {}, acrLogin: {}, stateBackup: {} }));
  g2.pass(refs(0, "1"));
  assert.equal(g2.escalations.length, 1);
  // An unreadable state file starts every episode again.
  const g3 = garden(t);
  writeFileSync(join(g3.stateDir, "host-resource-state.json"), "{ not json");
  g3.pass(refs(0, "1"));
  assert.equal(g3.escalations.length, 1);
});

test("W1-T13410 criterion 4: the escalation names the host, the install dir, the count, the first ref and the refetch command, and says not to delete other refs without a look", (t) => {
  const g = garden(t);
  g.pass({ beat_ts: at(0), unresolvable_refs: "2", unresolvable_ref_first: "refs/remotes/origin/heartbeat-azure" });
  const detail = g.escalations[0]!.detail;
  for (const part of [HOST, INSTALL, "2 refs", "refs/remotes/origin/heartbeat-azure"]) assert.ok(detail.includes(part), `the text names ${part}: ${detail}`);
  assert.ok(
    detail.includes(`git -C ${INSTALL} -c gc.auto=0 -c maintenance.auto=false fetch --refetch --no-tags origin '+refs/heads/heartbeat-azure:refs/remotes/origin/heartbeat-azure'`),
    detail,
  );
  assert.match(detail, /Do not delete a local branch, a tag or a refs\/rmd-dispatch ref without a look/);

  const other = garden(t);
  other.pass({ beat_ts: at(0), unresolvable_refs: "1", unresolvable_ref_first: "refs/rmd-dispatch/W1-T1" });
  const text = other.escalations[0]!.detail;
  assert.ok(!text.includes("fetch --refetch"), "no refetch command for a ref that is not a tracking ref");
  assert.match(text, /Look at refs\/rmd-dispatch\/W1-T1 first.*do not delete it/);
});

test("W1-T13410 criterion 5: invariant:a-gc-log-that-stays-is-raised-once — the same reason across the set time raises once, a changed reason starts the time again, ok ends the episode", (t) => {
  const g = garden(t);
  const step = CLONE_GC_RAISE_AFTER_MS / 60_000;
  const reasonA = "fatal: bad object refs/remotes/origin/heartbeat-azure";
  const gc = (minutes: number, reason: string) => ({ beat_ts: at(minutes), gc_verdict: "DISABLED — .git/gc.log is present, automatic gc will not run until it is removed", gc_disabled_reason: reason });
  g.pass(gc(0, reasonA));
  g.pass(gc(step - 5, reasonA));
  assert.equal(g.escalations.length, 0, "no raise before the set time");
  g.pass(gc(step - 1, "error: another reason"));
  g.pass(gc(step + 5, "error: another reason"));
  assert.equal(g.escalations.length, 0, "a changed reason starts the time again");
  g.pass(gc(2 * step - 1, "error: another reason"));
  assert.equal(g.escalations.length, 1, "the same reason across the set time raises");
  g.pass(gc(2 * step + 30, "error: another reason"));
  assert.equal(g.escalations.length, 1, "once per episode");
  const e = g.escalations[0]!;
  assert.equal(e.taskId, `host-clone-gc-${HOST}`);
  assert.ok(e.detail.includes("error: another reason"), "the text carries git's own first line");
  assert.ok(e.detail.includes(`rm ${INSTALL}/.git/gc.log`), "and the command that removes the file");
  assert.equal(g.count("host_resource.clone_gc_disabled"), 1);

  g.pass({ beat_ts: at(3 * step + 1), gc_verdict: "ok", gc_disabled_reason: "none" });
  assert.equal(g.count("host_resource.clone_gc_recovered"), 1);
  g.pass(gc(3 * step + 5, reasonA));
  g.pass(gc(4 * step + 5, reasonA));
  assert.equal(g.escalations.length, 2, "a new episode raises again");
});

test("W1-T13410 criterion 6: meaningOfStep returns a row for each of the four new host_resource steps", () => {
  for (const step of ["clone_refs_unresolvable", "clone_refs_recovered", "clone_gc_disabled", "clone_gc_recovered"]) {
    const row = meaningOfStep(`host_resource.${step}`);
    assert.ok(row, `host_resource.${step} is registered`);
    assert.deepEqual(row.writer, ["observeCloneHealth"]);
  }
});
