#!/usr/bin/env node
// W1-T926, DECISIONS.md 2026-09-30: exercise container launcher convergence, not launchd.
// Only local disposable repositories run here. Docker and elevation are fixture substitutes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/argv.mjs";
import { GIT_SCRIPT_IDENTITY, gitOrThrow } from "./lib/git.mjs";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const ownedFixtures = new Set();
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function write(path, bytes, executable = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  if (executable) chmodSync(path, 0o755);
}

function within(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

function fixturePath(root, path) {
  assert.ok(ownedFixtures.has(root), "refusing an unowned fixture root");
  const resolved = realpathSync(path);
  assert.ok(resolved === root || within(root, resolved), "refusing a path outside the disposable fixture");
  return path;
}

// Include .git, empty directories, modes and symlink targets; never follow a link into another tree.
export function snapshotTree(root, prefix = "") {
  return readdirSync(join(root, prefix)).sort().flatMap((name) => {
    const path = prefix ? `${prefix}/${name}` : name;
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    const entry = { path, mode: stat.mode };
    if (stat.isSymbolicLink()) return [{ ...entry, link: readlinkSync(absolute) }];
    if (stat.isDirectory()) return [{ ...entry, directory: true }, ...snapshotTree(root, path)];
    assert.ok(stat.isFile(), `unsupported fixture entry: ${path}`);
    return [{ ...entry, bytes: readFileSync(absolute).toString("base64") }];
  });
}

export const DIRT_SHAPES = [
  {
    key: "untracked-exhaust",
    apply: ({ instance }) => write(join(instance, "plan/feedback/drill.yaml"), "origin: drill\n"),
    observe: ({ status }) => status.includes("?? plan/"),
  },
  {
    key: "tracked-modification",
    apply: ({ instance }) => write(join(instance, "DECISIONS.md"), "reviewed\nlocal decision\n"),
    observe: ({ status }) => status === "M DECISIONS.md",
  },
  {
    key: "scratch",
    apply: ({ instance }) => write(join(instance, ".claude/scratch/notes"), "unlanded\n"),
    observe: ({ status }) => status.includes("?? .claude/"),
  },
  {
    key: "off-main",
    apply: ({ instance, git }) => git(instance, ["switch", "--quiet", "-c", "drill-feature"]),
    observe: ({ branch }) => branch === "drill-feature",
  },
  {
    key: "diverged",
    apply: ({ instance, git }) => {
      write(join(instance, "local-only.txt"), "not reviewed\n");
      git(instance, ["add", "local-only.txt"]);
      git(instance, ["commit", "--quiet", "-m", "local-only fixture commit"]);
    },
    observe: ({ ahead }) => ahead === "1",
  },
];

function environment(root) {
  return {
    PATH: process.env.PATH,
    HOME: join(root, "home"), TMPDIR: join(root, "tmp"), LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file",
    GIT_AUTHOR_NAME: GIT_SCRIPT_IDENTITY.name, GIT_AUTHOR_EMAIL: GIT_SCRIPT_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_SCRIPT_IDENTITY.name, GIT_COMMITTER_EMAIL: GIT_SCRIPT_IDENTITY.email,
  };
}

function shell(root, script, env) {
  fixturePath(root, script);
  const result = spawnSync("bash", [script], {
    cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `fixture shell failed: ${result.stdout}\n${result.stderr}`);
  return result;
}

function createWorld(root) {
  const env = environment(root);
  for (const path of [env.HOME, env.TMPDIR, join(root, "state"), join(root, "stubs")]) mkdirSync(path);
  // The shared git helper merges env over process.env; erase ambient repository routing first.
  const clearedGitEnv = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("GIT_")).map((k) => [k, undefined]));
  const git = (cwd, args) => gitOrThrow(args, {
    cwd: fixturePath(root, cwd), env: { ...clearedGitEnv, ...env },
  });
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const install = join(root, "daemon-install");
  const instance = join(root, "remudero");
  git(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  git(root, ["init", "--quiet", "--initial-branch=main", seed]);
  git(seed, ["remote", "add", "origin", origin]);
  write(join(seed, "DECISIONS.md"), "reviewed\n");
  write(join(seed, "deploy/install-host-units.sh"), "#!/bin/sh\nexit 0\n", true);
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "reviewed fixture baseline"]);
  git(seed, ["push", "--quiet", "origin", "main"]);
  const beforeHead = git(seed, ["rev-parse", "HEAD"]);
  for (const clone of [install, instance]) git(root, ["clone", "--quiet", "--no-hardlinks", "--branch", "main", origin, clone]);

  const marker = join(root, "converged");
  const calls = join(root, "installer-calls");
  const forbidden = join(root, "forbidden-calls");
  const installer = join(install, "deploy/install-host-units.sh");
  write(join(seed, "deploy/install-host-units.sh"), `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(calls)}
if [ "\${1:-}" = --install ]; then printf 'reviewed-v2\\n' > ${quote(marker)}; exit 0; fi
echo 'install-host-units: DRIFTED fixture-units'
exit 1
`, true);
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "reviewed fixture update"]);
  git(seed, ["push", "--quiet", "origin", "main"]);
  const targetHead = git(seed, ["rev-parse", "HEAD"]);

  const stub = (name, body) => write(join(root, "stubs", name), `#!/bin/sh\n${body}\n`, true);
  const deny = `printf '%s\\n' "$0 $*" >> ${quote(forbidden)}; exit 97`;
  stub("docker", `case "\${1:-}" in
  ps) echo fixture-container; exit 0 ;;
  inspect) echo 'fixture-container running 0 fixture-start'; exit 0 ;;
esac
${deny}`);
  stub("sudo", `if [ "$*" = '-n true' ]; then exit 0; fi
if [ "$#" = 5 ] && [ "$1" = -n ] && [ "$2" = env ] &&
   [ "$3" = RMD_NODE_MAX_OLD_SPACE_MB=8192 ] && [ "$4" = ${quote(installer)} ] && [ "$5" = --install ]; then
  exec "$4" "$5"
fi
${deny}`);
  for (const name of ["launchctl", "systemctl", "crontab", "apt-get", "apt-cache", "gh"]) stub(name, deny);

  // Render from a disposable copy, with every output and host-node input pinned to that fixture.
  const renderer = join(root, "renderer");
  cpSync(join(REPO, "deploy"), join(renderer, "deploy"), { recursive: true });
  const launcher = join(root, "launcher.sh");
  const renderEnv = {
    ...env, PATH: `${join(root, "stubs")}:${env.PATH}`,
    RMD_STATE_DIR: root, RMD_UNIT_DIR: join(root, "units"), RMD_BIN_DIR: join(root, "unitbin"),
    RMD_LAUNCHER_PATH: launcher, RMD_REVIVAL_LOG: join(root, "revivals.log"),
    RMD_NODE_MAX_OLD_SPACE_MB: "8192", RMD_NODESOURCE_PATH: join(root, "no-nodesource"),
    RMD_SERVICE_UID: "unresolved-fixture-user",
  };
  const render = join(root, "render.sh");
  write(render, `#!/bin/sh\nexec bash ${quote(join(renderer, "deploy/install-host-units.sh"))} --install\n`);
  shell(root, render, renderEnv);
  assert.ok(!existsSync(forbidden), "renderer attempted a forbidden host action");
  return { root, env: { ...env, PATH: renderEnv.PATH }, git, instance, install, launcher, marker, calls, forbidden, beforeHead, targetHead };
}

