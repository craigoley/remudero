import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { refusalReasonKey, refusalRemedyLine } from "../src/lib/deployer.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCKER = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$REC/calls"
case "$1" in
  inspect)
    case "$*" in
      *Mounts*) printf '%s\t%s\ttrue\n' "$RMD_STATE_DIR" /home/node/Remudero
               printf '%s\t%s\ttrue\n' "$RMD_CLAUDE_DIR" /home/node/.claude ;;
      *Config.Image*) echo fixture/remudero:old ;;
      *Config.Env*) printf 'PATH=/usr/local/bin\nHOME=/home/node\nGH_TOKEN=fixture-token\n' ;;
      *Image*) echo sha256:PULLED ;;
    esac ;;
  image)
    if [ "$2" = inspect ]; then
      case "$*" in
        *Config.Env*) printf 'PATH=/usr/local/bin\nHOME=/home/node\n' ;;
        *) echo sha256:PULLED ;;
      esac
    fi ;;
  container)
    if [ "$2" = run ]; then
      cat "$REC/smoke-stdout"
      cat "$REC/smoke-stderr" >&2
      exit "$SMOKE_EXIT"
    fi ;;
esac
exit 0
`;

function recycle(t: TestContext, output: string, options: Record<string, string> = {}, code = 125) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-error-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const state = join(root, "state-root");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(bin, "docker"), DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "cash-key"), "fixture-key\n");
  writeFileSync(join(root, "smoke-stdout"), options.SMOKE_STDOUT ?? "");
  writeFileSync(join(root, "smoke-stderr"), output);
  const result = spawnSync("bash", [join(ROOT, "deploy/recycle-container.sh")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REC: root,
      SMOKE_EXIT: String(code),
      RMD_STATE_DIR: state,
      RMD_CLAUDE_DIR: join(root, "claude"),
      RMD_CODEX_DIR: join(root, "absent-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
      RMD_DAEMON_CONTAINER: "fixture-daemon",
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_SKIP_RECLAIM: "1",
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_SMOKE_TAIL_LINES: "",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "absent-dockerenv"),
      RMD_OPENWEIGHT_API_KEY_PATH: join(root, "cash-key"),
      RMD_SCRATCH: "off",
      GH_TOKEN: "fixture-token",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      ...options,
    },
  });
  assert.ifError(result.error);
  const calls = readFileSync(join(root, "calls"), "utf8").trim().split("\n");
  assert.equal(calls.filter(c => c.startsWith("container run ")).length, 1, "the smoke actually ran");
  if (code !== 0) {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(calls.filter(c => /^(stop|rm|run) /.test(c)).length, 0);
    assert.equal(existsSync(join(state, "state/PAUSE")), false);
  }
  return result;
}

function diagnostics(stderr: string): string[] {
  return stderr.split("\n").filter(line => line.startsWith("  smoke-output| "))
    .map(line => line.slice("  smoke-output| ".length));
}

test("W1-T6171: a docker-refused smoke prints docker's own error with the refusal", (t) => {
  const error = 'docker: Error response from daemon: Conflict. The container name is already in use by "abcde".';
  const out = recycle(t, error);
  assert.match(out.stderr, /smoke FAILED \(exit 125\)/);
  assert.match(out.stderr, /no WORKER-SMOKE verdict line was printed/);
  assert.deepEqual(diagnostics(out.stderr), [error]);
  assert.doesNotMatch(out.stdout, /smoke-output\|/);
});

test("W1-T6171: a long smoke output is cut to its tail and says so", (t) => {
  const lines = Array.from({ length: 30 }, (_, i) => `docker error ${i + 1}`);
  const out = recycle(t, lines.join("\n"));
  assert.deepEqual(diagnostics(out.stderr), ["(10 earlier lines omitted)", ...lines.slice(-20)]);
  const shorter = recycle(t, lines.join("\n"), { RMD_RECYCLE_SMOKE_TAIL_LINES: "3" });
  assert.deepEqual(diagnostics(shorter.stderr), ["(27 earlier lines omitted)", ...lines.slice(-3)]);
  const wide = recycle(t, ["first", "x".repeat(10_000) + "docker-cause"].join("\n"));
  const tail = diagnostics(wide.stderr);
  assert.equal(tail[0], "(1 earlier lines omitted)");
  assert.match(tail[1], /bytes omitted/);
  assert.ok(Buffer.byteLength(tail.at(-1)!) <= 8192);
  assert.ok(tail.at(-1)!.endsWith("docker-cause"));
  const wideLines = Array.from({ length: 10 }, (_, i) => `${i}${"x".repeat(999)}`);
  const byteBounded = diagnostics(recycle(t, wideLines.join("\n")).stderr);
  assert.deepEqual(byteBounded, ["(2 earlier lines omitted)", ...wideLines.slice(-8)]);
  assert.ok(Buffer.byteLength(byteBounded.slice(1).join("\n") + "\n") <= 8192);
});

test("W1-T6171: smoke output never splits the refusal reason key", () => {
  const reason = "recycle-container: REFUSING — the real worker smoke FAILED (exit 125).\n  Run the recycle again.";
  const a = `${reason}\n  smoke-output| Conflict: container abcdef is already in use\n  smoke-output| (3 earlier lines omitted)`;
  const b = `${reason}\n  smoke-output| Conflict: container fedcba is already in use\n  smoke-output| a different diagnostic`;
  assert.equal(refusalReasonKey(a), refusalReasonKey(b));
  assert.equal(refusalReasonKey(a), refusalReasonKey(reason));
  assert.equal(refusalReasonKey(`smoke-output| startup\r\n${reason.replace(/\n/g, "\r\n")}\r\n\tsmoke-output| shutdown`), refusalReasonKey(reason));
  assert.notEqual(refusalReasonKey(a), refusalReasonKey("docker pull failed"));
});

test("W1-T6171: smoke diagnostics never become the refusal remedy", () => {
  assert.equal(refusalRemedyLine("Refusal\n  Run the recycle again.\n  smoke-output| Fix the daemon"), "Run the recycle again.");
  assert.equal(refusalRemedyLine("Refusal\n  Wait for the smoke.\n  smoke-output| a diagnostic"), "Wait for the smoke.");
  assert.equal(refusalRemedyLine("  smoke-output| only diagnostics"), "(the refusal carried no message)");
});

test("W1-T6171: an empty failed smoke says it printed nothing", (t) => {
  const out = recycle(t, "");
  assert.deepEqual(diagnostics(out.stderr), ["(the smoke printed nothing)"]);
});

test("W1-T6171: invalid tail line limits retain the bounded default", (t) => {
  const lines = Array.from({ length: 25 }, (_, i) => `line ${i}`);
  for (const limit of ["0", "garbage", "-1", "00"]) {
    const out = recycle(t, lines.join("\n"), { RMD_RECYCLE_SMOKE_TAIL_LINES: limit });
    assert.deepEqual(diagnostics(out.stderr), ["(5 earlier lines omitted)", ...lines.slice(-20)]);
  }
});

test("W1-T6171: a failed verdict keeps its explanation and both output streams", (t) => {
  const out = recycle(t, "sdk crashed", { SMOKE_STDOUT: "WORKER-SMOKE FAIL unclean termination\n" }, 1);
  assert.match(out.stderr, /^  WORKER-SMOKE FAIL unclean termination$/m);
  assert.deepEqual(diagnostics(out.stderr), ["WORKER-SMOKE FAIL unclean termination", "sdk crashed"]);
});

test("W1-T6171: a successful smoke accepts the replacement without failure diagnostics", (t) => {
  const out = recycle(t, "sdk debug", { SMOKE_STDOUT: "WORKER-SMOKE PASS fixture\n" }, 0);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /worker smoke PASSED/);
  assert.deepEqual(diagnostics(out.stderr), []);
});
