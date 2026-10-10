// W1-T6160, criterion 4: a commissioning NEVER reports success it did not observe. An identity write
// error at boot, a replacement whose environment lacks the pair, a repository-local or environment
// identity that masks it, and a probe that fails or hangs each return failure, name the phase, give
// a concrete recovery, and emit a receipt (and ledger row) that identifies the target and outcome
// without printing any author value or credential.
//
// The REAL recycler runs against a fake `docker` whose `run` boots the REAL entrypoint into an
// isolated HOME and whose `exec` runs real git there; each failure is injected into that fixture.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

const SECRETS = [NEW_NAME, NEW_EMAIL, BAD_NAME, BAD_EMAIL, "fixture-token-not-real", "Masking Env Author", "masking-local@example.com"];

function liveTarget(opts: { targetRepoCheckout?: boolean } = {}): Fixture {
  const fx = makeFixture(opts);
  seedContainer(fx, fx.target, [`RMD_GIT_AUTHOR_NAME=${BAD_NAME}`, `RMD_GIT_AUTHOR_EMAIL=${BAD_EMAIL}`], [PERSISTED_NAME, PERSISTED_EMAIL]);
  return fx;
}

/** The failure contract: exit non-zero, a phase-specific failed receipt with recovery, values redacted. */
function assertFailedReceipt(fx: Fixture, run: Run, phase: string, recovery: RegExp): void {
  assert.equal(run.status, 1, run.out);
  assert.match(run.stderr, new RegExp(`GIT AUTHOR COMMISSION RECEIPT target=target container=rmd-target-daemon operation=commission-git-author outcome=failed phase=${phase}\\n`));
  const recoveryLine = run.stderr.split("\n").find((l) => l.startsWith("  recovery: ")) ?? "";
  assert.match(recoveryLine, recovery);
  assert.doesNotMatch(run.stdout, /outcome=verified|VERIFIED/, "a failure is never reported as verified");
  for (const value of SECRETS) assert.ok(!run.out.includes(value), `no author value or credential is printed (${value.length} chars)`);
  const ledger = readFileSync(join(fx.target.state, "state", "ledger.ndjson"), "utf8").split("\n").filter((l) => l.includes("git_author_commission"));
  assert.equal(ledger.length, 1, "exactly one ledger receipt");
  const row = JSON.parse(ledger[0]);
  assert.deepEqual([row.instance, row.container, row.outcome, row.phase], ["target", "rmd-target-daemon", "failed", phase]);
  for (const value of SECRETS) assert.ok(!ledger[0].includes(value), "the ledger receipt carries no author value");
}

