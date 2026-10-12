import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function host(run: (h: ReturnType<typeof fixture>) => void) {
  const h = fixture();
  try { run(h); } finally { rmSync(h.root, { recursive: true, force: true }); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rmd-host-node-"));
  const bin = join(root, "commands");
  mkdirSync(bin);
  cpSync("deploy", join(root, "deploy"), { recursive: true });
  writeFileSync(join(root, ".nvmrc"), "24.21.0\n");
  const source = join(root, "nodesource.sources");
  const sourceText = "Types: deb\nURIs: https://deb.nodesource.com/node_22.x\nSuites: nodistro\n" +
    "Components: main\nArchitectures: amd64\nSigned-By: /usr/share/keyrings/nodesource.gpg\n";
  writeFileSync(source, sourceText);
  const actual = join(root, "version");
  writeFileSync(actual, "v22.23.2\n");
  const calls = join(root, "apt-calls");
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub("node", 'cat "$HOST_VERSION"');
  stub("apt", `printf '%s\\n' "$*" >> "$HOST_CALLS"
case "$1 $2" in
  'apt-get update') exit "\${HOST_UPDATE_STATUS:-0}" ;;
  'apt-cache madison')
    [ "\${HOST_CACHE_STATUS:-0}" = 0 ] || exit "$HOST_CACHE_STATUS"
    printf '%s\\n' "nodejs | \${HOST_PACKAGE:-24.21.0-1nodesource1} | https://deb.nodesource.com/node_24.x nodistro/main amd64 Packages" ;;
  'apt-get install')
    [ "\${HOST_INSTALL_STATUS:-0}" = 0 ] || exit "$HOST_INSTALL_STATUS"
    package="\${4#nodejs=}"
    [ "\${HOST_NO_CHANGE:-0}" = 1 ] || printf 'v%s\\n' "\${package%-1nodesource1}" > "$HOST_VERSION" ;;
  *) exit 90 ;;
esac`);
  for (const name of ["apt-get", "apt-cache"]) stub(name, `exec "$HOST_APT" "${name}" "$@"`);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RMD_NODE_MAX_OLD_SPACE_MB: "8192",
    RMD_UNIT_DIR: join(root, "units"),
    RMD_BIN_DIR: join(root, "unit-bin"),
    RMD_LAUNCHER_PATH: join(root, "launcher"),
    RMD_NODESOURCE_PATH: source,
    RMD_HOST_NODE_PATH: join(bin, "node"),
    RMD_HOST_APT_CMD: join(bin, "apt"),
    HOST_APT: join(bin, "apt"),
    HOST_VERSION: actual,
    HOST_CALLS: calls,
  };
  return {
    root, source, sourceText, actual,
    run: (mode: "check" | "install", overrides: Record<string, string> = {}) =>
      spawnSync("bash", [join(root, "deploy", "install-host-units.sh"), `--${mode}`], {
        encoding: "utf8", env: { ...env, ...overrides }, timeout: 15_000,
      }),
    calls: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    unitsInstalled: () => existsSync(join(root, "units", "rmd-fleet.service")),
  };
}

test("W1-T6251: install converges the host node to the pinned NodeSource package", () => {
  host((h) => {
    const result = h.run("install");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(h.source, "utf8"), h.sourceText.replace("node_22.x", "node_24.x"));
    assert.deepEqual(h.calls(), ["apt-get update", "apt-cache madison nodejs", "apt-get install -y nodejs=24.21.0-1nodesource1"]);
    assert.equal(readFileSync(h.actual, "utf8"), "v24.21.0\n");
    assert.match(result.stdout, /host-node: installed 24\.21\.0/);
    assert.ok(h.unitsInstalled());
    assert.equal(h.run("check").status, 0);
    assert.equal(h.run("install").status, 0);
    assert.equal(h.calls().length, 3, "an in-step host needs no further apt calls");
  });
});

test("W1-T6251: check mode names host-node drift as DRIFTED", () => {
  host((h) => {
    assert.equal(h.run("install").status, 0);
    writeFileSync(h.actual, "v22.23.2\n");
    const result = h.run("check");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /install-host-units: DRIFTED host-node 22\.23\.2 != 24\.21\.0/);
    assert.equal(h.calls().length, 3, "check must never call apt");
    assert.equal(readFileSync(h.actual, "utf8"), "v22.23.2\n");
    assert.equal(readFileSync(h.source, "utf8"), h.sourceText.replace("node_22.x", "node_24.x"));
  });
});

