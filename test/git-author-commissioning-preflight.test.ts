// W1-T6160, criterion 2: `--commission-git-author` refuses an invalid author pair, and an unknown,
// ambiguous or mismatched target, BEFORE any pause, pull, stop, removal or identity write — and a
// refusal leaves the sibling instance exactly as it was. Each refusal names the input that failed,
// never its value, and ends in a `outcome=refused phase=preflight` receipt.
//
// The REAL recycler runs against a fake `docker` that records every call; a fake `docker run`
// would boot the REAL entrypoint into an isolated HOME, so "no identity write" is checked on the
// HOME the target container would have used, not inferred from the call list alone.
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
function initCheckout(path: string): void {
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
    initCheckout(join(inst.state, "remudero"));
  }
  if (opts.targetRepoCheckout) initCheckout(join(target.state, "repos", target.repo));
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

const MUTATING = new Set(["pull", "stop", "rm", "run", "container", "exec"]);

/** The refusal contract shared by every case: exit 2, a preflight receipt, nothing touched. */
function assertRefusedUntouched(fx: Fixture, run: Run, reason: RegExp, targetHome?: string): void {
  assert.equal(run.status, 2, run.out);
  assert.match(run.stderr, reason);
  assert.match(run.stderr, /NOTHING has been touched: no pause, pull, stop, removal or identity write/);
  assert.match(run.stderr, /GIT AUTHOR COMMISSION RECEIPT target=\S+ container=\S+ operation=commission-git-author outcome=refused phase=preflight/);
  assert.match(run.stderr, /  recovery: \S/);
  assert.deepEqual(run.calls.filter((c) => MUTATING.has(c[1])), [], "no lifecycle docker call may run");
  assert.ok(!run.calls.some((c) => c.includes(fx.sibling.container)), "the sibling container is never named");
  for (const inst of [fx.target, fx.sibling]) {
    assert.equal(existsSync(join(inst.state, "state", "PAUSE")), false, `${inst.name} must not be paused`);
  }
  assert.equal(existsSync(join(fx.sibling.state, "state", "ledger.ndjson")), false, "the sibling ledger is untouched");
  if (targetHome) assert.equal(git(targetHome, ["config", "--global", "--get", "user.email"]).stdout, PERSISTED_EMAIL, "no identity write");
  for (const value of [BAD_NAME, BAD_EMAIL]) assert.ok(!run.out.includes(value), "no author value is printed");
}

function liveTarget(): { fx: Fixture; home: string } {
  const fx = makeFixture();
  const home = seedContainer(fx, fx.target, [`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`, `RMD_GIT_AUTHOR_EMAIL=${BAD_EMAIL}`], [PERSISTED_NAME, PERSISTED_EMAIL]);
  seedContainer(fx, fx.sibling, [`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`, `RMD_GIT_AUTHOR_EMAIL=${BAD_EMAIL}`]);
  return { fx, home };
}

const INVALID_PAIRS: { why: string; env: Record<string, string>; reason: RegExp }[] = [
  { why: "missing name", env: { RMD_GIT_AUTHOR_EMAIL: NEW_EMAIL }, reason: /RMD_GIT_AUTHOR_NAME is not set/ },
  { why: "missing email", env: { RMD_GIT_AUTHOR_NAME: NEW_NAME }, reason: /RMD_GIT_AUTHOR_EMAIL is not set/ },
  { why: "empty email", env: { RMD_GIT_AUTHOR_NAME: NEW_NAME, RMD_GIT_AUTHOR_EMAIL: "" }, reason: /RMD_GIT_AUTHOR_EMAIL is not set/ },
  { why: "whitespace-only name", env: { RMD_GIT_AUTHOR_NAME: "   ", RMD_GIT_AUTHOR_EMAIL: NEW_EMAIL }, reason: /RMD_GIT_AUTHOR_NAME is whitespace-only/ },
  { why: "newline in name", env: { RMD_GIT_AUTHOR_NAME: "Two\nLines", RMD_GIT_AUTHOR_EMAIL: NEW_EMAIL }, reason: /RMD_GIT_AUTHOR_NAME contains a control character/ },
  { why: "escape byte in email", env: { RMD_GIT_AUTHOR_NAME: NEW_NAME, RMD_GIT_AUTHOR_EMAIL: "a\u001b@example.com" }, reason: /RMD_GIT_AUTHOR_EMAIL contains a control character/ },
  { why: "email without a domain dot", env: { RMD_GIT_AUTHOR_NAME: NEW_NAME, RMD_GIT_AUTHOR_EMAIL: "someone@localhost" }, reason: /RMD_GIT_AUTHOR_EMAIL is not a single address/ },
  { why: "two addresses", env: { RMD_GIT_AUTHOR_NAME: NEW_NAME, RMD_GIT_AUTHOR_EMAIL: "a@example.com b@example.com" }, reason: /RMD_GIT_AUTHOR_EMAIL is not a single address/ },
  { why: "angle bracket in name", env: { RMD_GIT_AUTHOR_NAME: "Evil <x", RMD_GIT_AUTHOR_EMAIL: NEW_EMAIL }, reason: /RMD_GIT_AUTHOR_NAME contains '<' or '>'/ },
  { why: "name git would strip", env: { RMD_GIT_AUTHOR_NAME: "Trailing Dot.", RMD_GIT_AUTHOR_EMAIL: NEW_EMAIL }, reason: /RMD_GIT_AUTHOR_NAME begins or ends with a character git strips/ },
];

