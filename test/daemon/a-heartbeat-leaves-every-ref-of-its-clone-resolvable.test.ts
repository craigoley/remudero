// W1-T13327: a beat leaves every ref of the clone it runs from resolvable.
// The real script runs with real git: an install clone whose remote `origin` is a local bare
// repository. A `git` wrapper on PATH records each call, the payload the beat hashes, and what
// credential.helper resolves to in the environment of the push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installFixtureDuGuard } from "#test/helpers/fixture-du.js";
import { GIT_REPO_FIXTURE_IDENTITY, gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

const TOKEN = "fixture-token-value-ZYXWVUTSRQ9876543210";
const BRANCH = "heartbeat-fixture";
const TRACKING_REF = `refs/remotes/origin/${BRANCH}`;
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
  home: string;
  binDir: string;
  rec: string;
  bare: GitRepo;
  install: GitRepo;
  script: string;
  cleanup: () => void;
}

/** Real git behind a recorder. `hash-object --stdin` keeps a copy of the payload. `push` records the
 *  credential helpers git resolves in the push's own environment and runs the last one once. */
function wrapperSource(): string {
  return [
    "#!/usr/bin/env bash",
    `REAL=${JSON.stringify(REAL_GIT)}`,
    'printf "git" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'args=("$@"); i=0',
    'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
    'case "${args[$i]}" in',
    "  hash-object)",
    '    case " $* " in *" --stdin "*) tee "$STUB_REC/payload" | "$REAL" "$@"; exit $? ;; esac ;;',
    "  push)",
    '    "$REAL" "${args[@]:0:$i}" config --get-all credential.helper > "$STUB_REC/push-helper" 2>/dev/null || echo NO-HELPER > "$STUB_REC/push-helper"',
    '    h="$(tail -n 1 "$STUB_REC/push-helper")"',
    '    case "$h" in "!"*) printf "protocol=https\\nhost=github.com\\n\\n" | sh -c "${h#!} get" > "$STUB_REC/push-helper-out" 2>&1 || true ;; esac ;;',
    "esac",
    'exec "$REAL" "$@"',
    "",
  ].join("\n");
}

