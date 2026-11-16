// W1-T10756: the beat runs correctly from the converged install, and a beat running other code says so.
// Unlike the stub-git suites, this drives the REAL committed script against REAL git: an install
// fixture with no credential helper whose remote is a local bare repo, reached through a `git` wrapper
// on PATH that records every call and, for the push, what credential.helper resolves to in the push's
// own environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installFixtureDuGuard } from "#test/helpers/fixture-du.js";
import { REAL_SCRIPT } from "#test/helpers/fleet-heartbeat-harness.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";

const TOKEN = "ghs_FIXTURE0TOKEN0VALUE0ABCDEFGHIJKLMNOP";
const BRANCH = "heartbeat-fixture";
const SCRIPT_REL = "scripts/fleet-heartbeat.sh";
const REAL_GIT = String(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout).trim();

interface Fx {
  dir: string;
  rmdRoot: string;
  home: string;
  binDir: string;
  rec: string;
  bare: GitRepo;
  install: GitRepo;
  cleanup: () => void;
}

/** The wrapper records argv, and on `push` asks the real git what credential.helper resolves to in the
 *  push's own environment (GIT_CONFIG_* included) and runs that helper once, as git would. */
function wrapperSource(): string {
  return [
    "#!/usr/bin/env bash",
    `REAL=${JSON.stringify(REAL_GIT)}`,
    'printf "git" >> "$STUB_REC/calls"; for a in "$@"; do printf "\\t%s" "$a" >> "$STUB_REC/calls"; done; printf "\\n" >> "$STUB_REC/calls"',
    'args=("$@"); i=0',
    'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
    'if [ "${args[$i]}" = push ]; then',
    '  lead=("${args[@]:0:$i}")',
    '  "$REAL" "${lead[@]}" config --get-all credential.helper > "$STUB_REC/push-helper" 2>&1 || echo "NO-HELPER" > "$STUB_REC/push-helper"',
    '  h="$(head -n 1 "$STUB_REC/push-helper")"',
    '  case "$h" in',
    '    "!"*) printf "protocol=https\\nhost=github.com\\n\\n" | sh -c "${h#!} get" > "$STUB_REC/push-helper-out" 2>&1 || true ;;',
    "  esac",
    "fi",
    'exec "$REAL" "$@"',
    "",
  ].join("\n");
}

