import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "deploy/recycle-container.sh");
const BASH = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";
const DAEMON = "remudero-console-daemon";
const SMOKE = `${DAEMON}-worker-smoke`;
type Row = { id: string; name: string; state: string };

// The real recycler runs against a persistent container table. Docker's substring filter and
// name-conflict exit are modeled independently of the recycler's cleanup decisions.
const DOCKER = `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.REC;
const table = path.join(root, "containers.json");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls"), JSON.stringify(args) + "\n");
let rows = JSON.parse(fs.readFileSync(table, "utf8"));
const save = () => fs.writeFileSync(table, JSON.stringify(rows));
const named = rows.find(r => r.name === args.at(-1) || r.id === args.at(-1));
const value = flag => args[args.indexOf(flag) + 1];
if (args[0] === "ps") {
  if (args.includes("-aq")) rows.forEach(r => console.log(r.id));
  else {
    const filter = value("--filter").replace(/^name=/, "");
    rows.filter(r => r.name.includes(filter)).forEach(r => console.log(r.id, r.name, r.state));
  }
} else if (args[0] === "container" && args[1] === "run") {
  const name = value("--name");
  if (rows.some(r => r.name === name)) {
    console.error("Conflict. The container name is already in use: " + name);
    process.exit(125);
  }
  console.log("WORKER-SMOKE PASS fixture");
  if (process.env.LEAVE_AFTER_SMOKE === "1") {
    rows.push({id: "c-after", name, state: "exited"});
    save();
  }
} else if (args[0] === "container" && args[1] === "rm") {
  if (!named) process.exit(1);
  if (named.state === "running" || process.env.REFUSE_RM === "1") process.exit(1);
  rows = rows.filter(r => r.id !== named.id);
  save();
} else if (args[0] === "stop") {
  named.state = "exited";
  save();
} else if (args[0] === "rm") {
  rows = rows.filter(r => r.id !== named.id);
  save();
} else if (args[0] === "run") {
  rows.push({id: "c-new", name: value("--name"), state: "running"});
  save();
} else if (args[0] === "inspect") {
  const format = args.includes("--format") ? value("--format") : "";
  if (!named) process.exit(1);
  if (format.includes("Mounts")) {
    console.log(process.env.RMD_STATE_DIR + "\t/home/node/Remudero\ttrue");
    console.log(process.env.RMD_CLAUDE_DIR + "\t/home/node/.claude\ttrue");
  } else if (format.includes("State.Running")) {
    for (const ref of args.slice(args.indexOf("--format") + 2)) {
      const row = rows.find(r => r.id === ref || r.name === ref);
      if (row) console.log("sha256:PULLED /" + row.name + " " + (row.state === "running"));
    }
  } else if (format.includes("Image")) console.log("sha256:PULLED");
} else if (args[0] === "image") {
  if (args[1] === "inspect" && args.includes("--format") && !value("--format").includes("Env"))
    console.log("sha256:PULLED");
  if (args[1] === "prune") console.log("Total reclaimed space: 0B");
}
`;

