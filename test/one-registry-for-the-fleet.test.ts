/**
 * test/one-registry-for-the-fleet.test.ts — W1-T4227.
 *
 * `.remudero/daemon-instances.yaml` becomes the fleet's one registry: each instance names its
 * `project` and `github_repo`, `parseInstanceRegistry` validates it, and `GET /v1/registry` serves
 * projects → repos → instances with no path or secret, flagging a host copy that drifted.
 *
 * Every registry here is a temp-file fixture; the one read of the committed registry is DATA (a
 * positive control that the real file parses and carries the project layer), never source text.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixedClock } from "../src/lib/clock.js";
import {
  DEFAULT_PROJECT,
  InstanceRegistryError,
  parseInstanceNames,
  parseInstanceRegistry,
  registryDrift,
  type InstanceRegistryErrorCode,
} from "../src/lib/instance-registry.js";
import { buildRegistryRoute, type RegistryRouteInput } from "../src/lib/serve.js";
import type { Route } from "../src/lib/service.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-23T12:00:00.000Z");

/** One instance row in the shell readers' grammar, carrying the private fields the route must hide. */
function row(name: string, fields: Record<string, string>): string {
  const body = {
    state_dir: `/home/operator/${name}-state`,
    container_name: `${name}-daemon`,
    claude_dir: "/home/operator/.claude",
    codex_dir: "/home/operator/.codex",
    container_config_dir: "/home/operator/.config/remudero-container",
    image: "registry.azurecr.io/remudero:latest",
    ...fields,
  };
  return [`  ${name}:`, ...Object.entries(body).map(([k, v]) => `    ${k}: ${v}`)].join("\n");
}

function registry(...rows: string[]): string {
  return ["# fixture registry", "instances:", ...rows, ""].join("\n");
}

const FLEET = registry(
  row("core", { repo: "remudero", project: "remudero", github_repo: "craigoley/remudero" }),
  row("site", { repo: "remudero-site", project: "remudero", github_repo: "craigoley/remudero-site" }),
  row("console", { repo: "remudero-console", project: "remudero", github_repo: "craigoley/remudero-console" }),
  row("trails", { repo: "wild-trails", github_repo: "someone/wild-trails" }),
);

function refusal(text: string): InstanceRegistryErrorCode {
  try {
    parseInstanceRegistry(text);
  } catch (error) {
    // The refusal's CODE is the assertion subject; anything else is a test failure below.
    assert.ok(error instanceof InstanceRegistryError, `expected a named InstanceRegistryError, got ${String(error)}`);
    return error.code;
  }
  assert.fail("expected the registry to be refused");
}

function fixtureDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "rmd-w1t4227-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function invoke(route: Route): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  let status = 0;
  let text = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      text += chunk ?? "";
    },
  };
  await route.handler({} as never, res as never, { params: {} });
  return { status, text, body: JSON.parse(text) as Record<string, unknown> };
}

function routeOver(dir: string, repoText: string | undefined, hostText: string | undefined, over: Partial<RegistryRouteInput> = {}): Route {
  const repoRegistryPath = join(dir, "repo-registry.yaml");
  const hostRegistryPath = join(dir, "host-registry.yaml");
  if (repoText !== undefined) writeFileSync(repoRegistryPath, repoText);
  if (hostText !== undefined) writeFileSync(hostRegistryPath, hostText);
  return buildRegistryRoute({ repoRegistryPath, hostRegistryPath, clock: fixedClock(NOW), ...over });
}

test("the registry parser refuses duplicate instance names and live repos", () => {
  const dupName = registry(
    row("core", { github_repo: "craigoley/remudero" }),
    row("core", { github_repo: "craigoley/remudero-site" }),
  );
  assert.equal(refusal(dupName), "duplicate_instance");

  const dupLiveRepo = registry(
    row("core", { github_repo: "craigoley/remudero" }),
    row("core-two", { github_repo: "Craigoley/Remudero" }),
  );
  assert.equal(refusal(dupLiveRepo), "duplicate_live_repo", "repo identity is case-insensitive, as on GitHub");

  // A RETIRED row does not hold the repo: the replacement instance may be live for it.
  const handedOver = registry(
    row("old-core", { github_repo: "craigoley/remudero", retired: "true" }),
    row("core", { github_repo: "craigoley/remudero", retired: "false" }),
  );
  const parsed = parseInstanceRegistry(handedOver);
  assert.deepEqual(
    parsed.instances.map((i) => [i.name, i.live]),
    [["old-core", false], ["core", true]],
  );
});

