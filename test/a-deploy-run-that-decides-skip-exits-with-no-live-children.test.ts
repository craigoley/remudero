import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { daemonInstanceRegistryPath } from "#src/lib/deployer.js";
import { ghShim } from "#test/helpers/gh-shim.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function fixture(t: TestContext, primary = false) {
  const root = mkdtempSync(join(tmpdir(), "rmd-deploy-exit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const github = ghShim([{ when: "", exit: 1 }], { kind: "deploy-exit" });
  t.after(() => rmSync(github.dir, { recursive: true, force: true }));
  const stateRoot = join(root, "instance");
  const installPath = join(stateRoot, "daemon-install");
  const bin = join(root, "bin");
  for (const dir of [bin, join(root, "tmp"), join(installPath, ".git"), join(stateRoot, "state")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(stateRoot, "state/ledger.ndjson"), JSON.stringify({
    ts: new Date().toISOString(), step: "daemon.boot", head_sha: "1111111111111111111111111111111111111111",
  }) + "\n");
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("git", `case " $* " in
    *" symbolic-ref "*) echo main ;;
    *" rev-parse "*) echo 1111111111111111111111111111111111111111 ;;
    *" rev-list "*) echo 0 ;;
    *" remote "*) echo https://example.invalid/fixture.git ;;
  esac`);
  stub("docker", `echo "$*" >> '${root}/docker-calls'; exit 1`);
  stub("launchctl", 'case "$1" in print) echo "pid = 12345" ;; list) echo \'"PID" = 12345;\' ;; *) exit 1 ;; esac');
  if (primary) {
    const registry = daemonInstanceRegistryPath(installPath);
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, `instances:\n  fixture:\n    state_dir: ${stateRoot}\n    primary: true\n    container_name: fixture-daemon\n`);
  }
  return { root, stateRoot, installPath, bin, stub, env: {
    ...process.env, HOME: root, TMPDIR: root, GH_TOKEN: "fixture-token",
    RMD_SELF_SYNC_DONE: "1", PATH: `${bin}:${github.dir}:${process.env.PATH ?? ""}`,
  } };
}

function sessionMembers(session: number): string[] {
  const found: string[] = [];
  for (const pid of readdirSync("/proc").filter(p => /^[0-9]+$/.test(p))) {
    let stat: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
    catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields[3] === String(session)) found.push(`${pid} ${fields[1]} ${fields[0]}`);
  }
  return found;
}