function recycle(state: string | null, options: Record<string, string> = {}, near = false) {
  const root = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}stale-smoke-`));
  const bin = join(root, "bin");
  const stateDir = join(root, "state-root");
  mkdirSync(bin);
  mkdirSync(stateDir);
  const rows: Row[] = [{ id: "c-daemon", name: DAEMON, state: "running" }];
  if (state) rows.push({ id: "c-smoke", name: SMOKE, state });
  if (near) rows.push({ id: "c-near", name: `${SMOKE}-old`, state: "created" });
  writeFileSync(join(root, "containers.json"), JSON.stringify(rows));
  writeFileSync(join(bin, "docker"), DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(root, "cash-key"), "fixture-key\n");
  const pause = join(stateDir, "state/PAUSE");
  if (options.OPERATOR_PAUSE) {
    mkdirSync(dirname(pause));
    writeFileSync(pause, options.OPERATOR_PAUSE);
  }
  const result = spawnSync(BASH, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      REC: root,
      RMD_STATE_DIR: stateDir,
      RMD_CLAUDE_DIR: join(root, "claude"),
      RMD_CODEX_DIR: join(root, "absent-codex"),
      RMD_CONTAINER_CONFIG_DIR: join(root, "absent-config"),
      RMD_DAEMON_CONTAINER: DAEMON,
      RMD_RECYCLE_FIRST_BOOT: "1",
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_DOCKERENV_PATH: join(root, "absent-dockerenv"),
      RMD_OPENWEIGHT_API_KEY_PATH: join(root, "cash-key"),
      GH_TOKEN: "fixture-token",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      ...options,
    },
  });
  assert.ifError(result.error);
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    calls: readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]),
    rows: JSON.parse(readFileSync(join(root, "containers.json"), "utf8")) as Row[],
    pause: existsSync(pause) ? readFileSync(pause, "utf8") : null,
  };
}

type Outcome = ReturnType<typeof recycle>;
const smokeRuns = (out: Outcome) => out.calls.filter(c => c[0] === "container" && c[1] === "run");
const smokeRemovals = (out: Outcome) => out.calls.filter(c => c[0] === "container" && c[1] === "rm");

function assertRefused(out: Outcome, state: string) {
  assert.equal(out.status, 1, out.output);
  assert.match(out.output, /REFUSING/);
  assert.ok(out.output.includes(`${SMOKE} (${state})`), out.output);
  assert.ok(out.output.includes(`docker rm ${SMOKE}`), out.output);
  assert.equal(smokeRuns(out).length, 0, "a blocked cleanup must refuse before trying the smoke");
  assert.equal(out.calls.filter(c => ["stop", "rm", "run"].includes(c[0])).length, 0);
  assert.deepEqual(out.rows.find(r => r.id === "c-daemon"), { id: "c-daemon", name: DAEMON, state: "running" });
  assert.equal(out.pause, null, "the refusal must clear this recycle's pause");
  assert.match(out.output, /pause removed/);
}

test("W1-T6172: a created leftover smoke is removed before the smoke and named", () => {
  const out = recycle("created");
  assert.equal(out.status, 0, out.output);
  const rmAt = out.calls.findIndex(c => c[0] === "container" && c[1] === "rm");
  const runAt = out.calls.findIndex(c => c[0] === "container" && c[1] === "run");
  assert.ok(rmAt >= 0 && rmAt < runAt, JSON.stringify(out.calls));
  assert.deepEqual(smokeRemovals(out), [["container", "rm", "c-smoke"]]);
  assert.ok(out.output.includes(`removed leftover ${SMOKE} (created) before the smoke`), out.output);
  assert.match(out.output, /worker smoke PASSED/);
  assert.ok(!out.rows.some(r => r.name === SMOKE));
  assert.equal(out.pause, null);
});

test("W1-T6172: a running smoke of the same name refuses the recycle untouched", () => {
  const out = recycle("running");
  assertRefused(out, "running");
  assert.deepEqual(smokeRemovals(out), []);
  assert.deepEqual(out.rows.find(r => r.id === "c-smoke"), { id: "c-smoke", name: SMOKE, state: "running" });
});

test("W1-T6172: a container whose name only contains the smoke name is left alone", () => {
  const out = recycle("created", {}, true);
  assert.equal(out.status, 0, out.output);
  assert.deepEqual(smokeRemovals(out), [["container", "rm", "c-smoke"]]);
  assert.deepEqual(out.rows.find(r => r.id === "c-near"), { id: "c-near", name: `${SMOKE}-old`, state: "created" });
  assert.match(out.output, /worker smoke PASSED/);
});

test("W1-T6172: an unremovable leftover refuses and clears its pause without force", () => {
  const out = recycle("exited", { REFUSE_RM: "1" });
  assertRefused(out, "exited");
  assert.deepEqual(smokeRemovals(out), [["container", "rm", "c-smoke"]]);
  assert.equal(out.rows.find(r => r.id === "c-smoke")?.state, "exited");
});

test("W1-T6172: no exact leftover proceeds silently without touching a substring match", () => {
  const out = recycle(null, {}, true);
  assert.equal(out.status, 0, out.output);
  assert.deepEqual(smokeRemovals(out), []);
  assert.doesNotMatch(out.output, /removed leftover|could not remove leftover/);
  assert.equal(smokeRuns(out).length, 1);
  assert.equal(out.rows.find(r => r.id === "c-near")?.state, "created");
});

test("W1-T6172: pre-smoke cleanup still runs when reclaim is skipped", () => {
  const out = recycle("created", { RMD_RECYCLE_SKIP_RECLAIM: "1" });
  assert.equal(out.status, 0, out.output);
  assert.deepEqual(smokeRemovals(out), [["container", "rm", "c-smoke"]]);
  assert.match(out.output, /worker smoke PASSED/);
  assert.match(out.output, /reclaim SKIPPED/);
});

test("W1-T6172: the shared cleanup also removes a leftover before reclaim", () => {
  const out = recycle(null, { LEAVE_AFTER_SMOKE: "1" });
  assert.equal(out.status, 0, out.output);
  assert.deepEqual(smokeRemovals(out), [["container", "rm", "c-after"]]);
  const rmAt = out.calls.findIndex(c => c[0] === "container" && c[1] === "rm");
  const pruneAt = out.calls.findIndex(c => c[0] === "image" && c[1] === "prune");
  assert.ok(rmAt >= 0 && pruneAt > rmAt);
  assert.ok(!out.rows.some(r => r.name === SMOKE));
});

test("W1-T6172: a refusal preserves an operator's existing pause", () => {
  const pause = '{"reason":"operator hold"}\n';
  const out = recycle("running", { OPERATOR_PAUSE: pause });
  assert.equal(out.status, 1, out.output);
  assert.equal(out.pause, pause);
  assert.deepEqual(smokeRemovals(out), []);
  assert.equal(smokeRuns(out).length, 0);
});
