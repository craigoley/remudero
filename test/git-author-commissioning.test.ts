// W1-T6160: `deploy/recycle-container.sh --instance <name> --commission-git-author` commissions or
// replaces one target's Git author. An ordinary recycle keeps a non-empty outgoing RMD_GIT_AUTHOR_*
// over a conflicting export (W1-T3454) and the entrypoint used to leave an already-configured HOME
// identity alone, so before this an export could never replace a bad author.
//
// These tests run the REAL recycler against a fake `docker` whose `run` boots the REAL entrypoint
// with an isolated HOME, and whose `exec` runs real git from the fixture checkout with that HOME and
// the container's environment. So the "effective author" asserted here is what git itself resolves.
// No Docker daemon, network, token or live fleet state is involved.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";
import { gitRepo } from "./helpers/git-repo.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RECYCLER = join(REPO_ROOT, "deploy", "recycle-container.sh");
const ENTRYPOINT = join(REPO_ROOT, "deploy", "entrypoint.sh");
const STATE_MOUNT = "/home/node/Remudero";

const NEW_NAME = "Commissioned Author Fixture";
const NEW_EMAIL = "commissioned-author-fixture@example.com";
const BAD_NAME = "Bad Outgoing Author";
const BAD_EMAIL = "bad-outgoing-author@example.com";
const PERSISTED_NAME = "Persisted Wrong Identity";
const PERSISTED_EMAIL = "persisted-wrong-identity@example.com";

/** The fake docker. State lives under $STUB_WORLD/<container>/{env,mounts,home,boot-status}. */
const DOCKER_STUB = [
  "#!/usr/bin/env bash",
  'W="$STUB_WORLD"',
  "{ printf 'docker'; for a in \"$@\"; do printf '\\t%s' \"$a\"; done; printf '\\n'; } >> \"$STUB_REC/calls\"",
  "img_env() { printf 'PATH=/usr/local/bin:/usr/bin:/bin\\nHOME=/home/node\\nNODE_VERSION=22.11.0\\n'; }",
  "state_of() { awk -F'\\t' '$2 == \"/home/node/Remudero\" { print $1; exit }' \"$W/$1/mounts\" 2>/dev/null; }",
  'case "$1" in',
  "  image)",
  '    case "$4" in *Config.Env*) img_env; echo; exit 0 ;; esac',
  "    echo sha256:PULLED; exit 0 ;;",
  "  inspect)",
  "    shift; fmt=''",
  '    if [ "$1" = --format ]; then fmt="$2"; shift 2; fi',
  '    [ -f "$W/$1/env" ] || exit 1',
  '    case "$fmt" in',
  '      *Mounts*) cat "$W/$1/mounts" ;;',
  '      *Config.Env*) img_env; cat "$W/$1/env"; echo ;;',
  "      *.Image*) echo sha256:PULLED ;;",
  "    esac",
  "    exit 0 ;;",
  '  pull) echo "Status: Downloaded newer image"; exit 0 ;;',
  '  container) [ "$2" = run ] && echo "WORKER-SMOKE PASS fixture"; exit 0 ;;',
  '  rm) rm -f "$W/$2/env"; exit 0 ;;',
  "  run)",
  "    shift; name=''; envs=(); mounts=()",
  "    while [ $# -gt 0 ]; do",
  '      case "$1" in',
  '        --name) name="$2"; shift 2 ;;',
  '        -e) envs+=("$2"); shift 2 ;;',
  '        -v) mounts+=("$2"); shift 2 ;;',
  "        *.azurecr.io/*) break ;;",
  "        *) shift ;;",
  "      esac",
  "    done",
  '    d="$W/$name"; mkdir -p "$d/home"; : > "$d/env"; : > "$d/mounts"',
  '    for e in "${envs[@]}"; do',
  '      if [ -n "${STUB_RUN_ENV_DROP:-}" ] && [ "${e%%=*}" = "$STUB_RUN_ENV_DROP" ]; then continue; fi',
  "      printf '%s\\n' \"$e\" >> \"$d/env\"",
  "    done",
  "    for m in \"${mounts[@]}\"; do printf '%s\\t%s\\ttrue\\n' \"${m%%:*}\" \"${m#*:}\" >> \"$d/mounts\"; done",
  '    state="$(state_of "$name")"',
  '    if [ -n "$state" ] && [ ! -e "$state/remudero/.git" ]; then HOME="$d/home" GIT_CONFIG_NOSYSTEM=1 git init -q "$state/remudero"; fi',
  "    benv=(); while IFS= read -r l; do [ -n \"$l\" ] && benv+=(\"$l\"); done < \"$d/env\"",
  '    env -i PATH="$PATH" HOME="$d/home" GIT_CONFIG_NOSYSTEM=1 RMD_SKIP_BOOTSTRAP=1 "${benv[@]}" bash "$STUB_ENTRYPOINT" true > "$d/boot.log" 2>&1',
  '    echo $? > "$d/boot-status"',
  "    echo fixture-container-id; exit 0 ;;",
  "  exec)",
  "    shift; wd=''",
  "    while [ $# -gt 0 ]; do",
  '      case "$1" in --user|-u|-e) shift 2 ;; -w) wd="$2"; shift 2 ;; -*) shift ;; *) break ;; esac',
  "    done",
  '    c="$1"; shift; d="$W/$c"',
  '    [ "$1" = ps ] && exit 0',
  '    if [ ! -f "$d/env" ] || [ "$(cat "$d/boot-status" 2>/dev/null)" != 0 ]; then echo "container $c is not running" >&2; exit 1; fi',
  '    if [ "$1 $2" = "git var" ]; then',
  '      case "${STUB_PROBE:-}" in hang) exec sleep 30 ;; fail) echo "probe failure" >&2; exit 1 ;; esac',
  "    fi",
  '    dir="$d/home"; [ -z "$wd" ] || dir="$(state_of "$c")${wd#/home/node/Remudero}"',
  "    cenv=(); while IFS= read -r l; do [ -n \"$l\" ] && cenv+=(\"$l\"); done < <(cat \"$d/env\" \"$d/exec-env\" 2>/dev/null)",
  '    cd "$dir" || exit 1',
  '    exec env -i PATH="$PATH" HOME="$d/home" GIT_CONFIG_NOSYSTEM=1 "${cenv[@]}" "$@" ;;',
  "esac",
  "exit 0",
  "",
].join("\n");

