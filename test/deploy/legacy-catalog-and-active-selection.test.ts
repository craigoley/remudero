import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { daemonCommand } from "#src/cli/commands/daemon.js";
import { instanceMode, readInstanceRegistryText } from "#src/lib/instance-mode.js";
import { assertInstanceRegistryWorkerEnvironment, withInstanceRegistryRuntime } from "#src/lib/instance-registry-selection.js";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rmd-catalog-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = join(root, "selected.yaml"), catalog = join(root, "catalog.yaml");
  const registry = (mode: string) => `instances:\n  fixture:\n    github_repo: owner/repo\n    mode: ${mode}\n`;
  mkdirSync(join(root, ".remudero"));
  writeFileSync(join(root, ".remudero/daemon-instances.yaml"), registry("live"));
  writeFileSync(catalog, registry("live"), { mode: 0o600 });
  writeFileSync(selected, registry("shadow"), { mode: 0o600 });
  const keys = ["RMD_SELECTED_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY", "RMD_INSTANCE_NAME",
    "RMD_INSTANCE_REGISTRY_DIGEST", "RMD_INSTANCE_REGISTRY_FILE_BINDING", "RMD_INSTANCE_REGISTRY_LAUNCH_BINDING"];
  const previous = keys.map(key => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return { root, selected, catalog };
}

test("private registry selection reaches real host and daemon readers: distinct catalog and selection at daemon entry", async t => {
  const f = fixture(t), boundary = new Error("contained command host");
  process.env.RMD_INSTANCE_REGISTRY = f.catalog;
  process.env.RMD_SELECTED_INSTANCE_REGISTRY = f.selected;
  let reached = 0, mode: string | undefined;
  const host = new Proxy({}, { get: () => {
    reached++;
    mode = instanceMode("owner/repo", readInstanceRegistryText(f.root));
    throw boundary;
  } });
  await assert.rejects(() => daemonCommand([], {}, host as Parameters<typeof daemonCommand>[2]), error => error === boundary);
  assert.ok(reached > 0, "the real command reaches its contained host");
  assert.equal(mode, "shadow", "the active reader must use selection rather than the live legacy catalog");
  delete process.env.RMD_SELECTED_INSTANCE_REGISTRY;
  await assert.rejects(() => daemonCommand([], {}, host as Parameters<typeof daemonCommand>[2]), error => error === boundary);
  assert.equal(mode, "live", "the old variable remains a compatibility fallback when the new name is absent");
});

test("private registry selection preserves legacy and refuses unknown selected inputs: invalid new name cannot borrow a healthy catalog", async t => {
  const f = fixture(t);
  process.env.RMD_INSTANCE_REGISTRY = f.catalog;
  let operations = 0;
  await withInstanceRegistryRuntime(() => { operations++; });
  assert.equal(operations, 1, "the healthy legacy alias is a positive control");
  const malformed = join(f.root, "malformed.yaml");
  writeFileSync(malformed, "instances: [\n");
  for (const value of ["", "relative.yaml", join(f.root, "missing.yaml"), malformed]) {
    process.env.RMD_SELECTED_INSTANCE_REGISTRY = value;
    await assert.rejects(() => withInstanceRegistryRuntime(() => { operations++; }), /selected instance registry unavailable/);
    assert.equal(operations, 1, "unknown explicit selection never executes using the healthy catalog");
  }
});

test("private registry selection preserves owner holds and private-safe boundaries: the new transport name is forbidden in worker overrides", async t => {
  const f = fixture(t);
  await withInstanceRegistryRuntime(() => {
    assert.doesNotThrow(() => assertInstanceRegistryWorkerEnvironment({ PUBLIC_FIXTURE: "allowed" }));
    for (const value of ["", "public-looking-value", f.selected]) {
      assert.throws(() => assertInstanceRegistryWorkerEnvironment({ RMD_SELECTED_INSTANCE_REGISTRY: value }),
        /worker_environment_private_source/, "the name itself is private, even without a matching path value");
    }
    assert.throws(() => assertInstanceRegistryWorkerEnvironment({ RMD_INSTANCE_REGISTRY: "public-looking-value" }),
      /worker_environment_private_source/);
  }, { envPath: f.selected, instanceName: "fixture" });
  assert.doesNotThrow(() => assertInstanceRegistryWorkerEnvironment({ PUBLIC_FIXTURE: "allowed" }));
});