test("the registry parser names every malformed shape instead of skipping it", () => {
  const cases: Array<[string, InstanceRegistryErrorCode]> = [
    ["servers:\n  core:\n    repo: craigoley/remudero\n", "no_instances_block"],
    ["instances:\n  core:\n      repo: craigoley/remudero\n", "malformed_line"],
    ["instances:\n    repo: craigoley/remudero\n", "malformed_line"],
    ["instances:\n  core:\n    repo: a/b\n    repo: a/c\n", "duplicate_field"],
    ["instances:\n  core:\n    state_dir: /x\n", "missing_repo"],
    ["instances:\n  core:\n    repo: remudero\n", "invalid_repo"],
    ["instances:\n  core:\n    github_repo: a/b\n    project: Not An Id\n", "invalid_project"],
    ["instances:\n  core:\n    github_repo: a/b\n    retired: yes\n", "invalid_retired"],
  ];
  for (const [text, code] of cases) assert.equal(refusal(text), code, text);
  assert.match(
    (() => {
      try {
        parseInstanceRegistry(cases[1][0]);
      } catch (error) {
        // The message is the assertion subject here.
        return String((error as Error).message);
      }
      return "";
    })(),
    /line 3/,
    "a malformed-line refusal names the line",
  );
});

test("the registry parser reads the shell readers' grammar: comments, quotes and sibling blocks", () => {
  const text = [
    "# header",
    "version: 1",
    "instances:",
    "  core:   # the core daemon",
    '    github_repo: "craigoley/remudero"  # quoted',
    "    repo: remudero",
    "other:",
    "  not-an-instance:",
    "    repo: x/y",
    "",
  ].join("\n");
  const parsed = parseInstanceRegistry(text);
  assert.deepEqual(parsed.instances, [{ name: "core", project: DEFAULT_PROJECT, repo: "craigoley/remudero", live: true }]);
  assert.deepEqual(parseInstanceNames(text), ["core"]);
  // A registry that predates github_repo may carry owner/name in repo: itself.
  assert.equal(parseInstanceRegistry("instances:\n  x:\n    repo: a/b\n").instances[0].repo, "a/b");
  assert.deepEqual(parseInstanceRegistry("instances:\n").instances, [], "an empty block is an empty fleet");
});

test("an instance with no project belongs to the default project", () => {
  const parsed = parseInstanceRegistry(FLEET);
  const trails = parsed.instances.find((i) => i.name === "trails");
  assert.equal(trails?.project, "default");
  assert.equal(DEFAULT_PROJECT, "default");
  assert.deepEqual(
    parsed.instances.filter((i) => i.project === "remudero").map((i) => i.name),
    ["core", "site", "console"],
  );
});

test("the registry route lists projects, repos and instances without any path or secret", async (t) => {
  const dir = fixtureDir(t);
  const route = routeOver(dir, FLEET, undefined);
  assert.equal(route.method, "GET");
  assert.equal(route.path, "/v1/registry");
  assert.equal(route.scope, "read");
  const { status, text, body } = await invoke(route);
  assert.equal(status, 200);
  assert.deepEqual(body, {
    projects: [
      {
        id: "remudero",
        repos: [
          { repo: "craigoley/remudero", instances: [{ name: "core", prefix: "/v1/i/core" }] },
          { repo: "craigoley/remudero-site", instances: [{ name: "site", prefix: "/v1/i/site" }] },
          { repo: "craigoley/remudero-console", instances: [{ name: "console", prefix: "/v1/i/console" }] },
        ],
      },
      { id: "default", repos: [{ repo: "someone/wild-trails", instances: [{ name: "trails", prefix: "/v1/i/trails" }] }] },
    ],
    source: "repo",
    generatedAt: "2026-09-23T12:00:00.000Z",
    hostRegistry: "unreadable",
  });
  // The rows carry every one of these; none may reach the wire.
  for (const secretish of ["/home/operator", "state", "daemon", ".claude", ".codex", "azurecr", "image", "token", dir]) {
    assert.ok(!text.includes(secretish), `the body must not carry '${secretish}': ${text}`);
  }
});