function exercise(shape) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rmd-operator-dirt-drill-")));
  ownedFixtures.add(root);
  let ran = false;
  try {
    const world = createWorld(root);
    shape.apply(world);
    const { git, instance, install } = world;
    const observed = {
      status: git(instance, ["status", "--porcelain", "--untracked-files=normal"]),
      branch: git(instance, ["symbolic-ref", "--short", "HEAD"]),
      ahead: git(instance, ["rev-list", "--count", "origin/main..HEAD"]),
    };
    assert.ok(shape.observe(observed), `fixture did not establish ${shape.key}`);
    assert.equal(git(install, ["rev-parse", "HEAD"]), world.beforeHead);
    assert.notEqual(world.beforeHead, world.targetHead, "fixture must start behind origin");
    // Extra untracked install exhaust catches a regression to the old all-files dirty guard.
    write(join(install, "feedback.yaml"), "fixture exhaust\n");
    const before = snapshotTree(instance);
    ran = true;
    const tick = shell(root, world.launcher, world.env);
    const unchanged = JSON.stringify(before) === JSON.stringify(snapshotTree(instance));
    const afterHead = git(install, ["rev-parse", "HEAD"]);
    const calls = existsSync(world.calls) ? readFileSync(world.calls, "utf8") : "";
    const unitsConverged = existsSync(world.marker) && readFileSync(world.marker, "utf8") === "reviewed-v2\n";
    const healthy = unchanged && afterHead === world.targetHead && calls === "\n--install\n" && unitsConverged &&
      !existsSync(world.forbidden) && readFileSync(join(install, "feedback.yaml"), "utf8") === "fixture exhaust\n";
    return { shape: shape.key, ran, healthy, unchanged, unitsConverged, beforeHead: world.beforeHead,
      afterHead, targetHead: world.targetHead, detail: `${tick.stdout}${tick.stderr}`.trim() };
  } catch (error) {
    return { shape: shape.key, ran, healthy: false, detail: String(error?.stack ?? error) };
  } finally {
    ownedFixtures.delete(root);
    rmSync(root, { recursive: true, force: true });
  }
}

export function runDrill(shapes = DIRT_SHAPES) {
  assert.ok(Array.isArray(shapes) && shapes.length > 0, "fixture-only drill requires a nonempty dirt-shape table; external roots are refused");
  assert.equal(new Set(shapes.map((shape) => shape.key)).size, shapes.length, "duplicate dirt-shape key");
  for (const shape of shapes) {
    assert.ok(typeof shape.key === "string" && typeof shape.apply === "function" && typeof shape.observe === "function", "invalid dirt-shape row");
  }
  const results = shapes.map(exercise);
  return { ok: results.every((row) => row.ran && row.healthy), results };
}

export function main(argv = process.argv.slice(2), log = console.log) {
  if (argv.length === 1 && argv[0] === "--help") {
    log("Usage: node scripts/operator-dirt-drill.mjs\nDisposable local fixtures only; live flags and external install roots are refused.");
    return 0;
  }
  if (argv.length !== 0) {
    log("REFUSED: only disposable fixtures are supported; no live flag, install root or unit action is accepted.");
    return 2;
  }
  const outcome = runDrill();
  for (const row of outcome.results) log(`${row.shape}: ${!row.ran ? "UNREACHABLE" : row.healthy ? "PASS" : "FAIL"} ${JSON.stringify(row)}`);
  return outcome.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