function fixture(): Fx {
  const dir = mkdtempSync(join(tmpdir(), "rmd-hbcode-"));
  const rmdRoot = join(dir, "root");
  const home = join(dir, "home");
  const binDir = join(dir, "stubbin");
  const rec = join(dir, "rec");
  for (const d of [join(rmdRoot, "state"), home, binDir, rec]) mkdirSync(d, { recursive: true });
  installFixtureDuGuard(binDir, [dir]);
  // Beat 1 of every 1000: no consumer walk, so the beat publishes once and the suite stays fast.
  writeFileSync(join(rmdRoot, "state", "heartbeat-count.txt"), "1\n");
  writeFileSync(join(binDir, "git"), wrapperSource(), { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);

  const bare = gitRepo({ bare: true, kind: "hbcode-remote" });
  const install = gitRepo({ kind: "hbcode-install" });
  mkdirSync(join(install.dir, "scripts"), { recursive: true });
  writeFileSync(join(install.dir, SCRIPT_REL), readFileSync(REAL_SCRIPT), { mode: 0o755 });
  install.git("add", SCRIPT_REL);
  install.git("commit", "--quiet", "-m", "the converged install carries the beat");
  install.addRemote("origin", bare.dir);
  return { dir, rmdRoot, home, binDir, rec, bare, install, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function beat(f: Fx, script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [script], {
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
      ...env,
    },
  });
}

const recorded = (f: Fx, name: string): string => (existsSync(join(f.rec, name)) ? readFileSync(join(f.rec, name), "utf8") : "");
const calls = (f: Fx): string[][] => recorded(f, "calls").split("\n").filter(Boolean).map((l) => l.split("\t").slice(1));
const subOf = (argv: string[]): string => {
  let i = 0;
  while (argv[i] === "-C") i += 2;
  return argv[i] ?? "";
};
const looseCount = (r: GitRepo): number => Number(/^count: (\d+)$/m.exec(r.git("count-objects", "-v"))?.[1]);
const published = (f: Fx): string => f.bare.git("show", `${BRANCH}:heartbeat.txt`);
const field = (payload: string, key: string): string | undefined => {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
};

test("W1-T10756: a beat pushes from the install and leaves no objects in it", () => {
  const f = fixture();
  try {
    // The fixture really has no credential helper to fall back on.
    const bare = spawnSync(REAL_GIT, ["-C", f.install.dir, "config", "--get", "credential.helper"], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    assert.equal(bare.status, 1, "fixture sanity: the install has no credential helper");

    const script = join(f.install.dir, SCRIPT_REL);
    const looseBefore = looseCount(f.install);

    // CREDENTIAL: the push resolves a helper that reads GH_TOKEN, and the token is in no argv or payload.
    const first = beat(f, script);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const pushes = calls(f).filter((c) => subOf(c) === "push");
    assert.equal(pushes.length, 1, "one push per beat");
    const helper = recorded(f, "push-helper");
    assert.match(helper, /^!/, `the push resolves a command helper, got: ${helper}`);
    assert.ok(helper.includes("$GH_TOKEN"), "the helper reads the token from its environment");
    assert.ok(!helper.includes(TOKEN), "the helper text never carries the token value");
    assert.match(recorded(f, "push-helper-out"), new RegExp(`password=${TOKEN}`), "run as git runs it, the helper answers with the token");
    assert.ok(!recorded(f, "calls").includes(TOKEN), "GH_TOKEN's value appears in no recorded argv");
    const firstPayload = published(f);
    assert.ok(!firstPayload.includes(TOKEN), "GH_TOKEN's value appears nowhere in the payload");
    const firstTip = f.bare.git("rev-parse", `refs/heads/${BRANCH}`);
    assert.equal(pushes[0][pushes[0].length - 1], `${firstTip}:refs/heads/${BRANCH}`, "the bare remote received exactly the beat that was pushed");

    // OBJECTS: a second beat is received too, and the checkout's loose count has not moved.
    const second = beat(f, script);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    const secondTip = f.bare.git("rev-parse", `refs/heads/${BRANCH}`);
    assert.notEqual(secondTip, firstTip, "the bare remote received the second beat");
    assert.equal(looseCount(f.install), looseBefore, "the checkout the beat runs from gained no loose objects");
    for (const tip of [firstTip, secondTip]) {
      const r = spawnSync(REAL_GIT, ["-C", f.install.dir, "cat-file", "-e", tip], { encoding: "utf8" });
      assert.notEqual(r.status, 0, `beat commit ${tip} must not exist in the install's own object store`);
    }
    assert.deepEqual(
      readdirSync(join(f.rmdRoot, "state")).filter((n) => n.startsWith(".beat-objects.")),
      [],
      "the private object store is removed after each beat",
    );
    assert.ok(!recorded(f, "calls").includes(TOKEN), "still no token in any argv after two beats");
    assert.equal(f.install.git("status", "--porcelain"), "", "the install's working tree is untouched");
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: a checkout's own credential helper keeps working beside the beat's", () => {
  const f = fixture();
  try {
    f.install.git("config", "credential.helper", "!own() { echo password=own; }; own");
    const r = beat(f, join(f.install.dir, SCRIPT_REL));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const helpers = recorded(f, "push-helper").split("\n").filter(Boolean);
    assert.equal(helpers.length, 2, `the repo's helper and the beat's both resolve: ${helpers.join(" | ")}`);
    assert.ok(helpers[0].includes("own()"), "the checkout's own helper stays first");
    assert.ok(helpers[1].includes("$GH_TOKEN"));
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: without GH_TOKEN the push adds no helper", () => {
  const f = fixture();
  try {
    const r = beat(f, join(f.install.dir, SCRIPT_REL), { GH_TOKEN: "" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(recorded(f, "push-helper").trim(), "NO-HELPER");
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: the beat names stale code when its script differs from the converged install", () => {
  const f = fixture();
  try {
    const installBlob = f.install.git("rev-parse", `HEAD:${SCRIPT_REL}`);
    const installSha = f.install.git("rev-parse", "--short", "HEAD");

    // CURRENT: run from the install itself.
    const own = beat(f, join(f.install.dir, SCRIPT_REL), { RMD_HEARTBEAT_INSTALL_ROOT: f.install.dir });
    assert.equal(own.status, 0, own.stdout + own.stderr);
    let payload = published(f);
    assert.equal(field(payload, "beat_code_verdict"), "current");
    assert.equal(field(payload, "beat_script_blob"), installBlob);
    assert.equal(field(payload, "install_script_blob"), installBlob);
    assert.equal(field(payload, "install_root"), f.install.dir);
    assert.equal(field(payload, "install_root_head_sha"), installSha);
    assert.equal(field(payload, "beat_script_path"), join(f.install.dir, SCRIPT_REL));

    // STALE: a copy whose blob differs, in a checkout of its own that can push.
    const copy = gitRepo({ kind: "hbcode-copy" });
    copy.addRemote("origin", f.bare.dir);
    mkdirSync(join(copy.dir, "scripts"), { recursive: true });
    const copyScript = join(copy.dir, SCRIPT_REL);
    writeFileSync(copyScript, readFileSync(REAL_SCRIPT, "utf8") + "\n# a frozen copy that has drifted from the install\n", { mode: 0o755 });
    const copyBlob = spawnSync(REAL_GIT, ["hash-object", copyScript], { encoding: "utf8" }).stdout.trim();
    assert.notEqual(copyBlob, installBlob, "fixture sanity: the copy's blob differs");
    const stale = beat(f, copyScript, { RMD_HEARTBEAT_INSTALL_ROOT: f.install.dir });
    assert.equal(stale.status, 0, stale.stdout + stale.stderr);
    payload = published(f);
    const verdict = field(payload, "beat_code_verdict") ?? "";
    assert.ok(verdict.startsWith("STALE"), verdict);
    assert.ok(verdict.includes(copyBlob), `names the running blob: ${verdict}`);
    assert.ok(verdict.includes(installBlob), `names the install's blob: ${verdict}`);
    assert.ok(verdict.includes(f.install.dir) && verdict.includes(installSha), verdict);
    assert.equal(field(payload, "beat_script_blob"), copyBlob);
    assert.equal(field(payload, "install_dir"), copy.dir, "install_dir keeps meaning the directory the beat runs from");
    copy.cleanup();
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: a beat that cannot read the install root reports unknown, never current", () => {
  const f = fixture();
  try {
    const script = join(f.install.dir, SCRIPT_REL);

    // No install root at all: RMD_ROOT/daemon-install does not exist.
    const none = beat(f, script);
    assert.equal(none.status, 0, none.stdout + none.stderr);
    let verdict = field(published(f), "beat_code_verdict") ?? "";
    assert.ok(verdict.startsWith("unknown"), verdict);
    assert.equal(field(published(f), "install_root"), join(f.rmdRoot, "daemon-install"), "the default root is resolveInstallRoot's");

    // A root that exists but is not a repository.
    const plain = join(f.dir, "plain-dir");
    mkdirSync(plain);
    beat(f, script, { RMD_HEARTBEAT_INSTALL_ROOT: plain });
    verdict = field(published(f), "beat_code_verdict") ?? "";
    assert.ok(verdict.startsWith("unknown"), verdict);

    // A repository whose HEAD does not carry the script.
    const bareRoot = gitRepo({ kind: "hbcode-noscript" });
    beat(f, script, { RMD_HEARTBEAT_INSTALL_ROOT: bareRoot.dir });
    verdict = field(published(f), "beat_code_verdict") ?? "";
    assert.ok(verdict.startsWith("unknown"), verdict);
    assert.ok(verdict.includes("has no scripts/fleet-heartbeat.sh"), verdict);
    assert.equal(field(published(f), "install_script_blob"), "unknown");
    bareRoot.cleanup();
  } finally {
    f.cleanup();
  }
});

test("W1-T10756: the install root falls back to config.json's installRoot", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.home, ".config", "remudero"), { recursive: true });
    writeFileSync(join(f.home, ".config", "remudero", "config.json"), JSON.stringify({ installRoot: f.install.dir }));
    const r = beat(f, join(f.install.dir, SCRIPT_REL));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(field(published(f), "install_root"), f.install.dir);
    assert.equal(field(published(f), "beat_code_verdict"), "current");
  } finally {
    f.cleanup();
  }
});