test("an identity write error stops the boot loudly instead of continuing on an unapplied author", () => {
  const home = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}git-author-write-error-`));
  mkdirSync(join(home, ".gitconfig"));
  const boot = spawnSync("bash", [ENTRYPOINT, "true"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", RMD_SKIP_BOOTSTRAP: "1", ...commissionEnv },
  });
  assert.notEqual(boot.status, 0, "the boot must fail");
  assert.match(boot.stderr, /git identity: FAILED to write user\.name/);
  assert.doesNotMatch(boot.stderr, /authoritative\)/, "and must not log the author as applied");
});

test("an identity write error in the replacement fails the commissioning at verify-identity with a docker-logs recovery", () => {
  const control = recycle(liveTarget(), ["--instance", "target", "--commission-git-author"], commissionEnv);
  assert.equal(control.status, 0, `control: the fixture commissions when the write can succeed: ${control.out}`);
  // The same fixture, except the container HOME's .gitconfig cannot be written.
  const broken = liveTarget();
  const brokenHome = join(broken.world, broken.target.container, "home");
  rmSync(join(brokenHome, ".gitconfig"));
  mkdirSync(join(brokenHome, ".gitconfig"));
  const failed = recycle(broken, ["--instance", "target", "--commission-git-author"], commissionEnv);
  assertFailedReceipt(broken, failed, "verify-identity", /docker logs rmd-target-daemon .*git identity: FAILED/);
  assert.match(failed.stderr, /effective-author probe from \/home\/node\/Remudero\/remudero failed \(exit 1\)/);
  assert.match(readFileSync(join(broken.world, broken.target.container, "boot.log"), "utf8"), /git identity: FAILED to write/);
});

test("a replacement whose environment lacks the requested pair fails at verify-env", () => {
  const fx = liveTarget();
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], { ...commissionEnv, STUB_RUN_ENV_DROP: "RMD_GIT_AUTHOR_EMAIL" });
  assertFailedReceipt(fx, run, "verify-env", /re-run the same commissioning command with both RMD_GIT_AUTHOR_\* exported/);
  assert.match(run.stderr, /replacement's RMD_GIT_AUTHOR_NAME\/RMD_GIT_AUTHOR_EMAIL do not carry the requested pair/);
});

test("a repository-local identity in the target checkout masks the global match and fails with an unset recovery", () => {
  const fx = liveTarget({ targetRepoCheckout: true });
  const checkout = join(fx.target.state, "repos", fx.target.repo);
  git(fx.root, ["-C", checkout, "config", "--local", "user.name", "Masking Local Author"]);
  git(fx.root, ["-C", checkout, "config", "--local", "user.email", "masking-local@example.com"]);
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
  assertFailedReceipt(fx, run, "verify-identity", /git -C \/home\/node\/Remudero\/repos\/remudero-target config --local --unset-all user\.name/);
  assert.match(run.stderr, /repository-local user\.name\/user\.email .* masks the commissioned author/);
  // The global config DID take the pair — the failure is the mask, which a global-only check would miss.
  assert.equal(git(join(fx.world, fx.target.container, "home"), ["config", "--global", "--get", "user.email"]).stdout, NEW_EMAIL);
});

test("a Git author variable in the container environment masks the config and fails with its name only", () => {
  const fx = liveTarget();
  writeFileSync(join(fx.world, fx.target.container, "exec-env"), "GIT_AUTHOR_NAME=Masking Env Author\n");
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
  assertFailedReceipt(fx, run, "verify-identity", /remove those variables from the image or launch environment/);
  assert.match(run.stderr, /the container environment sets GIT_AUTHOR_NAME, which masks the commissioned author/);
});

test("a failed effective-author probe is a failure, not a success", () => {
  const fx = liveTarget();
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], { ...commissionEnv, STUB_PROBE: "fail" });
  assertFailedReceipt(fx, run, "verify-identity", /docker logs rmd-target-daemon/);
  assert.match(run.stderr, /effective-author probe from \S+ failed \(exit 1\) within 3s/);
});

test("a hung effective-author probe is bounded and reported as timed out", () => {
  const fx = liveTarget();
  const started = Date.now();
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], {
    ...commissionEnv,
    STUB_PROBE: "hang",
    RMD_RECYCLE_AUTHOR_PROBE_TIMEOUT_S: "2",
  });
  assert.ok(Date.now() - started < 25_000, "the probe bound holds well under the stub's 30s hang");
  assertFailedReceipt(fx, run, "verify-identity", /docker logs rmd-target-daemon/);
  assert.match(run.stderr, /effective-author probe from \S+ timed out within 2s/);
});

test("a failure before the old container is stopped names its phase and says the target is untouched", () => {
  const fx = liveTarget();
  writeFileSync(join(fx.bin, "az"), "#!/usr/bin/env bash\necho 'login expired' >&2\nexit 1\n", { mode: 0o755 });
  const run = recycle(fx, ["--instance", "target", "--commission-git-author"], commissionEnv);
  assertFailedReceipt(fx, run, "pull", /outgoing container is untouched and still running/);
  assert.deepEqual(run.calls.filter((c) => ["stop", "rm", "run"].includes(c[1])), []);
});
