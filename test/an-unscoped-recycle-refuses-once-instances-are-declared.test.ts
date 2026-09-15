/**
 * test/an-unscoped-recycle-refuses-once-instances-are-declared.test.ts — W1-T3596.
 *
 * THE DEFECT. `deploy/recycle-container.sh --instance <name>` shipped without the registry it
 * reads, so every `--instance` invocation REFUSED ("instance registry is not readable") and the
 * only working path was the legacy unscoped one. That path resolves container `remudero-daemon`,
 * `STATE_DIR` `${HOME}/rmd-state` and `DAEMON_REPO` `remudero`. Three daemons are live (core,
 * site, console), so an operator meaning site or console would have recycled CORE — and against
 * `rmd-state`, which is not even core's own state directory (it runs on `rmd-state2`).
 *
 * Every refusal below fires before any `docker` call, so this suite needs no container stubs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const REGISTRY = join(REPO_ROOT, ".remudero", "daemon-instances.yaml");

/** The seven fields `read_instance_registry` requires of every declared instance. */
const REQUIRED_FIELDS = [
  "repo",
  "state_dir",
  "container_name",
  "image",
  "claude_dir",
  "codex_dir",
  "container_config_dir",
] as const;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Never let a sandboxed runner trip the in-container guard for an unrelated reason.
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "w1t3596-no-such-dockerenv"),
      ...env,
    },
  });
}

test("W1-T3596: an unscoped recycle refuses once instances are declared", () => {
  const r = run([]);
  const err = `${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `expected refusal, got ${r.status}: ${err.slice(0, 300)}`);
  assert.match(err, /REFUSING -- no --instance given/, "must refuse the unscoped invocation by name");
  // The refusal must NAME the alternatives, or an operator cannot act on it.
  for (const name of ["core", "site", "console"]) {
    assert.ok(err.includes(name), `refusal must name the declared instance '${name}'`);
  }
});

test("W1-T3596: the refusal states what the unscoped default would have targeted", () => {
  // A refusal that hides the hazard teaches nothing. This is the whole reason the message exists:
  // the operator must see that 'no flag' meant CORE, not the instance they had in mind.
  const err = `${run([]).stderr ?? ""}`;
  assert.match(err, /remudero-daemon/, "must name the container the unscoped default resolves");
  assert.match(err, /rmd-state\b/, "must name the state dir the unscoped default resolves");
});

test("W1-T3596: an absent registry leaves the legacy unscoped path intact", () => {
  // DELIBERATELY SCOPED. This change refuses a choice the operator did not make; it must not
  // remove a path. With no registry there are no instances to name, so the legacy default stands
  // and the run proceeds to whatever the PRE-EXISTING guards say.
  const err = `${run([], { RMD_INSTANCE_REGISTRY: join(tmpdir(), "w1t3596-absent-registry.yaml") }).stderr ?? ""}`;
  assert.doesNotMatch(err, /no --instance given/, "an absent registry must not trigger the new refusal");
});

test("W1-T3596: a declared instance resolves its own container and state dir", () => {
  // The capability that did not exist before this task: site and console are addressable at all.
  const site = `${run(["--instance", "site"]).stdout ?? ""}${run(["--instance", "site"]).stderr ?? ""}`;
  assert.match(site, /remudero-site-daemon/, "site must resolve its own container");
  assert.match(site, /rmd-site-state/, "site must resolve its own state dir, never core's");
  assert.doesNotMatch(site, /container remudero-daemon\b/, "site must never resolve the core container");

  const consoleOut = `${run(["--instance", "console"]).stdout ?? ""}${run(["--instance", "console"]).stderr ?? ""}`;
  assert.match(consoleOut, /remudero-console-daemon/, "console must resolve its own container");
  assert.match(consoleOut, /remudero-console-state/, "console must resolve its own state dir");
});

test("W1-T3596: an undeclared instance is refused by name", () => {
  const r = run(["--instance", "not-a-real-instance"]);
  assert.equal(r.status, 2);
  assert.match(`${r.stderr}`, /is not declared in/, "an unknown instance must refuse, never fall back");
});

test("W1-T3596: every declared instance carries all seven required fields", () => {
  // A census, not a spot check: a registry that drops a field fails at recycle time on the host,
  // which is the worst place to discover it.
  const text = readFileSync(REGISTRY, "utf8");
  const names = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(names.sort(), ["console", "core", "site"], "the live topology is exactly these three");

  for (const name of names) {
    // Fields are the 4-space-indented keys following this name, up to the next 2-space key.
    const start = text.indexOf(`\n  ${name}:`);
    assert.ok(start >= 0, `${name} block not found`);
    const rest = text.slice(start + 1);
    const nextName = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\s*\n/);
    const block = nextName === -1 ? rest : rest.slice(0, nextName + 1);
    for (const field of REQUIRED_FIELDS) {
      assert.match(block, new RegExp(`^ {4}${field}:\\s*\\S`, "m"), `${name} is missing '${field}'`);
    }
    // An absolute-path contract the script enforces at runtime; assert it at author time too.
    for (const field of ["state_dir", "claude_dir", "codex_dir", "container_config_dir"]) {
      const m = block.match(new RegExp(`^ {4}${field}:\\s*(\\S+)`, "m"));
      assert.ok(m?.[1]?.startsWith("/"), `${name}.${field} must be an absolute path`);
    }
  }
});

test("W1-T3596: no two instances share a container or a state dir", () => {
  // The failure this whole task exists to prevent is two names pointing at one container.
  const text = readFileSync(REGISTRY, "utf8");
  for (const field of ["container_name", "state_dir"]) {
    const values = [...text.matchAll(new RegExp(`^ {4}${field}:\\s*(\\S+)`, "gm"))].map((m) => m[1]);
    assert.equal(new Set(values).size, values.length, `${field} must be unique across instances: ${values.join(", ")}`);
  }
});

test("W1-T3596: an explicit RMD_STATE_DIR is a named target and is not refused", () => {
  // The refusal is aimed at the UNNAMED default, not at the absence of a flag. A caller that sets
  // RMD_STATE_DIR has said which state directory to act on, so refusing it would break scoping by
  // environment — which existing suites rely on. Asserted because it is a deliberate boundary, not
  // an accident of the condition's shape.
  const err = `${run([], { RMD_STATE_DIR: join(tmpdir(), "w1t3596-explicit-state") }).stderr ?? ""}`;
  assert.doesNotMatch(err, /no --instance given/, "an explicitly named state dir must not be refused");
});