test("invalid author pairs refuse before pause, pull, stop, removal or identity writes", () => {
  for (const c of INVALID_PAIRS) {
    const { fx, home } = liveTarget();
    const run = recycle(fx, ["--instance", "target", "--commission-git-author"], { RMD_GIT_AUTHOR_NAME: "", RMD_GIT_AUTHOR_EMAIL: "", ...c.env });
    assertRefusedUntouched(fx, run, c.reason, home);
    assert.match(run.stderr, /invalid author pair:.*\(values not printed\)/, c.why);
  }
});

test("an unknown target refuses before anything is touched", () => {
  const { fx, home } = liveTarget();
  const run = recycle(fx, ["--instance", "nosuch", "--commission-git-author"], commissionEnv);
  assert.equal(run.status, 2, run.out);
  assert.match(run.stderr, /instance 'nosuch' is not declared/);
  assert.match(run.stderr, /RECEIPT target=nosuch container=<unresolved> operation=commission-git-author outcome=refused phase=preflight/);
  assert.deepEqual(run.calls, [], "an unknown target never reaches docker at all");
  assert.equal(git(home, ["config", "--global", "--get", "user.email"]).stdout, PERSISTED_EMAIL);
});

test("no explicit target refuses: the mode is scoped to exactly one --instance", () => {
  const { fx } = liveTarget();
  const run = recycle(fx, ["--commission-git-author"], { ...commissionEnv, RMD_STATE_DIR: fx.target.state });
  assertRefusedUntouched(fx, run, /needs exactly one explicit --instance/);
});

test("ambiguous targets refuse: a repeated --instance, a duplicated record, a shared container or state dir", () => {
  {
    const { fx, home } = liveTarget();
    const run = recycle(fx, ["--instance", "target", "--instance", "sibling", "--commission-git-author"], commissionEnv);
    assertRefusedUntouched(fx, run, /ambiguous target: --instance was given 2 times/, home);
  }
  {
    const { fx, home } = liveTarget();
    const reg = readFileSync(fx.registry, "utf8");
    writeFileSync(fx.registry, reg.replace("  sibling:", "  target:\n    repo: remudero-target\n  sibling:"));
    const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
    assertRefusedUntouched(fx, run, /ambiguous target: 'target' is declared 2 times/, home);
  }
  for (const field of ["container_name", "state_dir"] as const) {
    const { fx, home } = liveTarget();
    const reg = readFileSync(fx.registry, "utf8");
    // The sibling's record is pointed at the target's own container, or its own state directory.
    const edited =
      field === "state_dir"
        ? reg.replace(`state_dir: ${fx.sibling.state}`, `state_dir: ${fx.target.state}`)
        : reg.replace(`container_name: ${fx.sibling.container}`, `container_name: ${fx.target.container}`);
    assert.notEqual(edited, reg, `the ${field} fixture edit must apply`);
    writeFileSync(fx.registry, edited);
    const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
    assertRefusedUntouched(fx, run, /ambiguous target: instance 'sibling' declares the same container_name or state_dir/, home);
  }
});

test("mismatched targets refuse: a live container on another state dir, a CLI retarget, a broken target checkout", () => {
  {
    const { fx, home } = liveTarget();
    writeFileSync(join(fx.world, fx.target.container, "mounts"), `${fx.sibling.state}\t${STATE_MOUNT}\ttrue\n`);
    const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
    assertRefusedUntouched(fx, run, /mismatched target: rmd-target-daemon does not mount .* at \/home\/node\/Remudero/, home);
  }
  {
    const { fx, home } = liveTarget();
    const run = recycle(fx, ["--instance", "target", "--container", "rmd-sibling-daemon", "--commission-git-author"], commissionEnv);
    assert.equal(run.status, 2, run.out);
    assert.match(run.stderr, /mismatched target: --container would override the registry's declaration of 'target'/);
    assert.deepEqual(run.calls.filter((c) => MUTATING.has(c[1])), []);
    assert.equal(git(home, ["config", "--global", "--get", "user.email"]).stdout, PERSISTED_EMAIL);
  }
  {
    const { fx, home } = liveTarget();
    mkdirSync(join(fx.target.state, "repos", fx.target.repo), { recursive: true });
    const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
    assertRefusedUntouched(fx, run, /mismatched target checkout: .*repos\/remudero-target exists but is not a git checkout/, home);
  }
});

test("POSITIVE CONTROL: the same fixture with a sound pair and target commissions, and the sibling stays untouched", () => {
  const { fx } = liveTarget();
  const siblingEnv = readFileSync(join(fx.world, fx.sibling.container, "env"), "utf8");
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
  assert.equal(run.status, 0, run.out);
  assert.match(run.stdout, /outcome=verified phase=verified/);
  assert.ok(!run.calls.some((c) => c.includes(fx.sibling.container)), "the sibling container is never named");
  assert.equal(readFileSync(join(fx.world, fx.sibling.container, "env"), "utf8"), siblingEnv, "the sibling's environment is unchanged");
  assert.equal(existsSync(join(fx.sibling.state, "state", "PAUSE")), false);
});