async function run(h: ReturnType<typeof fixture>, args: string[], boundMs: number, expectedCode = 0) {
  const started = Date.now();
  const child = spawn(args[0]!, args.slice(1), { cwd: REPO_ROOT, env: h.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", expired = false;
  child.stdout.on("data", b => { output += String(b); });
  child.stderr.on("data", b => { output += String(b); });
  const guard = setTimeout(() => {
    expired = true;
    if (child.pid !== undefined) {
      for (const row of sessionMembers(child.pid)) {
        try { process.kill(Number(row.split(" ")[0]), "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  }, boundMs);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => clearTimeout(guard));
  assert.equal(expired, false, `child exceeded ${boundMs}ms: ${output}`);
  assert.equal(code, expectedCode, output);
  let members = sessionMembers(child.pid!);
  while (members.length > 0 && Date.now() - started < boundMs) {
    await new Promise(resolve => setTimeout(resolve, 10));
    members = sessionMembers(child.pid!);
  }
  assert.deepEqual(members, [], "no live or zombie process remains in the owned session within the bound");
  return output;
}

const cli = (h: ReturnType<typeof fixture>) => [join(REPO_ROOT, "bin/rmd"), "deploy-run", "--image-drift-only", "--state-root", h.stateRoot];
const rows = (h: ReturnType<typeof fixture>) => readFileSync(join(h.stateRoot, "state/ledger.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));

test("W1-T9921: a skip-deciding deploy-run exits with no live or zombie children", { timeout: 3_100_000, skip: process.platform !== "linux" }, async t => {
  const variants = [fixture(t), fixture(t, true)];
  for (let i = 0; i < 50; i++) {
    const h = variants[i % variants.length]!;
    await run(h, cli(h), 60_000);
    const skips = rows(h).filter(row => row.step === "deploy.skip");
    assert.equal(skips.length, Math.floor(i / variants.length) + 1);
    assert.match(skips.at(-1).reason, /^up-to-date/);
  }
  assert.match(readFileSync(join(variants[1]!.root, "docker-calls"), "utf8"), /inspect remudero-serve/);
  t.diagnostic("50/50 skips (25 per variant) exited within 60s with empty sessions");
});

test("W1-T9921: a deploy-run records that it reached exit", { timeout: 65_000, skip: process.platform !== "linux" }, async t => {
  const h = fixture(t, true);
  await run(h, cli(h), 60_000);
  const ledger = rows(h);
  const skip = ledger.find(row => row.step === "deploy.skip");
  const exits = ledger.filter(row => row.step === "deploy.exit_requested");
  assert.ok(skip);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].actor_pid, skip.actor_pid);
  assert.equal(exits[0].exit_code, 0);
  assert.equal(ledger.at(-1).step, "deploy.exit_requested");
});

test("W1-T9921: unwritable exit evidence is reported without stranding a skip", { timeout: 65_000, skip: process.platform !== "linux" }, async t => {
  const h = fixture(t, true);
  const ledger = join(h.stateRoot, "state/ledger.ndjson");
  rmSync(ledger);
  mkdirSync(ledger);
  const output = await run(h, cli(h), 60_000);
  assert.match(output, /deploy.skip/);
  assert.match(output, /deploy.exit_requested could not be recorded:.*EISDIR/);
});

// @source-text-subject: execute the installer's rendered watchdog shell in an isolated session.
test("W1-T9921: the pre-kill observer records thread stat and wchan", { timeout: 10_000, skip: process.platform !== "linux" }, async t => {
  const h = fixture(t);
  const source = readFileSync(join(REPO_ROOT, "deploy/install-host-units.sh"), "utf8");
  const renderer = source.match(/render_watchdog_deploy_deadline\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(renderer);
  const rendered = await run(h, ["bash", "-c", `${renderer}\nrender_watchdog_deploy_deadline`], 5_000);
  const shell = rendered.replace("WATCHDOG_DEPLOY_DEADLINE_S=3600", "WATCHDOG_DEPLOY_DEADLINE_S=2");
  const output = await run(h, ["bash", "-c", `${shell}\nwatchdog_deploy_run /bin/sleep 3`], 5_000, 124);
  assert.match(output, /thread [0-9]+ stat: [0-9]+ \(/);
  assert.match(output, /thread [0-9]+ wchan: /);
});

test("W1-T9921: a hung deploy exec ends at its timeout and fails", { timeout: 370_000, skip: process.platform !== "linux" }, async t => {
  for (const kind of ["deploy", "serve"]) {
    const h = fixture(t, true);
    const command = kind === "deploy" ? "git" : "docker";
    const original = readFileSync(join(h.bin, command), "utf8");
    h.stub(command, `case " $* " in *" ${kind === "deploy" ? "fetch" : "inspect"} "*)
      exec '${process.execPath}' -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)' ;;
    esac\n${original.slice(original.indexOf("\n") + 1)}`);
    const code = `
      import assert from 'node:assert/strict';
      console.log('${kind}: importing');
      const { realDeployDeps } = await import('#src/lib/deployer.js');
      const { realServePolicyDeps } = await import('#src/lib/serve-policy-convergence.js');
      console.log('${kind}: ready');
      const opts = ${JSON.stringify({ installPath: h.installPath, stateRoot: h.stateRoot, daemonLabel: "fixture", uid: 0 })};
      const start = Date.now();
      if (${JSON.stringify(kind)} === 'deploy') {
        const deps = realDeployDeps(opts);
        assert.throws(() => deps.fetch(), error => error.code === 'ETIMEDOUT' && error.signal === 'SIGKILL');
      } else {
        const deps = realServePolicyDeps(opts);
        const result = deps.serveImageDrift();
        assert.equal(result.kind, 'unknown');
        assert.match(result.reason, /ETIMEDOUT/);
      }
      assert.ok(Date.now() - start >= 120000, 'the approved timeout was exercised');
      console.log('${kind}: failure reported after ' + (Date.now() - start) + 'ms');
      process.exit(0);
    `;
    const output = await run(h, [process.execPath, "--import", "tsx", "--input-type=module", "-e", code], 180_000);
    t.diagnostic(output.trim());
  }
});