function fixture(): Fx {
  const dir = mkdtempSync(join(tmpdir(), "rmd-hbrefs-"));
  const rmdRoot = join(dir, "root");
  const home = join(dir, "home");
  const binDir = join(dir, "stubbin");
  const rec = join(dir, "rec");
  for (const d of [join(rmdRoot, "state"), home, binDir, rec]) mkdirSync(d, { recursive: true });
  installFixtureDuGuard(binDir, [dir]);
  // Beat 1 of every 1000 walks no consumer, so each run publishes one beat.
  writeFileSync(join(rmdRoot, "state", "heartbeat-count.txt"), "1\n");
  writeFileSync(join(binDir, "git"), wrapperSource(), { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);

  const bare = gitRepo({ bare: true, kind: "hbrefs-remote" });
  const install = gitRepo({ kind: "hbrefs-install" });
  mkdirSync(join(install.dir, "scripts"), { recursive: true });
  const script = join(install.dir, SCRIPT_REL);
  copyFileSync(join(REPO_ROOT, SCRIPT_REL), script);
  chmodSync(script, 0o755);
  install.git("add", SCRIPT_REL);
  install.git("commit", "--quiet", "-m", "the install carries the beat");
  install.addRemote("origin", bare.dir);
  // The remote has another branch, and the clone tracks it, as a real install tracks main.
  install.git("push", "--quiet", "origin", "main");
  install.git("fetch", "--quiet", "origin");
  const cleanup = (): void => {
    for (const d of [dir, bare.dir, install.dir]) rmSync(d, { recursive: true, force: true });
  };
  return { dir, rmdRoot, home, binDir, rec, bare, install, script, cleanup };
}

function beat(f: Fx) {
  return spawnSync("bash", [f.script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${f.binDir}:${process.env.PATH ?? ""}`,
      HOME: f.home,
      RMD_ROOT: f.rmdRoot,
      RMD_HEARTBEAT_BRANCH: BRANCH,
      RMD_HEARTBEAT_DOCKER: join(f.binDir, "no-such-runtime"),
      RMD_CONSUMER_EVERY: "1000",
      STUB_REC: f.rec,
      GH_TOKEN: TOKEN,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function publish(f: Fx): string {
  const r = beat(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return f.bare.git("rev-parse", `refs/heads/${BRANCH}`);
}

const git = (dir: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  spawnSync(REAL_GIT, ["-C", dir, ...args], { encoding: "utf8", input, env: { ...process.env, ...IDENTITY_ENV, ...env } });

const recorded = (f: Fx, name: string): string => (existsSync(join(f.rec, name)) ? readFileSync(join(f.rec, name), "utf8") : "");

/** Every ref of the clone, as `git for-each-ref` lists it. */
function refs(r: GitRepo): { name: string; id: string }[] {
  const listing = git(r.dir, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  assert.equal(listing.status, 0, `for-each-ref must list the clone's refs: ${listing.stderr}`);
  return listing.stdout.split("\n").filter(Boolean).map((l) => {
    const [name, id] = l.split(" ");
    return { name, id };
  });
}

/** The refs whose object the clone's own object store does not hold. */
const unresolved = (r: GitRepo): string[] =>
  refs(r).filter((ref) => git(r.dir, ["cat-file", "-e", ref.id]).status !== 0).map((ref) => `${ref.name} -> ${ref.id}`);

/** Another clone moves main on the remote, so the next fetch of main has a commit to download. */
function advanceRemoteMain(f: Fx): void {
  const writer = gitRepo({ cloneFrom: f.bare.dir, kind: "hbrefs-writer" });
  writer.git("commit", "--quiet", "--allow-empty", "-m", "main moves on the remote");
  writer.git("push", "--quiet", "origin", "main");
  writer.cleanup();
}

const fetchMain = (f: Fx) => git(f.install.dir, ["fetch", "origin", "main"]);
const looseCount = (r: GitRepo): number => Number(/^count: (\d+)$/m.exec(r.git("count-objects", "-v"))?.[1]);
const beatStores = (f: Fx): string[] => readdirSync(join(f.rmdRoot, "state")).filter((n) => n.startsWith(".beat-objects."));

/** Point the beat's tracking ref at a commit that only a removed object directory held. */
function danglingTrackingRef(f: Fx): string {
  const store = join(f.dir, "removed-objects");
  mkdirSync(store);
  const env = { GIT_OBJECT_DIRECTORY: store };
  const blob = git(f.install.dir, ["hash-object", "-w", "--stdin"], env, "a beat from before the fix\n").stdout.trim();
  const tree = git(f.install.dir, ["mktree"], env, `100644 blob ${blob}\theartbeat.txt\n`).stdout.trim();
  const commit = git(f.install.dir, ["commit-tree", tree, "-m", "an old beat"], env).stdout.trim();
  assert.match(commit, /^[0-9a-f]{40,64}$/, "fixture sanity: the removed store built a commit");
  const set = git(f.install.dir, ["update-ref", TRACKING_REF, commit], env);
  assert.equal(set.status, 0, set.stderr);
  rmSync(store, { recursive: true, force: true });
  return commit;
}

test("W1-T13327 criterion 1: invariant:every-ref-resolves — after one beat every ref of the install clone names an object the clone has, and a fetch of another branch ends with status 0", () => {
  const f = fixture();
  try {
    const tip = publish(f);
    assert.match(tip, /^[0-9a-f]{40,64}$/, "the beat reached the bare remote");

    const names = refs(f.install).map((r) => r.name);
    assert.ok(names.includes("refs/heads/main") && names.includes("refs/remotes/origin/main"), `the clone has refs to check: ${names.join(", ")}`);
    const missing = unresolved(f.install);
    assert.equal(missing.length, 0, `every ref must name an object the clone has, these do not: ${missing.join("; ")}`);

    advanceRemoteMain(f);
    const fetched = fetchMain(f);
    assert.equal(fetched.status, 0, `git fetch origin main must succeed after a beat: ${fetched.stderr}`);
    assert.equal(f.install.git("rev-parse", "refs/remotes/origin/main"), f.bare.git("rev-parse", "refs/heads/main"), "the fetch brought the remote's new main");
    assert.equal(unresolved(f.install).length, 0, "every ref still resolves after the fetch");
  } finally {
    f.cleanup();
  }
});

test("W1-T13327 criterion 2: the beat reaches the bare remote as one parentless commit that carries the payload, and the push resolves the GH_TOKEN helper for that push only", () => {
  const f = fixture();
  try {
    const tip = publish(f);

    assert.equal(f.bare.git("rev-list", "--count", `refs/heads/${BRANCH}`), "1", "the beat's branch is one commit");
    assert.equal(f.bare.git("rev-list", "--parents", "-1", tip), tip, "the beat commit has no parent");
    const payload = recorded(f, "payload");
    assert.match(payload, /^beat_host=/m, "fixture sanity: the wrapper kept the payload the beat built");
    assert.equal(f.bare.git("show", `${BRANCH}:heartbeat.txt`), payload.trim(), "heartbeat.txt on the remote is the payload the beat built");
    assert.equal(f.bare.git("ls-tree", "--name-only", tip), "heartbeat.txt", "the commit carries that one file");

    const helper = recorded(f, "push-helper").trim();
    assert.match(helper, /^!/, `the push resolves a command helper, got: ${helper}`);
    assert.ok(helper.includes("$GH_TOKEN"), "the helper reads the token from its environment");
    assert.ok(!helper.includes(TOKEN), "the helper text never carries the token value");
    assert.match(recorded(f, "push-helper-out"), new RegExp(`password=${TOKEN}`), "run as git runs it, the helper answers with the token");
    assert.ok(!recorded(f, "calls").includes(TOKEN), "the token is in no git argv");
    assert.ok(!payload.includes(TOKEN), "the token is not in the payload");
    // For that push only: the clone's own configuration gained no helper.
    const kept = git(f.install.dir, ["config", "--get-all", "credential.helper"], { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
    assert.equal(kept.status, 1, `the install's configuration has no credential helper after the beat: ${kept.stdout}`);
  } finally {
    f.cleanup();
  }
});

test("W1-T13327 criterion 3: a clone whose tracking ref names an object it lacks heals on the next beat, and a tracking ref that resolves is left unchanged", () => {
  const f = fixture();
  try {
    const gone = danglingTrackingRef(f);
    advanceRemoteMain(f);
    const before = unresolved(f.install);
    assert.equal(before.length, 1, `fixture sanity: exactly the beat's tracking ref dangles: ${before.join("; ")}`);
    assert.equal(before[0], `${TRACKING_REF} -> ${gone}`);
    assert.notEqual(fetchMain(f).status, 0, "fixture sanity: the dangling ref makes a fetch of main fail");

    const first = publish(f);
    const after = unresolved(f.install);
    assert.equal(after.length, 0, `one beat leaves every ref resolvable, these are not: ${after.join("; ")}`);
    const fetched = fetchMain(f);
    assert.equal(fetched.status, 0, `git fetch origin main must succeed after the healing beat: ${fetched.stderr}`);
    assert.equal(f.install.git("rev-parse", "refs/remotes/origin/main"), f.bare.git("rev-parse", "refs/heads/main"));

    // A tracking ref that resolves: a fetch of the beat's branch writes it, as the gardener's does.
    f.install.git("fetch", "--quiet", "origin", `+refs/heads/${BRANCH}:${TRACKING_REF}`);
    assert.equal(f.install.git("rev-parse", TRACKING_REF), first, "fixture sanity: the tracking ref names the first beat, which the clone now has");
    const second = publish(f);
    assert.notEqual(second, first, "the next beat reached the remote");
    assert.equal(f.install.git("rev-parse", TRACKING_REF), first, "a tracking ref that resolves is left unchanged");
    assert.equal(unresolved(f.install).length, 0, "every ref still resolves");
  } finally {
    f.cleanup();
  }
});

test("W1-T13327 criterion 4: invariant:beat-objects-stay-out-of-the-clone — two beats add no loose object and no beat commit to the clone, and leave no .beat-objects directory", () => {
  const f = fixture();
  try {
    const looseBefore = looseCount(f.install);
    const first = publish(f);
    const second = publish(f);
    assert.notEqual(second, first, "the remote received both beats");

    assert.equal(looseCount(f.install), looseBefore, "the clone gained no loose object");
    for (const tip of [first, second]) {
      assert.notEqual(git(f.install.dir, ["cat-file", "-e", tip]).status, 0, `beat commit ${tip} must not be in the clone's own object store`);
    }
    assert.equal(beatStores(f).length, 0, `no private object store is left under the state directory: ${beatStores(f).join(", ")}`);
    assert.equal(f.install.git("status", "--porcelain"), "", "the clone's working tree is untouched");
  } finally {
    f.cleanup();
  }
});