test("W1-T1069: both scripts read the same declared name list: registry transport names are declared and printed without values", t => {
  const f = fixture(t);
  const names = ["RMD_INSTANCE_REGISTRY", "RMD_INSTANCE_REGISTRY_DIGEST", "RMD_INSTANCE_REGISTRY_FILE_BINDING"];
  const shared = spawnSync("bash", ["-eu", "-c", 'source "$1"; printf "%s\\n" "${RMD_DAEMON_RUNTIME_ENV_VARS[@]}"',
    "runtime-names", join(REPO_ROOT, "deploy/runtime-env-vars.sh")], { encoding: "utf8" });
  assert.ifError(shared.error);
  assert.equal(shared.status, 0, shared.stderr);
  for (const name of names) assert.ok(shared.stdout.split("\n").includes(name), `${name} must be declared`);
  const printed = spawnSync("bash", [join(REPO_ROOT, "deploy/host-update.sh"), "--print-daemon-run"], {
    encoding: "utf8", env: { ...process.env, RMD_SCRATCH: "off", RMD_STATE_DIR: join(f.root, "state"),
      RMD_OP_DIR: join(f.root, "op"), RMD_CLAUDE_DIR: join(f.root, "claude"), RMD_CODEX_DIR: join(f.root, "codex"),
      RMD_CONTAINER_CONFIG_DIR: join(f.root, "config"), RMD_INSTANCE_REGISTRY: "catalog-value-sentinel",
      RMD_INSTANCE_REGISTRY_DIGEST: "digest-value-sentinel", RMD_INSTANCE_REGISTRY_FILE_BINDING: "binding-value-sentinel" },
  });
  assert.ifError(printed.error);
  assert.equal(printed.status, 0, printed.stderr);
  const daemon = printed.stdout.slice(printed.stdout.indexOf("docker run -d --name remudero-daemon"), printed.stdout.indexOf("./bin/rmd daemon"));
  assert.ok(daemon.length > 0, "the printed daemon command is the positive control");
  for (const name of names) assert.ok(daemon.includes(`-e ${name} `), `${name} must be carried only when set`);
  assert.doesNotMatch(printed.stdout + printed.stderr, /(?:catalog|digest|binding)-value-sentinel/);
});

test("private registry selection defaults and falsifiers forbid live effects: shared launcher distinguishes catalog from selection and rechecks it", t => {
  const f = fixture(t), effects = join(f.root, "unexpected-effects");
  const run = (selected?: string, revise = false) => spawnSync("bash", ["-eu", "-c", `
    source "$1"
    effects="$4"
    docker() { touch "$effects"; return 97; }
    az() { touch "$effects"; return 97; }
    selected_registry_init "$2" fixture serve-container
    printf 'active=%s\\n' "$SELECTED_REGISTRY_ACTIVE"
    if [ "$SELECTED_REGISTRY_ACTIVE" = 1 ]; then
      printf '%s\\n' "\${SELECTED_REGISTRY_LAUNCH_ARGS[@]}"
    fi
    if [ "$3" = revise ]; then
      printf '\\n# changed after qualification\\n' >> "$RMD_SELECTED_INSTANCE_REGISTRY"
      selected_registry_recheck
    fi
  `, "selection-proof", join(REPO_ROOT, "deploy/recycle-container.sh"), REPO_ROOT, revise ? "revise" : "stable", effects], {
    encoding: "utf8", env: { ...process.env, RMD_INSTANCE_REGISTRY: selected === undefined ? undefined : f.catalog,
      RMD_SELECTED_INSTANCE_REGISTRY: selected },
  });
  const absent = run();
  assert.ifError(absent.error);
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, "active=0\n", "source import and absent selection perform no transport work");
  const selected = run(f.selected);
  assert.ifError(selected.error);
  assert.equal(selected.status, 0, selected.stderr);
  assert.ok(selected.stdout.includes(`type=bind,src=${f.selected},dst=/home/node/.config/remudero/selected-registry.yaml,readonly`));
  assert.ok(selected.stdout.includes(`RMD_INSTANCE_REGISTRY=${f.catalog}`), "the legacy catalog retains its own meaning");
  assert.ok(selected.stdout.includes("RMD_SELECTED_INSTANCE_REGISTRY=/home/node/.config/remudero/selected-registry.yaml"));
  const revised = run(f.selected, true);
  assert.ifError(revised.error);
  assert.equal(revised.status, 2, revised.stderr);
  assert.match(revised.stderr, /selected registry unavailable/);
  assert.equal(existsSync(effects), false, "neither default, qualification nor refusal may invoke a live transport");
});