interface Instance {
  name: string;
  container: string;
  repo: string;
  state: string;
  claude: string;
}

interface Fixture {
  root: string;
  world: string;
  rec: string;
  bin: string;
  registry: string;
  target: Instance;
  sibling: Instance;
}

interface Run {
  status: number;
  out: string;
  stdout: string;
  stderr: string;
  calls: string[][];
}

function git(home: string, args: string[], cwd?: string): { status: number; stdout: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
  });
  return { status: r.status ?? -1, stdout: (r.stdout ?? "").trim() };
}

/** An empty checkout at `path`, built by the shared fixture (test/helpers/git-repo.ts) and moved into place. */
function placeEmptyGitDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  renameSync(gitRepo({ seedCommit: false, kind: "git-author-checkout" }).dir, path);
}

function makeFixture(opts: { freshTarget?: boolean; targetRepoCheckout?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}git-author-commission-`));
  const world = join(root, "world");
  const rec = join(root, "rec");
  const bin = join(root, "bin");
  for (const d of [world, rec, bin]) mkdirSync(d);
  writeFileSync(join(bin, "docker"), DOCKER_STUB, { mode: 0o755 });
  writeFileSync(join(bin, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const mk = (name: string, container: string, repo: string): Instance => {
    const inst = { name, container, repo, state: join(root, `${name}-state`), claude: join(root, `${name}-claude`) };
    mkdirSync(inst.state);
    mkdirSync(inst.claude);
    return inst;
  };
  const target = mk("target", "rmd-target-daemon", "remudero-target");
  const sibling = mk("sibling", "rmd-sibling-daemon", "remudero-sibling");
  for (const inst of opts.freshTarget ? [sibling] : [target, sibling]) {
    mkdirSync(join(inst.state, "state"));
    placeEmptyGitDir(join(inst.state, "remudero"));
  }
  if (opts.targetRepoCheckout) placeEmptyGitDir(join(target.state, "repos", target.repo));
  const record = (inst: Instance) => [
    `  ${inst.name}:`,
    `    repo: ${inst.repo}`,
    `    container_name: ${inst.container}`,
    `    state_dir: ${inst.state}`,
    `    claude_dir: ${inst.claude}`,
    `    codex_dir: ${join(root, "absent-codex")}`,
    `    container_config_dir: ${join(root, "absent-config")}`,
    "    image: test-registry.azurecr.io/remudero:latest",
  ];
  const registry = join(root, "daemon-instances.yaml");
  writeFileSync(registry, ["instances:", ...record(target), ...record(sibling), ""].join("\n"));
  return { root, world, rec, bin, registry, target, sibling };
}

/** Seed a running container for `inst`: its runtime env, its mounts, and optionally a HOME identity. */
function seedContainer(fx: Fixture, inst: Instance, env: string[], persisted?: [string, string]): string {
  const d = join(fx.world, inst.container);
  mkdirSync(join(d, "home"), { recursive: true });
  writeFileSync(join(d, "env"), `${["GH_TOKEN=", ...env].join("\n")}\n`);
  writeFileSync(join(d, "mounts"), `${inst.state}\t${STATE_MOUNT}\ttrue\n${inst.claude}\t/home/node/.claude\ttrue\n`);
  writeFileSync(join(d, "boot-status"), "0\n");
  if (persisted) {
    git(join(d, "home"), ["config", "--global", "user.name", persisted[0]]);
    git(join(d, "home"), ["config", "--global", "user.email", persisted[1]]);
  }
  return join(d, "home");
}

function recycle(fx: Fixture, args: string[], env: Record<string, string> = {}, scripts = { recycler: RECYCLER, entrypoint: ENTRYPOINT }): Run {
  writeFileSync(join(fx.rec, "calls"), "");
  const r = spawnSync("bash", [scripts.recycler, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: `${fx.bin}:${process.env.PATH ?? ""}`,
      HOME: fx.root,
      TMPDIR: tmpdir(),
      STUB_WORLD: fx.world,
      STUB_REC: fx.rec,
      STUB_ENTRYPOINT: scripts.entrypoint,
      RMD_INSTANCE_REGISTRY: fx.registry,
      RMD_RECYCLE_DOCKERENV_PATH: join(fx.root, "no-such-dockerenv"),
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_SKIP_RECLAIM: "1",
      RMD_RECYCLE_AUTHOR_PROBE_TIMEOUT_S: "3",
      RMD_RECYCLE_AUTHOR_PROBE_POLL_S: "1",
      GH_TOKEN: "fixture-token-not-real",
      ...env,
    },
  });
  const calls = readFileSync(join(fx.rec, "calls"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t"));
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { status: r.status ?? -1, out: `${stdout}\n${stderr}`, stdout, stderr, calls };
}

const runCall = (run: Run) => run.calls.find((c) => c[1] === "run");
const commissionEnv = { RMD_GIT_AUTHOR_NAME: NEW_NAME, RMD_GIT_AUTHOR_EMAIL: NEW_EMAIL };

/** What git itself resolves as the author from `dir`, with the container's HOME. */
function effectiveAuthor(home: string, dir: string): string {
  const r = git(home, ["var", "GIT_AUTHOR_IDENT"], dir);
  assert.equal(r.status, 0, `git var must resolve an author in ${dir}`);
  return r.stdout.replace(/ \d+ [+-]\d{4}$/, "");
}

test("the explicit mode commissions a fresh target: the requested pair is carried, booted and verified", () => {
  const fx = makeFixture({ freshTarget: true });
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], { ...commissionEnv, RMD_RECYCLE_FIRST_BOOT: "1" });
  assert.equal(run.status, 0, run.out);
  assert.match(run.stdout, /GIT AUTHOR COMMISSION RECEIPT target=target container=rmd-target-daemon operation=commission-git-author outcome=verified phase=verified/);
  const argv = runCall(run) ?? [];
  assert.ok(argv.includes(`RMD_GIT_AUTHOR_NAME=${NEW_NAME}`) && argv.includes(`RMD_GIT_AUTHOR_EMAIL=${NEW_EMAIL}`), "the replacement is launched with the pair");
  const home = join(fx.world, fx.target.container, "home");
  assert.equal(effectiveAuthor(home, join(fx.target.state, "remudero")), `${NEW_NAME} <${NEW_EMAIL}>`);
});

test("the explicit mode replaces a non-empty bad container author AND an already-configured persisted identity", () => {
  const fx = makeFixture({ targetRepoCheckout: true });
  const home = seedContainer(fx, fx.target, [`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`, `RMD_GIT_AUTHOR_EMAIL=${BAD_EMAIL}`], [PERSISTED_NAME, PERSISTED_EMAIL]);
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
  assert.equal(run.status, 0, run.out);
  assert.match(run.stdout, /outcome=verified phase=verified/);
  // Verified from the TARGET checkout (repos/<repo>), not merely the global config.
  assert.match(run.stdout, new RegExp(`effective author from ${STATE_MOUNT}/repos/remudero-target match`));
  const argv = runCall(run) ?? [];
  assert.ok(argv.includes(`RMD_GIT_AUTHOR_NAME=${NEW_NAME}`), "the requested name supersedes the outgoing one");
  assert.ok(!argv.includes(`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`), "the bad outgoing name is not carried");
  assert.equal(effectiveAuthor(home, join(fx.target.state, "repos", "remudero-target")), `${NEW_NAME} <${NEW_EMAIL}>`);
  assert.equal(git(home, ["config", "--global", "--get", "user.email"]).stdout, NEW_EMAIL, "the persisted identity was replaced");
});

test("an existing replacement keeps the graceful lifecycle: pause, smoke, stop, rm, run, in that order", () => {
  const fx = makeFixture();
  seedContainer(fx, fx.target, [`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`, `RMD_GIT_AUTHOR_EMAIL=${BAD_EMAIL}`]);
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
  assert.equal(run.status, 0, run.out);
  const order = run.calls.map((c) => (c[1] === "container" ? `container-${c[2]}` : c[1])).filter((v) => ["pull", "container-run", "stop", "rm", "run"].includes(v));
  assert.deepEqual(order, ["pull", "container-run", "stop", "rm", "run"]);
  assert.match(run.stdout, /PAUSE engaged/);
  assert.equal(existsSync(join(fx.target.state, "state", "PAUSE")), false, "the recycle's own pause is cleared");
});

/** A copy of deploy/ with one edit applied, so a single behaviour can be removed and re-tested. */
function mutatedDeploy(file: string, from: string, to: string): { recycler: string; entrypoint: string } {
  const dir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}git-author-mutant-`));
  cpSync(join(REPO_ROOT, "deploy"), join(dir, "deploy"), { recursive: true });
  const path = join(dir, "deploy", file);
  const src = readFileSync(path, "utf8");
  assert.ok(src.includes(from), `the mutation anchor must exist in ${file}`);
  writeFileSync(path, src.replace(from, to));
  return { recycler: join(dir, "deploy", "recycle-container.sh"), entrypoint: join(dir, "deploy", "entrypoint.sh") };
}

