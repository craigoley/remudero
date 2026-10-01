/**
 * The supervisor's container entry (src/lib/serve-supervisor-main.ts) and its launch in
 * deploy/serve-container.sh (arch-phase3-design.md §5, P3-07).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashInstallInputs, installHashMarkerPath } from "../src/lib/install-hash.js";
import { runServeSupervisor, serveArgsOf } from "../src/lib/serve-supervisor-main.js";
import type { ServeSupervisor, ServeSupervisorOptions } from "../src/lib/serve-supervisor.js";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "deploy", "serve-container.sh");

test("the supervisor entry passes serve its own arguments and makes the cold checkout's install fresh", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}cold-`));
  writeFileSync(join(repoDir, "package.json"), "{}\n");
  writeFileSync(join(repoDir, "package-lock.json"), "lock");
  const gensDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}gens-`));
  const ran: string[] = [];
  const logged: string[] = [];
  const signals = new Map<string, () => void>();
  let built: ServeSupervisorOptions | undefined;
  const calls: string[] = [];
  const fake: ServeSupervisor = {
    start: async () => void calls.push("start"),
    requestHandoff: async () => {},
    shutdown: async (reason) => void calls.push(`shutdown ${reason}`),
    activeSha: () => undefined,
  };
  const supervisor = await runServeSupervisor(["--", "serve", "--host", "0.0.0.0", "--port", "4317"], {
    env: { RMD_SERVE_GENS_DIR: gensDir },
    cwd: repoDir,
    run: async (command, args, cwd) => {
      ran.push(`${command} ${args.join(" ")} @${cwd}`);
      if (command === "npm") {
        mkdirSync(join(cwd, "node_modules"), { recursive: true });
      }
      return "";
    },
    headSha: () => "abc123",
    log: (step) => void logged.push(step),
    create: (opts) => ((built = opts), fake),
    onSignal: (signal, handler) => void signals.set(signal, handler),
  });
  assert.equal(supervisor, fake);
  assert.deepEqual(built?.coldSlot, { dir: repoDir, sha: "abc123", deps: "installed" }, "a cold checkout with no install marker is installed before it serves");
  assert.ok(ran.some((r) => r === `npm ci --no-audit --no-fund @${repoDir}`));
  assert.equal(readFileSync(installHashMarkerPath(repoDir), "utf8"), hashInstallInputs(repoDir));
  assert.deepEqual(built?.serveArgs, ["serve", "--host", "0.0.0.0", "--port", "4317"]);
  assert.equal(built?.handoffEnabled?.(), true);
  writeFileSync(join(gensDir, "handoff.off"), "");
  assert.equal(built?.handoffEnabled?.(), false, "the kill switch file is read from the generations directory");
  assert.equal(typeof built?.prepare, "function");
  assert.deepEqual(calls, ["start"]);
  assert.deepEqual(logged, ["serve.supervisor_start"]);
  signals.get("SIGTERM")?.();
  signals.get("SIGINT")?.();
  assert.deepEqual(calls, ["start", "shutdown sigterm", "shutdown sigint"], "docker stop drains the active generation");
});

test("serve's arguments are everything after the separator", () => {
  assert.deepEqual(serveArgsOf(["--", "serve", "--port", "1"]), ["serve", "--port", "1"]);
  assert.deepEqual(serveArgsOf(["serve", "--port", "1"]), ["serve", "--port", "1"]);
  assert.deepEqual(serveArgsOf([]), ["serve"]);
  assert.deepEqual(serveArgsOf(["--"]), ["serve"]);
});

function dryRun(env: Record<string, string>, args: string[] = []): { status: number | null; out: string } {
  const root = mkdtempSync(join(tmpdir(), "rmd-supervisor-launch-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(root, "code"), { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\nif [ "\${1:-}" = network ] && [ "\${2:-}" = inspect ]; then exit 0; fi\nexit 1\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const result = spawnSync("bash", [SCRIPT, "--dry-run", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: root,
      GH_TOKEN: "test-token",
      RMD_STATE_DIR: join(root, "state"),
      RMD_SERVE_REPO_DIR: join(root, "code"),
      RMD_SERVE_DOCKER_NETWORK: "rmd-test-net",
      RMD_SERVE_DOCKERENV_PATH: join(root, "no-dockerenv"),
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test("the core gateway launches under the serve supervisor with its generations mounted", () => {
  const on = dryRun({ RMD_SERVE_GENS_DIR: "/host/gens" });
  assert.equal(on.status, 0, on.out);
  assert.match(on.out, /-v \/host\/gens:\/home\/node\/rmd-serve-gens -e RMD_SERVE_GENS_DIR=\/home\/node\/rmd-serve-gens/);
  assert.match(on.out, /exec node --import \/app\/node_modules\/tsx\/dist\/loader\.mjs \/app\/src\/lib\/serve-supervisor-main\.ts -- serve --host 0\.0\.0\.0 --port 4317/);
  assert.match(on.out, /no serve supervisor; serving directly' >&2; exec \.\/bin\/rmd serve --host 0\.0\.0\.0 --port 4317/, "an image built before the supervisor still serves");

  const off = dryRun({ RMD_SERVE_SUPERVISOR: "off" });
  assert.equal(off.status, 0, off.out);
  assert.doesNotMatch(off.out, /rmd-serve-gens|serve-supervisor-main/, "RMD_SERVE_SUPERVISOR=off is today's launch, exactly");
  assert.match(off.out, /remudero:latest \.\/bin\/rmd serve --host 0\.0\.0\.0 --port 4317/);
});
