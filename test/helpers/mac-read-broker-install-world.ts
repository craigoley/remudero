import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { GH_BROKER_HEARTBEAT, ghBrokerDir } from "#src/lib/gh-read-broker-client.js";
import { GH_BROKER_LAUNCH_AGENT } from "#src/lib/gh-read-broker-watch.js";
import { GH_BROKER_HEARTBEAT_INTERVAL_S } from "#src/lib/gh-read-broker.js";
import { gitRepo, type GitRepo } from "#test/helpers/git-repo.js";
import { ownedFixtureDir } from "#test/helpers/owned-fixture-dir.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// The fake account the Mac read broker installer's suites share (W1-T12938 built it; W1-T13171 moved it here so
// a second suite drives the same stand-in instead of a copy). The REAL installer runs under /bin/bash (3.2 on a
// Mac, 5 in CI) against a fake HOME: a stub `launchctl` first on PATH records each call and, on bootstrap, runs
// the agent file's program once the way launchd would. No real launchd, no real ~/Library, no real broker.

export const MAC_BROKER_INSTALLER = join(REPO_ROOT, "deploy/mac/install-gh-read-broker.sh");
export const MAC_BROKER_LABEL = "com.remudero.gh-read-broker";

/** In the stub's state directory: how many more `launchctl print` calls a stopped service stays listed for, one
 *  line per stop (the last line serves every later stop); `never` keeps it listed for good. Absent: a stop is instant. */
export const STOP_TAKES_POLLS = "stop-takes-polls";

const LAUNCHCTL_STUB = `#!/bin/bash
# Stands in for launchd. Records each call; on bootstrap it notes which copies exist at that moment, then
# runs the agent file's program once, as launchd would start it.
# W1-T13171: it also keeps whether launchd LISTS the service, which is what \`launchctl print\` answers and what
# decides a bootstrap. On the real one a bootout returns before the service is gone, and a bootstrap while it
# is still listed fails with "5: Input/output error" (measured on the operator Mac, 2026-11-16).
#   loaded   the service was bootstrapped and not stopped since.
#   going    it was stopped and is still listed: the number of \`print\` calls it stays listed for, or "never".
state="$STUB_STATE"
printf '%s\\n' "$*" >> "$state/calls"
case "\${1:-}" in
  print-disabled)
    [ ! -f "$state/disabled" ] || cat "$state/disabled"
    exit 0 ;;
  bootout)
    # Always returns at once. Without ${STOP_TAKES_POLLS} the service is gone at once too.
    if [ -f "$state/loaded" ]; then
      rm -f "$state/loaded"
      if [ -f "$state/${STOP_TAKES_POLLS}" ]; then
        sed -n '1p' "$state/${STOP_TAKES_POLLS}" > "$state/going"
        if [ -n "$(sed -n '2p' "$state/${STOP_TAKES_POLLS}")" ]; then
          sed '1d' "$state/${STOP_TAKES_POLLS}" > "$state/${STOP_TAKES_POLLS}.next"
          mv -f "$state/${STOP_TAKES_POLLS}.next" "$state/${STOP_TAKES_POLLS}"
        fi
      fi
    fi
    exit 0 ;;
  print)
    [ ! -f "$state/loaded" ] || exit 0
    if [ -f "$state/going" ]; then
      left="$(cat "$state/going")"
      [ "$left" != never ] || exit 0
      if [ "$left" -gt 0 ]; then printf '%s\\n' "$(( left - 1 ))" > "$state/going"; exit 0; fi
      rm -f "$state/going"
    fi
    echo "Could not find service \\"\${2##*/}\\" in domain for user gui" >&2
    exit 113 ;;
  bootstrap)
    nth="$(grep -c '^bootstrap ' "$state/calls")"
    ls -A "$HOME/Library/Application Support/remudero/gh-read-broker" > "$state/copies-at-bootstrap.$nth" 2>/dev/null
    # A service launchd still lists cannot be started: only a \`print\` that failed has cleared "going".
    if [ -f "$state/bootstrap-fails" ] || [ -f "$state/loaded" ] || [ -f "$state/going" ]; then echo 'Bootstrap failed: 5: Input/output error' >&2; exit 5; fi
    : > "$state/loaded"
    program="$(sed -n '/<key>ProgramArguments<\\/key>/,/<\\/array>/p' "$3" | sed -n 's/.*<string>\\(.*\\)<\\/string>.*/\\1/p' | sed -n '1p')"
    "$program" gh-broker serve >> "$state/agent.out" 2>&1 || true
    exit 0 ;;
esac
exit 0
`;