test("a retired instance is not served", async (t) => {
  const dir = fixtureDir(t);
  const text = registry(
    row("old", { github_repo: "a/b", retired: "true" }),
    row("new", { github_repo: "a/b" }),
  );
  const { body } = await invoke(routeOver(dir, text, "instances:\n  new:\n    repo: b\n"));
  assert.deepEqual(body.projects, [{ id: "default", repos: [{ repo: "a/b", instances: [{ name: "new", prefix: "/v1/i/new" }] }] }]);
  assert.equal(body.hostRegistry, "in_sync", "a retired row is not expected on the host");
  assert.equal("drift" in body, false);
});

test("a host registry that names a different instance set is reported as drift", async (t) => {
  const dir = fixtureDir(t);
  // The measured host shape: site and console, NOT core — plus one the repo never declared. The
  // host copy predates the project layer, so it carries neither project nor github_repo.
  const host = "instances:\n  site:\n    repo: remudero-site\n  console:\n    repo: remudero-console\n  legacy:\n    repo: old\n";
  const drifted = await invoke(routeOver(dir, FLEET, host));
  assert.equal(drifted.status, 200);
  assert.equal(drifted.body.hostRegistry, "drifted");
  assert.deepEqual(drifted.body.drift, { hostOnly: ["legacy"], repoOnly: ["core", "trails"] });
  assert.ok(Array.isArray(drifted.body.projects), "drift is a note beside the registry, never instead of it");

  const same = "instances:\n  core:\n    repo: remudero\n  site:\n    repo: x\n  console:\n    repo: y\n  trails:\n    repo: z\n";
  const inSync = await invoke(routeOver(fixtureDir(t), FLEET, same));
  assert.equal(inSync.body.hostRegistry, "in_sync");
  assert.equal("drift" in inSync.body, false, "an equal set carries no drift field");

  assert.equal(registryDrift(["a", "b"], ["b", "a"]), undefined);
  assert.deepEqual(registryDrift(["a"], ["b"]), { hostOnly: ["b"], repoOnly: ["a"] });
});

test("an unreadable or malformed host registry is a note, never an error", async (t) => {
  const unreadable = await invoke(routeOver(fixtureDir(t), FLEET, undefined));
  assert.equal(unreadable.status, 200);
  assert.equal(unreadable.body.hostRegistry, "unreadable");
  assert.equal("drift" in unreadable.body, false);

  const malformed = await invoke(routeOver(fixtureDir(t), FLEET, "no instances here\n"));
  assert.equal(malformed.status, 200);
  assert.equal(malformed.body.hostRegistry, "malformed");
  assert.equal("drift" in malformed.body, false);

  // The default host path is the fleet host's /etc copy; wherever this runs it is SOME note.
  const dir = fixtureDir(t);
  writeFileSync(join(dir, "r.yaml"), FLEET);
  const defaulted = await invoke(buildRegistryRoute({ repoRegistryPath: join(dir, "r.yaml") }));
  assert.equal(defaulted.status, 200);
  assert.ok(["in_sync", "drifted", "unreadable", "malformed"].includes(String(defaulted.body.hostRegistry)));
});

test("an unreadable or invalid repo registry is a named 503 that carries no path", async (t) => {
  const dir = fixtureDir(t);
  const missing = await invoke(routeOver(dir, undefined, undefined));
  assert.equal(missing.status, 503);
  assert.deepEqual(missing.body, { error: "registry_unavailable", reason: "unreadable" });
  assert.ok(!missing.text.includes(dir));

  const invalid = await invoke(routeOver(fixtureDir(t), registry(row("a", { github_repo: "x/y" }), row("a", { github_repo: "x/z" })), undefined));
  assert.equal(invalid.status, 503);
  assert.deepEqual(invalid.body, { error: "registry_unavailable", reason: "duplicate_instance" });
});

