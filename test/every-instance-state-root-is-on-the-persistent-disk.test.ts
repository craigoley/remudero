import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

/**
 * W1-T3673 — one of three fleet state roots sat on the 29 GiB OS disk that filled and panicked
 * the host (2026-09-16). Core and console bind onto the managed data disk at /mnt/rmd; site did
 * not. `deploy/host-update.sh --check-state-roots` resolves every DECLARED instance's state root
 * to the filesystem it actually lives on and names each one that is not the persistent data disk;
 * `--relocate-state-root <instance> <dest>` copies one there and proves the copy byte-identical.
 *
 * NO REAL MOUNTS ARE NEEDED. The script asks `df -P` which filesystem a path lives on, so a `df`
 * stub on PATH maps fixture prefixes to devices — the same stub-on-PATH technique
 * test/host-update-reclaim.test.ts uses for docker. The map mirrors the measured host: `/` and
 * $HOME on `/dev/root` (the OS disk), `/mnt/rmd` on the managed data disk, `/mnt/scratch` on the
 * Azure ephemeral resource disk, and core's `~/rmd-state2` bind-mounted from the data disk (a
 * bind mount reports its SOURCE device, which is why a path under $HOME can still pass).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "host-update.sh");

const OS_DISK = "/dev/root";
const DATA_DISK = "/dev/nvme0n1p1";
const EPHEMERAL_DISK = "/dev/sdb1";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface Host {
  root: string;
  home: string;
  persistent: string;
  ephemeral: string;
  bin: string;
  /** prefix -> device, longest prefix wins; "" is the `/` fallback. */
  map: Map<string, string>;
}

function makeHost(): Host {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}state-roots-`)));
  roots.push(root);
  const host: Host = {
    root,
    home: join(root, "home"),
    persistent: join(root, "mnt", "rmd"),
    ephemeral: join(root, "mnt", "scratch"),
    bin: join(root, "bin"),
    map: new Map(),
  };
  for (const d of [host.home, host.persistent, host.ephemeral, host.bin]) mkdirSync(d, { recursive: true });
  host.map.set("", OS_DISK);
  host.map.set(host.persistent, DATA_DISK);
  host.map.set(host.ephemeral, EPHEMERAL_DISK);
  return host;
}

/** A state root with a ledger, optionally declared as a bind mount from the data disk. */
function stateRoot(host: Host, path: string, opts: { bindFromDataDisk?: boolean; ledger?: Buffer } = {}): string {
  mkdirSync(join(path, "state"), { recursive: true });
  writeFileSync(join(path, "state", "ledger.ndjson"), opts.ledger ?? Buffer.from('{"kind":"run"}\n'));
  if (opts.bindFromDataDisk) host.map.set(path, DATA_DISK);
  return path;
}

function writeStubs(host: Host, opts: { runningContainers?: string[]; cpStripsCarriageReturns?: boolean } = {}): void {
  const entries = [...host.map.entries()].map(([p, d]) => `${p}=${d}`).join(";");
  // `df -P <path>`: longest mapped prefix of <path> wins; mount point column is the prefix itself.
  const df = [
    "#!/usr/bin/env bash",
    'path="${@: -1}"',
    `map='${entries}'`,
    'best=""; dev=""',
    'IFS=";" read -r -a pairs <<<"$map"',
    'for pair in "${pairs[@]}"; do',
    '  p="${pair%%=*}"; d="${pair#*=}"',
    '  case "$path/" in "$p/"*) if [ "${#p}" -ge "${#best}" ]; then best="$p"; dev="$d"; fi ;; esac',
    "done",
    'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
    'echo "$dev 1000 1 999 1% ${best:-/}"',
    "",
  ].join("\n");
  writeFileSync(join(host.bin, "df"), df, { mode: 0o755 });
  const docker = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "ps" ]; then',
    ...(opts.runningContainers ?? []).map((n) => `  echo ${n}`),
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(host.bin, "docker"), docker, { mode: 0o755 });
  if (opts.cpStripsCarriageReturns) {
    const realCp = spawnSync("bash", ["-c", "command -v cp"], { encoding: "utf8" }).stdout.trim();
    const cp = [
      "#!/usr/bin/env bash",
      `"${realCp}" "$@" || exit $?`,
      'find "${@: -1}" -name ledger.ndjson -type f | while IFS= read -r f; do',
      '  tr -d "\\r" <"$f" >"$f.tmp" && mv "$f.tmp" "$f"',
      "done",
      "",
    ].join("\n");
    writeFileSync(join(host.bin, "cp"), cp, { mode: 0o755 });
  }
}

function writeRegistry(host: Host, instances: Record<string, { state_dir: string; container_name?: string; retired?: boolean }>): string {
  const lines = ["# fixture registry", "instances:"];
  for (const [name, inst] of Object.entries(instances)) {
    lines.push(`  ${name}:`);
    lines.push(`    repo: ${name}`);
    lines.push(`    container_name: ${inst.container_name ?? `remudero-${name}-daemon`}`);
    lines.push(`    state_dir: ${inst.state_dir}`);
    if (inst.retired) lines.push("    retired: true");
  }
  const file = join(host.root, "daemon-instances.yaml");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function run(host: Host, registry: string, args: string[]): { status: number; out: string } {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${host.bin}:${process.env.PATH ?? ""}`,
      HOME: host.home,
      RMD_INSTANCE_REGISTRY: registry,
      RMD_PERSISTENT_ROOT: host.persistent,
      RMD_EPHEMERAL_ROOT: host.ephemeral,
    },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The measured 2026-09-16 layout: core bound from the data disk, console on it, site on the OS disk. */
