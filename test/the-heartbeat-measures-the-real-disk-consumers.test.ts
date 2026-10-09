import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeTempDir } from "../src/lib/tmp.js";
import { REAL_SCRIPT } from "./helpers/fleet-heartbeat-harness.js";

function measure(
  overrides: Record<string, string> = {},
  opts: { status?: number; inspect?: (dir: string) => void } = {},
): Record<string, string> {
  const dir = makeTempDir("heartbeat-consumers");
  try {
    const bin = join(dir, "bin");
    for (const path of ["bin", "scripts", "home", "state-root/state", "tmp/rmd-c-one", "tmp/rmd-c-two", "container-tmp/rmd-c-three"])
      mkdirSync(join(dir, path), { recursive: true });
    // INSTALL_DIR and dependency probes belong to this fixture, not the host checkout.
    // Copy the actual subject verbatim; do not stub its implementation or change its timeout.
    const script = join(dir, "scripts", "fleet-heartbeat.sh");
    const source = readFileSync(REAL_SCRIPT);
    writeFileSync(script, source, { mode: 0o755 });
    assert.deepEqual(readFileSync(script), source, "the isolated subject must remain byte-identical");
    mkdirSync(join(dir, "docker data"));
    writeFileSync(join(dir, "docker data", "image"), Buffer.alloc(8192, 1));
    const config = join(dir, "daemon.json");
    if (overrides.DAEMON_CONFIG === "1")
      writeFileSync(config, JSON.stringify({ "data-root": join(dir, "configured-docker") }));
    if (overrides.DAEMON_CONFIG === "junk") writeFileSync(config, '{"data-root": "relative"}');
    const stub = (name: string, body: string) =>
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    stub("git", 'case "$*" in *push*) [ "\${GIT_PUSH_FAIL:-}" = 1 ] && exit 1 ;; esac; printf "fixture-sha\\n"');
    // A whole filesystem's root reports FSROOT "/"; a bind of a subdirectory reports that subdirectory.
    stub("findmnt", `
[ "\${FINDMNT_ABSENT:-}" = 1 ] && exit 127
case "\${@: -1}" in
  /mnt/rmd) printf '/\\n' ;;
  /var/lib/containerd) printf '/containerd\\n' ;;
  *) exit 1 ;;
esac`);
    stub("ionice", 'printf "%s\\n" "$*" >> "$FIXTURE/ionice.log"; shift 2; exec "$@"');
    stub("uname", 'printf "Linux\\n"');
    stub("docker", `
case "$*" in
  "info --format {{.DockerRootDir}}")
    [ "\${DOCKER_INFO_FAIL:-}" = 1 ] && exit 1
    [ "\${DOCKER_INFO_FAIL:-}" = junk ] && { printf 'relative\\n'; exit 0; }
    [ "\${DOCKER_INFO_FAIL:-}" = partial ] && { printf '%s\\n' "$FIXTURE/docker data"; exit 1; }
    printf '%s\\n' "$FIXTURE/docker data" ;;
  *"range .Mounts"*)
    printf '%s\\t%s\\n' "$FIXTURE/live-worktrees" /home/node/Remudero/worktrees
    printf '%s\\t%s\\n' "$FIXTURE/live-coverage" /home/node/Remudero/.remudero-coverage
    printf '%s\\t%s\\n' "$FIXTURE/container-tmp" /tmp
    printf '%s\\t%s\\n' "$FIXTURE/live-tmp" /home/node/Remudero/tmp ;;
  *) exit 1 ;;
esac`);
    stub("du", `
p="\${@: -1}"
case "$p" in
  /var/lib/docker) exit 1 ;;
  "$FIXTURE/docker data")
    if [ "\${REAL_DU:-}" = 1 ]; then command -p du "$@"; exit "$?"; fi
    n=\${DOCKER_KB:-27000000} ;;
  "$FIXTURE/configured-docker") n=13000 ;;
  /var/lib/containerd)
    case "\${BAD_CONTAINERD:-}" in
      partial) printf '123\\t%s\\n' "$p"; exit 1 ;;
      junk) printf 'junk\\t%s\\n' "$p"; exit 0 ;;
      missing) exit 1 ;;
    esac
    n=27200000 ;;
  "$FIXTURE/live-worktrees") n=42000 ;;
  "$FIXTURE/state-root/worktrees") n=1400000 ;;
  "$FIXTURE/live-coverage") n=27000000 ;;
  "$FIXTURE"/tmp/rmd-c-one) n=100 ;;
  "$FIXTURE"/tmp/rmd-c-two) n=200 ;;
  "$FIXTURE"/container-tmp/rmd-c-three) n=300 ;;
  /mnt/rmd/tmp) n=800 ;;
  /mnt/rmd) [ "\${FINDMNT_ABSENT:-}" = 1 ] || exit 1; n=60000000 ;;
  *) n=10 ;;
esac
printf '%s\\t%s\\n' "$n" "$p"`);
    stub("df", `
[ "\${DF_FAIL:-}" = 1 ] && exit 1
p="\${@: -1}"
case "$p" in
  "$FIXTURE"/live-*|"$FIXTURE"/tmp/*|"$FIXTURE"/container-tmp/*) device=/dev/scratch ;;
  "$FIXTURE/docker data"|/var/lib/containerd|/mnt/rmd*) device=/dev/data ;;
  *) device=/dev/root ;;
esac
used=1000; mounted=/
[ "$p" = /mnt/rmd ] && { used=61000000; mounted=/mnt/rmd; }
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n%s 100000000 %s 90000000 1%% %s\\n' "$device" "$used" "$mounted"`);
    writeFileSync(join(dir, "state-root/state/heartbeat-count.txt"), overrides.BEAT_N ?? "0");
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: join(dir, "home"),
        TMPDIR: join(dir, "tmp"),
        FIXTURE: dir,
        RMD_ROOT: join(dir, "state-root"),
        RMD_HEARTBEAT_LOCK_HELD: "1",
        RMD_HEARTBEAT_DRY_RUN: overrides.PUBLISH === "1" ? "" : "1",
        RMD_HEARTBEAT_BRANCH: "heartbeat-consumer-fixture",
        RMD_HEARTBEAT_DOCKER: join(bin, "docker"),
        RMD_DOCKER_DAEMON_JSON: config,
        RMD_CONSUMER_EVERY: "6",
        ...overrides,
      },
    });
    assert.equal(result.status, opts.status ?? 0, `${result.error ?? ""}\n${result.stderr}`);
    opts.inspect?.(dir);
    if ((opts.status ?? 0) !== 0) return {};
    const beat = Object.fromEntries(result.stdout.split("\n").filter((line) => line.includes("="))
      .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
    assert.equal(beat.install_dir, dir, "dependency probes must stay in the isolated install");
    assert.equal(beat.tsx_present, "no", "a host-installed tsx cannot contaminate this fixture");
    return beat;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("test/the-heartbeat-measures-the-real-disk-consumers.test.ts: real roots, devices and unknown in an isolated byte-identical install", () => {
  const beat = measure();
  assert.equal(beat.consumer_docker_kb, "27000000");
  assert.equal(beat.consumer_docker_device, "/dev/data");
  assert.equal(beat.consumer_containerd_kb, "27200000");
  assert.equal(beat.consumer_containerd_device, "/dev/data");
  for (const key of Object.keys(beat).filter((key) => /^consumer_.*_kb$/.test(key)))
    assert.ok(beat[key.replace(/_kb$/, "_device")], `${key} needs device attribution`);
  for (const failure of ["partial", "junk", "missing"])
    assert.equal(measure({ BAD_CONTAINERD: failure }).consumer_containerd_kb, "unknown", failure);
  const blind = measure({ DF_FAIL: "1" });
  assert.equal(blind.consumer_docker_kb, "27000000");
  assert.equal(blind.consumer_docker_device, "unknown");
});

test("live bind sources, coverage scratch and the persistent disk are measured", () => {
  const beat = measure();
  assert.equal(beat.consumer_worktrees_kb, "42000");
  assert.equal(beat.consumer_worktrees_device, "/dev/scratch");
  assert.equal(beat.consumer_coverage_kb, "27000610");
  assert.equal(beat.consumer_coverage_device, "/dev/root,/dev/scratch");
  assert.equal(beat.consumer_rmd_tmp_kb, "800");
  assert.equal(beat.consumer_rmd_tmp_device, "/dev/data");
  assert.equal(beat.consumer_rmd_kb, "61000000");
  assert.equal(beat.consumer_rmd_device, "/dev/data");
});

test("a docker discovery failure falls back and non-measurement beats omit consumers", () => {
  const fallback = measure({ DOCKER_INFO_FAIL: "1" });
  assert.equal(fallback.consumer_docker_kb, "unknown");
  for (const failure of ["1", "junk", "partial"])
    assert.equal(measure({ DOCKER_INFO_FAIL: failure, DAEMON_CONFIG: "1" }).consumer_docker_kb, "13000");
  assert.equal(measure({ DOCKER_INFO_FAIL: "1", DAEMON_CONFIG: "junk" }).consumer_docker_kb, "unknown");
  assert.equal(measure({ DAEMON_CONFIG: "1" }).consumer_docker_kb, "27000000", "info takes precedence");
  assert.equal(measure({ DOCKER_KB: "0" }).consumer_docker_kb, "0", "a measured zero is retained");
  assert.deepEqual(Object.keys(measure({ BEAT_N: "1" })).filter((key) => key.startsWith("consumer_")), []);
});

test("the discovered docker root can be measured by the native du", () => {
  const kb = measure({ REAL_DU: "1" }).consumer_docker_kb;
  assert.match(kb, /^[0-9]+$/);
  assert.ok(Number(kb) >= 8 && Number(kb) < 27000000);
});

test("the whole-disk consumer reads its used space from statfs and never walks it with du", () => {
  const beat = measure();
  assert.equal(beat.consumer_rmd_kb, "61000000", "/mnt/rmd is a filesystem root: df's Used column, no du walk");
  assert.equal(beat.consumer_rmd_device, "/dev/data");
  assert.equal(beat.consumer_containerd_kb, "27200000", "a bind of a subdirectory still walks, or it would report the whole disk");
  assert.equal(measure({ FINDMNT_ABSENT: "1" }).consumer_rmd_kb, "60000000", "without findmnt the walk is the fallback");
});

test("every remaining du walk runs at idle io priority under ionice", () => {
  let log = "";
  measure({}, { inspect: (dir) => { log = readFileSync(join(dir, "ionice.log"), "utf8"); } });
  const walks = log.split("\n").filter(Boolean);
  assert.ok(walks.length > 0, "no du ran under ionice");
  for (const walk of walks) assert.match(walk, /^-c3 -t nice -n 19 du -sk /);
  assert.ok(walks.some((walk) => walk.endsWith("/var/lib/containerd")));
  assert.ok(!walks.some((walk) => walk.endsWith(" /mnt/rmd")), "the statfs read needs no walk");
});

test("a measuring beat whose push fails still advances the consumer pacing counter", () => {
  let count = "";
  measure({ PUBLISH: "1", GIT_PUSH_FAIL: "1", BEAT_N: "6" }, {
    status: 1,
    inspect: (dir) => { count = readFileSync(join(dir, "state-root/state/heartbeat-count.txt"), "utf8").trim(); },
  });
  assert.equal(count, "7", "a failed push must not leave the next beat on a measuring beat");
});