test("the committed registry parses and puts core, site and console in the remudero project", () => {
  // Positive control on the real file (DATA, not source): the project layer is actually present.
  const text = readFileSync(join(REPO_ROOT, ".remudero", "daemon-instances.yaml"), "utf8");
  const parsed = parseInstanceRegistry(text);
  assert.deepEqual(
    parsed.instances.map((i) => [i.name, i.project, i.repo, i.live]),
    [
      ["core", "remudero", "craigoley/remudero", true],
      ["site", "remudero", "craigoley/remudero-site", true],
      ["console", "remudero", "craigoley/remudero-console", true],
    ],
  );
});

// The two shell readers REFUSE an unknown field, so the project layer is only safe to add because
// both now list `project`, `github_repo` and `retired` as known-and-ignored. Each check below has
// a control: the same fixture with an unknown field is refused, proving the probe can see a refusal.
const BASH_BIN =
  ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";

function shellRow(dir: string, extra: string): string {
  return [
    "instances:",
    "  demo:",
    "    repo: demo",
    extra,
    `    state_dir: ${join(dir, "state")}`,
    "    container_name: demo-daemon",
    "    service_user: test-user",
    "    image: example.invalid/remudero:test",
    "    max_old_space_mb: 8192",
    "    service_name: demo.service",
    "    watchdog_service_name: demo-watchdog.service",
    "    watchdog_timer_name: demo-watchdog.timer",
    `    launcher_path: ${join(dir, "demo-launcher.sh")}`,
    `    revival_log: ${join(dir, "demo-revivals.log")}`,
    "    gh_app_id: 1",
    "    gh_app_installation_id: 2",
    "    gh_app_private_key_path: /etc/remudero/key.pem",
    `    claude_dir: ${join(dir, "claude")}`,
    `    codex_dir: ${join(dir, "claude")}`,
    `    container_config_dir: ${join(dir, "claude")}`,
    "",
  ].join("\n");
}

const PROJECT_FIELDS = "    project: wild-trails\n    github_repo: someone/demo\n    retired: false";

test("recycle-container and install-host-units accept the project layer's fields", (t) => {
  const dir = fixtureDir(t);
  mkdirSync(join(dir, "state", "state"), { recursive: true });
  mkdirSync(join(dir, "claude"), { recursive: true });
  const accepted = join(dir, "accepted.yaml");
  const refused = join(dir, "refused.yaml");
  writeFileSync(accepted, shellRow(dir, PROJECT_FIELDS));
  writeFileSync(refused, shellRow(dir, "    bogus_field: x"));

  const recycle = (registryPath: string) =>
    // `--no-such-flag` stops the script at argument parsing, which runs AFTER the registry read and
    // before any docker call — so reaching "unknown argument" proves the registry was accepted.
    spawnSync(BASH_BIN, [join(REPO_ROOT, "deploy", "recycle-container.sh"), "--instance", "demo", "--no-such-flag"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: { ...process.env, RMD_INSTANCE_REGISTRY: registryPath, RMD_RECYCLE_DOCKERENV_PATH: join(dir, "no-dockerenv") },
    });
  const ok = recycle(accepted);
  assert.match(ok.stderr, /unknown argument '--no-such-flag'/, ok.stderr);
  assert.doesNotMatch(ok.stderr, /unknown field/);
  assert.match(recycle(refused).stderr, /unknown field 'bogus_field'/, "control: the probe sees a refusal");

  const install = (registryPath: string, name: string) =>
    spawnSync(BASH_BIN, [join(REPO_ROOT, "deploy", "install-host-units.sh"), "--install", "--instance", "demo"], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RMD_INSTANCE_REGISTRY: registryPath,
        RMD_UNIT_DIR: join(dir, "systemd", name),
        RMD_BIN_DIR: join(dir, "bin", name),
      },
    });
  const installed = install(accepted, "accepted");
  assert.equal(installed.status, 0, installed.stderr);
  const installRefused = install(refused, "refused");
  assert.notEqual(installRefused.status, 0);
  assert.match(installRefused.stderr, /unknown field 'bogus_field'/, "control: the probe sees a refusal");
});