// The fixture checkout's bin/rmd is the real launcher's last line: it runs the entry through node_modules.
const FIXTURE_RMD = `#!/bin/bash
DIR="$(cd -P "$(dirname "$0")/.." && pwd -P)"
exec "$DIR/node_modules/.bin/tsx" "$DIR/src/run-task.ts" "$@"
`;

// Stands in for tsx running the broker: it needs the policy file the real CLI reads as it loads, refuses an
// entry marked BROKEN, and writes the heartbeat the way the broker does (a new file renamed into place).
const FIXTURE_TSX = `#!/bin/bash
entry="$1"
root="$(cd -P "$(dirname "$entry")/.." && pwd -P)"
[ "\${2:-} \${3:-}" = "gh-broker serve" ] || exit 64
[ -f "$root/plan/policy.yaml" ] || { echo "no policy file in $root" >&2; exit 1; }
if grep -q BROKEN "$entry"; then echo "the broker cannot start" >&2; exit 1; fi
mkdir -p "$HOME/.cache/remudero/gh-broker"
printf '${GH_BROKER_HEARTBEAT_INTERVAL_S}\\n' > "$HOME/.cache/remudero/gh-broker/heartbeat.tmp"
mv -f "$HOME/.cache/remudero/gh-broker/heartbeat.tmp" "$HOME/.cache/remudero/gh-broker/heartbeat"
printf '%s\\n' "$root" >> "$STUB_STATE/served-from"
`;

export interface BrokerInstallWorld {
  home: string;
  state: string;
  copies: string;
  plist: string;
  heartbeat: string;
  env: NodeJS.ProcessEnv;
}