test("MUTANT: removing the explicit capture override fails the commissioning at verify-env", () => {
  const fx = makeFixture();
  seedContainer(fx, fx.target, [`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`, `RMD_GIT_AUTHOR_EMAIL=${BAD_EMAIL}`]);
  const mutant = mutatedDeploy("recycle-container.sh", '  CAPTURED_set RMD_GIT_AUTHOR_NAME "${COMMISSION_AUTHOR_NAME}"\n', "");
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv, mutant);
  assert.equal(run.status, 1, run.out);
  assert.match(run.stderr, /outcome=failed phase=verify-env/);
});

test("MUTANT: removing the authoritative boot write fails the commissioning at verify-identity", () => {
  const fx = makeFixture();
  seedContainer(fx, fx.target, [`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`, `RMD_GIT_AUTHOR_EMAIL=${BAD_EMAIL}`], [PERSISTED_NAME, PERSISTED_EMAIL]);
  const mutant = mutatedDeploy("entrypoint.sh", 'if [ -n "${RMD_GIT_AUTHOR_NAME:-}" ] && [ -n "${RMD_GIT_AUTHOR_EMAIL:-}" ]; then', "if false; then");
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv, mutant);
  assert.equal(run.status, 1, run.out);
  assert.match(run.stderr, /outcome=failed phase=verify-identity/);
  assert.match(run.stderr, /git resolves a different author/);
});