// W1-T9435: keep the old parser/route/shell controls above beside the explicit opt-in contract.
test("selected registry precedence never falls back after explicit failure", async (t) => {
  const { readSelectedInstanceRegistry } = await import("../src/lib/instance-registry-selection.js");
  const dir = fixtureDir(t), legacyPath = join(dir, "healthy-legacy.yaml"), selectedPath = join(dir, "selected.yaml");
  writeFileSync(legacyPath, FLEET);
  writeFileSync(selectedPath, registry(row("independent", { github_repo: "someone/independent" })));
  for (const cliPath of ["", "relative.yaml", join(dir, "missing.yaml")]) {
    const result = await readSelectedInstanceRegistry({ cliPath, envPath: selectedPath, configuredPath: legacyPath, legacyPath });
    assert.ok(result.kind === "refused" || result.kind === "unknown", "explicit failure is never absence");
    assert.doesNotMatch(JSON.stringify(result), /craigoley\/remudero/);
  }
  const cli = await readSelectedInstanceRegistry({ cliPath: selectedPath, envPath: legacyPath, legacyPath });
  assert.equal(cli.kind, "ready");
  if (cli.kind === "ready") assert.equal(cli.binding.instances[0].name, "independent");
  const env = await readSelectedInstanceRegistry({ envPath: selectedPath, configuredPath: legacyPath, legacyPath });
  assert.equal(env.kind, "ready");
  if (env.kind === "ready") assert.equal(env.binding.source, "environment");
  assert.equal((await readSelectedInstanceRegistry({ configuredPath: selectedPath, legacyPath })).kind, "ready");
  assert.deepEqual(await readSelectedInstanceRegistry({ legacyPath }), { kind: "legacy" });
});

test("selected registry real reads bound input and name integrity failures", async (t) => {
  const { readSelectedInstanceRegistry } = await import("../src/lib/instance-registry-selection.js");
  const dir = fixtureDir(t), path = join(dir, "selected.yaml");
  writeFileSync(path, FLEET);
  const digest = createHash("sha256").update(FLEET).digest("hex");
  assert.equal((await readSelectedInstanceRegistry({ cliPath: path, expectedDigest: digest })).kind, "ready");
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: path, maxBytes: 8 }), { kind: "unknown", reason: "oversized" });
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: dir }), { kind: "unknown", reason: "not_regular" });
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: path, expectedDigest: "0".repeat(64) }), { kind: "unknown", reason: "digest_mismatch" });
  const link = join(dir, "link.yaml"); symlinkSync(path, link);
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: link }), { kind: "unknown", reason: "not_regular" });
  writeFileSync(path, "not a registry\n");
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: path }), { kind: "unknown", reason: "malformed" });
  writeFileSync(path, Buffer.from([0xff, 0xfe]));
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: path }), { kind: "unknown", reason: "invalid_encoding" });
});

test("selected registry bindings retain immutable identities across revision changes", async (t) => {
  const { readSelectedInstanceRegistry } = await import("../src/lib/instance-registry-selection.js");
  const dir = fixtureDir(t), path = join(dir, "registry.yaml");
  writeFileSync(path, FLEET);
  const input = { cliPath: path, requiredCapabilities: ["identity", "mode", "primary"] };
  const result = await readSelectedInstanceRegistry(input);
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  const binding = result.binding, original = JSON.stringify(binding);
  assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.instances) && Object.isFrozen(binding.instances[0]));
  assert.throws(() => Object.assign(binding.instances[0], { repo: "attacker/retarget" }), TypeError);
  assert.deepEqual(await binding.recheck(), { kind: "unchanged" });
  input.cliPath = join(dir, "new-selection.yaml"); input.requiredCapabilities.push("future-authority");
  const replacement = join(dir, "replacement.yaml");
  writeFileSync(replacement, registry(row("other", { github_repo: "other/independent" })));
  renameSync(replacement, path);
  assert.deepEqual(await binding.recheck(), { kind: "changed" });
  assert.equal(JSON.stringify(binding), original, "recheck never retargets the existing run");
  rmSync(path);
  assert.deepEqual(await binding.recheck(), { kind: "unknown", reason: "missing" });
});