test("W1-T6251: an unpublished pin is reported, never refused", () => {
  host((h) => {
    const result = h.run("install", { HOST_PACKAGE: "24.20.0-1nodesource1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /host-node: 24\.21\.0 not yet in node_24\.x; staying on 22\.23\.2, retried next converge/);
    assert.deepEqual(h.calls(), ["apt-get update", "apt-cache madison nodejs"]);
    assert.equal(readFileSync(h.actual, "utf8"), "v22.23.2\n");
    assert.ok(h.unitsInstalled());
    assert.equal(h.run("check").status, 1);
    assert.equal(h.run("install").status, 0, "the next converge retries publication");
    assert.equal(readFileSync(h.actual, "utf8"), "v24.21.0\n");
  });
});

test("W1-T6251: a same-major patch refreshes apt and uses the default command seam", () => {
  host((h) => {
    writeFileSync(h.source, h.sourceText.replace("node_22.x", "node_24.x"));
    writeFileSync(h.actual, "v24.20.0\n");
    const result = h.run("install", { RMD_HOST_APT_CMD: "" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(h.calls(), ["apt-get update", "apt-cache madison nodejs", "apt-get install -y nodejs=24.21.0-1nodesource1"]);
    assert.equal(readFileSync(h.actual, "utf8"), "v24.21.0\n");
  });
});

test("W1-T6251: unmanaged nodes are named and left alone", () => {
  for (const unmanaged of ["missing source", "different node"]) host((h) => {
    const overrides: Record<string, string> = {};
    if (unmanaged === "missing source") rmSync(h.source);
    else overrides.RMD_HOST_NODE_PATH = "/usr/bin/node";
    const result = h.run("install", overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /host-node: unmanaged .*22\.23\.2/);
    assert.deepEqual(h.calls(), []);
    assert.equal(readFileSync(h.actual, "utf8"), "v22.23.2\n");
    if (unmanaged === "different node") assert.equal(readFileSync(h.source, "utf8"), h.sourceText);
    assert.ok(h.unitsInstalled());
  });
});

test("W1-T6251: apt failures are named without blocking unit installation", () => {
  for (const [variable, reason, calls] of [
    ["HOST_UPDATE_STATUS", "apt-get update failed", 1],
    ["HOST_CACHE_STATUS", "apt-cache madison failed", 2],
    ["HOST_INSTALL_STATUS", "apt-get install failed", 3],
    ["HOST_NO_CHANGE", "still 22.23.2", 3],
  ] as const) host((h) => {
    const result = h.run("install", { [variable]: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(reason), result.stdout);
    assert.equal(h.calls().length, calls);
    assert.equal(readFileSync(h.actual, "utf8"), "v22.23.2\n");
    assert.ok(h.unitsInstalled());
  });
});

test("W1-T6251: checking a fresh host changes neither its source nor its packages", () => {
  host((h) => {
    const result = h.run("check");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /DRIFTED host-node 22\.23\.2 != 24\.21\.0/);
    assert.equal(readFileSync(h.source, "utf8"), h.sourceText);
    assert.equal(readFileSync(h.actual, "utf8"), "v22.23.2\n");
    assert.deepEqual(h.calls(), []);
    assert.equal(h.unitsInstalled(), false);
  });
});

test("W1-T6251: publication requires the exact package version", () => {
  for (const version of ["24.21.0-1nodesource10", "124.21.0-1nodesource1", "24.21.0-2nodesource1"]) host((h) => {
    const result = h.run("install", { HOST_PACKAGE: version });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /24\.21\.0 not yet in node_24\.x/);
    assert.deepEqual(h.calls(), ["apt-get update", "apt-cache madison nodejs"]);
    assert.equal(readFileSync(h.actual, "utf8"), "v22.23.2\n");
    assert.ok(h.unitsInstalled());
  });
});

test("W1-T6251: the checkout pin determines the package, including a v prefix", () => {
  host((h) => {
    writeFileSync(join(h.root, ".nvmrc"), "v26.1.2\n");
    const result = h.run("install", { HOST_PACKAGE: "26.1.2-1nodesource1" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(h.source, "utf8"), h.sourceText.replace("node_22.x", "node_26.x"));
    assert.deepEqual(h.calls(), ["apt-get update", "apt-cache madison nodejs", "apt-get install -y nodejs=26.1.2-1nodesource1"]);
    assert.equal(readFileSync(h.actual, "utf8"), "v26.1.2\n");
    assert.match(result.stdout, /host-node: installed 26\.1\.2/);
    assert.equal(h.run("check").status, 0);
  });
});

test("W1-T6251: missing or invalid inputs are reported without blocking units", () => {
  for (const input of ["missing pin", "invalid pin", "foreign source"]) host((h) => {
    const pin = join(h.root, ".nvmrc");
    if (input === "missing pin") rmSync(pin);
    if (input === "invalid pin") writeFileSync(pin, "24.x\n");
    if (input === "foreign source") writeFileSync(h.source, "Types: deb\nURIs: https://example.test/node_22.x\n");
    const result = h.run("install");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /host-node: (cannot read checkout .nvmrc|invalid .nvmrc pin|unmanaged source=)/);
    assert.deepEqual(h.calls(), []);
    assert.equal(readFileSync(h.actual, "utf8"), "v22.23.2\n");
    assert.ok(h.unitsInstalled());
  });
});