export interface InstallerRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function executable(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** A fake account: its HOME, the stub tools first on PATH, and a pace root of its own. */
export function brokerInstallWorld(t: TestContext): BrokerInstallWorld {
  const root = ownedFixtureDir(t, "broker-install").dir;
  const home = join(root, "home");
  const bin = join(root, "bin");
  const state = join(root, "stub");
  for (const dir of [home, bin, state]) mkdirSync(dir);
  executable(join(bin, "launchctl"), LAUNCHCTL_STUB);
  executable(join(bin, "codex"), "#!/bin/bash\necho 'codex-cli 0.0.0-fixture'\n");
  if (process.platform !== "darwin") {
    // The pace directory's ACL calls are BSD forms (`chmod +a`, `ls -lde`). Off a Mac two shims keep that
    // unchanged step running: the ACL entry is kept in a file and listed back. Every other call is the real tool.
    const real = (tool: string): string => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    executable(join(bin, "chmod"), `#!/bin/bash\nif [ "\${1:-}" = "+a" ]; then printf '%s\\n' "$2" >> "$3/.acl"; exit 0; fi\nexec ${real("chmod")} "$@"\n`);
    executable(join(bin, "ls"), `#!/bin/bash\nif [ "\${1:-}" = "-lde" ]; then ${real("ls")} -ld "$2" || exit 1; [ ! -f "$2/.acl" ] || sed 's/^/ 0: /' "$2/.acl"; exit 0; fi\nexec ${real("ls")} "$@"\n`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, STUB_STATE: state,
    REMUDERO_GH_PACE_ROOT: join(root, "shared", "gh-pace"),
  };
  delete env.REMUDERO_RMD_BIN;
  delete env.REMUDERO_GH_LOGIN;
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[name];
  return {
    home, state, env,
    copies: join(home, "Library/Application Support/remudero/gh-read-broker"),
    plist: join(home, GH_BROKER_LAUNCH_AGENT),
    heartbeat: join(ghBrokerDir({ HOME: home })!, GH_BROKER_HEARTBEAT),
  };
}

/** A small checkout shaped like this one: a launcher, an entry, a policy file, a test tree, and installed (untracked) dependencies. */
export function brokerSource(t: TestContext): GitRepo {
  const source = gitRepo({ scope: t, kind: "broker-source", seedCommit: false });
  executable(join(source.dir, "bin/rmd"), FIXTURE_RMD);
  executable(join(source.dir, "node_modules/.bin/tsx"), FIXTURE_TSX);
  for (const [path, text] of [
    ["src/run-task.ts", "// v1\n"], ["plan/policy.yaml", "values: {}\n"], ["test/a.test.ts", "// never copied\n"],
    ["package.json", "{}\n"], [".gitignore", "node_modules\n"],
  ] as const) {
    mkdirSync(dirname(join(source.dir, path)), { recursive: true });
    writeFileSync(join(source.dir, path), text);
  }
  commit(source, "v1");
  return source;
}

/** Commits everything tracked or new in the fixture and returns the commit's sha. */
function commit(source: GitRepo, message: string): string {
  source.git("add", ".");
  source.git("commit", "--quiet", "-m", message);
  return source.git("rev-parse", "HEAD");
}

/** Rewrites the fixture's entry and commits it: a new source sha. `BROKEN` in the text makes the stub broker fail. */
export function nextBrokerVersion(source: GitRepo, text: string): string {
  writeFileSync(join(source.dir, "src/run-task.ts"), `// ${text}\n`);
  return commit(source, text);
}

/** Runs the real installer from the fixture checkout as the fake account. */
export function installBroker(w: BrokerInstallWorld, source: GitRepo, ...args: string[]): InstallerRun {
  const r = spawnSync("/bin/bash", [MAC_BROKER_INSTALLER, "--rmd", join(source.dir, "bin/rmd"), "--login", "octo", ...args], { encoding: "utf8", env: w.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** The same run, killed after `timeoutMs`: an installer that waits without a bound comes back with a null status. */
export function installBrokerWithin(w: BrokerInstallWorld, source: GitRepo, timeoutMs: number, ...args: string[]): InstallerRun {
  const r = spawnSync("/bin/bash", [MAC_BROKER_INSTALLER, "--rmd", join(source.dir, "bin/rmd"), "--login", "octo", ...args], { encoding: "utf8", env: w.env, timeout: timeoutMs, killSignal: "SIGKILL" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** One call of the stand-in service manager itself, as the fake account: its exit status and what it said. */
export function launchctl(w: BrokerInstallWorld, ...args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8", env: w.env });
  return { status: r.status, stderr: r.stderr };
}

/** The program the installed agent file runs: its first ProgramArguments string. */
export function agentProgram(w: BrokerInstallWorld): string {
  const args = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(readFileSync(w.plist, "utf8"));
  assert.ok(args, "the agent file names a program");
  return args[1]!;
}

export const fileLines = (path: string): string[] => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
export const launchctlCalls = (w: BrokerInstallWorld): string[] => fileLines(join(w.state, "calls"));
/** The copy the stub broker last served from, as launchd would have started it. */
export const lastServedFrom = (w: BrokerInstallWorld): string | undefined => fileLines(join(w.state, "served-from")).at(-1);

/** Every path under `dir` with its size and modification time: what a run that "changes nothing" must leave equal. */
export function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const st = lstatSync(path);
      out.push(`${path} ${st.isDirectory() ? "dir" : `${st.size} ${st.mtimeMs}`}`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out;
}