test("selected registry compatibility preserves legacy input and refuses unsupported capabilities", async (t) => {
  const { readSelectedInstanceRegistry } = await import("../src/lib/instance-registry-selection.js");
  const dir = fixtureDir(t), path = join(dir, "registry.yaml");
  writeFileSync(path, "version: 1\n" + registry(row("core", { github_repo: "a/b", mode: "shadow", primary: "true" })));
  for (const contractVersion of [1, 2]) {
    const result = await readSelectedInstanceRegistry({ cliPath: path, contractVersion, requiredCapabilities: ["identity", "mode", "primary"] });
    assert.equal(result.kind, "ready");
    if (result.kind === "ready") assert.deepEqual(result.binding.instances[0], { name: "core", project: "default", repo: "a/b", live: true, mode: "shadow", primary: true });
  }
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: path, contractVersion: 3 }), { kind: "refused", reason: "unsupported_contract" });
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: path, requiredCapabilities: ["future-authority"] }), { kind: "refused", reason: "unsupported_capability" });
  writeFileSync(path, registry(row("core", { github_repo: "a/b", future_safety_hold: "true" })));
  assert.deepEqual(await readSelectedInstanceRegistry({ cliPath: path }), { kind: "refused", reason: "unsupported_field" });
});

test("selected registry public projection grants no private publication permission", async (t) => {
  const { readSelectedInstanceRegistry } = await import("../src/lib/instance-registry-selection.js");
  const dir = fixtureDir(t), path = join(dir, "private-selected.yaml");
  writeFileSync(path, FLEET);
  const result = await readSelectedInstanceRegistry({ cliPath: path });
  assert.equal(result.kind, "ready");
  if (result.kind !== "ready") return;
  assert.equal(result.binding.publicationPermission, "not-granted");
  assert.deepEqual(result.binding.publicProjection().projects[0].repos[0], { repo: "craigoley/remudero", instances: [{ name: "core", prefix: "/v1/i/core" }] });
  const projection = result.binding.publicProjection(); projection.projects.length = 0;
  assert.ok(result.binding.publicProjection().projects.length > 0, "a returned projection is not the bound identity storage");
  for (const bytes of [JSON.stringify(result), JSON.stringify(result.binding.publicProjection())]) {
    assert.ok(!bytes.includes(dir)); assert.ok(!bytes.includes("/home/operator")); assert.ok(!bytes.includes("azurecr"));
  }
});

test("selected registry route refuses selected failure without legacy or cache fallback", async (t) => {
  const dir = fixtureDir(t), missing = join(dir, "missing-selected.yaml");
  const selection = { selectedRegistry: { cliPath: missing } };
  assert.equal((await invoke(routeOver(dir, FLEET, FLEET))).status, 200, "real healthy legacy corpus control");
  const refused = await invoke(routeOver(dir, FLEET, FLEET, selection));
  assert.deepEqual(refused.body, { error: "selected_registry_unavailable", reason: "missing" });
  assert.equal(refused.status, 503);
  const cached = {
    readModel: {
      switches: () => ({ views: { instances: "serve" as const } }),
      body: () => ({ view: "instances", key: "", version: 1, generation: 1, etag: "cached", body: {
        view: "instances", version: 1, generatedAt: fixedClock(NOW).iso(), asOf: null, stale: false, sources: [],
        data: { instances: [{ id: "cached", registered: true, project: "cache", repo: "cache/healthy" }], hostRegistry: "in_sync" },
      } }),
    },
  };
  assert.equal((await invoke(routeOver(dir, undefined, undefined, cached))).status, 200, "actual served cache corpus control");
  assert.deepEqual(await invoke(routeOver(dir, FLEET, FLEET, { ...cached, ...selection })), refused);
  const path = join(dir, "selected.yaml"); writeFileSync(path, FLEET);
  const selected = await invoke(routeOver(dir, undefined, undefined, { ...cached, selectedRegistry: { cliPath: path } }));
  assert.equal(selected.status, 200); assert.equal(selected.body.source, "selected");
  assert.equal(selected.body.publicationPermission, "not-granted"); assert.ok(!selected.text.includes(dir));
});