function measuredHost(): { host: Host; registry: string; site: string } {
  const host = makeHost();
  const core = stateRoot(host, join(host.home, "rmd-state2"), { bindFromDataDisk: true });
  const site = stateRoot(host, join(host.home, "rmd-site-state"));
  const consoleState = stateRoot(host, join(host.persistent, "remudero-console-state"));
  const registry = writeRegistry(host, {
    core: { state_dir: core, container_name: "remudero-daemon" },
    site: { state_dir: site },
    console: { state_dir: consoleState },
  });
  return { host, registry, site };
}

test("every instance state root resolves to the persistent data disk", async (t) => {
  await t.test("the measured layout fails, NAMING site and only site", () => {
    const { host, registry, site } = measuredHost();
    writeStubs(host);
    const r = run(host, registry, ["--check-state-roots"]);
    assert.equal(r.status, 1, r.out);
    const failing = r.out.split("\n").filter((l) => /NOT on the persistent data disk/.test(l));
    assert.ok(failing.some((l) => l.includes("site") && l.includes(site) && l.includes(OS_DISK)), r.out);
    assert.ok(!failing.some((l) => /\bcore\b|\bconsole\b/.test(l)), `only site may be named as failing:\n${r.out}`);
    assert.match(r.out, /^\s*core\s.*ok/m);
    assert.match(r.out, /^\s*console\s.*ok/m);
  });

  await t.test("once site is bound from the data disk, every instance passes", () => {
    const { host, registry, site } = measuredHost();
    host.map.set(site, DATA_DISK);
    writeStubs(host);
    const r = run(host, registry, ["--check-state-roots"]);
    assert.equal(r.status, 0, r.out);
    for (const name of ["core", "site", "console"]) assert.match(r.out, new RegExp(`^\\s*${name}\\s.*ok`, "m"));
  });

  await t.test("a persistent root that is not its own mounted disk is refused, not trusted", () => {
    const { host, registry } = measuredHost();
    // /mnt/rmd failed to mount (fstab `nofail`): it is a plain directory on the OS disk, so every
    // state root beneath it would "match" the persistent root while sitting on the disk that fills.
    host.map.set(host.persistent, OS_DISK);
    writeStubs(host);
    const r = run(host, registry, ["--check-state-roots"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /REFUSING/);
    assert.match(r.out, /not its own mounted disk/);
  });

  await t.test("a declared state root that does not exist is named, not skipped", () => {
    const { host } = measuredHost();
    const registry = writeRegistry(host, { ghost: { state_dir: join(host.persistent, "never-created") } });
    writeStubs(host);
    const r = run(host, registry, ["--check-state-roots"]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /ghost.*does not exist/);
  });
});

test("an ephemeral resource disk is refused as a state root", async (t) => {
  await t.test("a declared state root on /mnt/scratch is REFUSED and named", () => {
    const host = makeHost();
    const core = stateRoot(host, join(host.persistent, "state2"));
    const scratch = stateRoot(host, join(host.ephemeral, "site-state"));
    const registry = writeRegistry(host, { core: { state_dir: core }, site: { state_dir: scratch } });
    writeStubs(host);
    const r = run(host, registry, ["--check-state-roots"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /REFUSING/);
    assert.match(r.out, /site.*EPHEMERAL/);
  });

  await t.test("a state root BOUND from the ephemeral disk is refused by device, not only by path", () => {
    const host = makeHost();
    const bound = stateRoot(host, join(host.home, "rmd-site-state"));
    host.map.set(bound, EPHEMERAL_DISK);
    const registry = writeRegistry(host, { site: { state_dir: bound } });
    writeStubs(host);
    const r = run(host, registry, ["--check-state-roots"]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /site.*EPHEMERAL/);
  });

  await t.test("relocating onto the ephemeral disk is refused and copies nothing", () => {
    const { host, registry } = measuredHost();
    writeStubs(host);
    const dest = join(host.ephemeral, "site-state");
    const r = run(host, registry, ["--relocate-state-root", "site", dest]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /REFUSING.*EPHEMERAL/);
    assert.equal(existsSync(dest), false, "nothing may be written to the ephemeral disk");
  });
});

test("relocating a state root preserves the ledger byte-identically", async (t) => {
  // CRLF lines, a non-UTF-8 byte and a trailing newline: the three things a text-mode copy mangles.
  const ledger = Buffer.concat([
    Buffer.from('{"kind":"run","id":"a"}\r\n{"kind":"verdict","id":"b"}\n'),
    Buffer.from([0xff, 0xfe]),
    Buffer.from('{"kind":"cost","usd":1.25}\n'),
  ]);

  await t.test("site is copied onto the data disk with every byte intact and the source untouched", () => {
    const host = makeHost();
    const site = stateRoot(host, join(host.home, "rmd-site-state"), { ledger });
    writeFileSync(join(site, "state", "PAUSE"), "");
    const registry = writeRegistry(host, { site: { state_dir: site } });
    writeStubs(host);
    const dest = join(host.persistent, "site-state");
    const r = run(host, registry, ["--relocate-state-root", "site", dest]);
    assert.equal(r.status, 0, r.out);
    assert.ok(readFileSync(join(dest, "state", "ledger.ndjson")).equals(ledger), "ledger bytes differ after relocation");
    assert.ok(existsSync(join(dest, "state", "PAUSE")), "every file under the root moves, not only the ledger");
    assert.ok(readFileSync(join(site, "state", "ledger.ndjson")).equals(ledger), "the source must be left intact");
    assert.match(r.out, new RegExp(`${dest} ${site} none bind,nofail`));
  });

  await t.test("a copy that rewrites line endings is caught and discarded, never installed", () => {
    const host = makeHost();
    const site = stateRoot(host, join(host.home, "rmd-site-state"), { ledger });
    const registry = writeRegistry(host, { site: { state_dir: site } });
    writeStubs(host, { cpStripsCarriageReturns: true });
    const dest = join(host.persistent, "site-state");
    const r = run(host, registry, ["--relocate-state-root", "site", dest]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /ledger\.ndjson/);
    assert.equal(existsSync(dest), false, "a mismatched copy must not be installed at the destination");
    assert.ok(readFileSync(join(site, "state", "ledger.ndjson")).equals(ledger));
  });

  await t.test("a relocation while the instance's container is running is refused", () => {
    const host = makeHost();
    const site = stateRoot(host, join(host.home, "rmd-site-state"), { ledger });
    const registry = writeRegistry(host, { site: { state_dir: site } });
    writeStubs(host, { runningContainers: ["remudero-site-daemon"] });
    const dest = join(host.persistent, "site-state");
    const r = run(host, registry, ["--relocate-state-root", "site", dest]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /REFUSING.*remudero-site-daemon/);
    assert.equal(existsSync(dest), false);
  });

  await t.test("an existing destination is never merged into or overwritten", () => {
    const host = makeHost();
    const site = stateRoot(host, join(host.home, "rmd-site-state"), { ledger });
    const registry = writeRegistry(host, { site: { state_dir: site } });
    writeStubs(host);
    const dest = stateRoot(host, join(host.persistent, "site-state"), { ledger: Buffer.from("older\n") });
    const r = run(host, registry, ["--relocate-state-root", "site", dest]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /already exists/);
    assert.equal(readFileSync(join(dest, "state", "ledger.ndjson"), "utf8"), "older\n");
  });
});
