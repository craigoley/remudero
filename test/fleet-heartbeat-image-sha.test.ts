/**
 * `scripts/fleet-heartbeat.sh` — THE THIRD SHA (W1-T496).
 *
 * WHY THIS FILE EXISTS. `daemon_boot_head_sha` (the boot ledger line) and `install_head_sha`
 * (`git rev-parse` on INSTALL_DIR) both read the MOUNTED checkout — W1-T494 files the case where
 * the two AGREE while both are stale, because a mount-side reading cannot see anything baked into
 * the IMAGE. MEASURED 2026-08-14: the running container's image was 124 commits behind
 * `origin/main`, four of them touching `deploy/` — a Dockerfile fix and an entrypoint fix among
 * them — and every diagnostic that reads the mount still read green, because the mount genuinely
 * was current. `deploy/Dockerfile` already bakes the image's own build sha into
 * `/etc/rmd-build-sha` (0444) at build time; nothing published it. This suite proves the beat now
 * does, that the published field is a genuinely different reading from the two mount shas, that a
 * failed or garbled read degrades to ABSENT rather than to a literal that could pass for healthy —
 * the Dockerfile's own `ARG RMD_BUILD_SHA=unknown` makes that a real, not hypothetical, case — and
 * that CLAUDE.md now writes down which half of a diff ships on merge and which needs a rebuild.
 *
 * THE SHAPE IS THE PROVEN ONE, mirrored from `test/fleet-heartbeat.test.ts` (W1-T483's restart
 * budget suite in the same file): stub the binaries on PATH, run the REAL committed script, assert
 * on a recording of what it actually published — never a re-implementation. The subject is
 * asserted byte-identical to the committed file on every unmutated run so a drifted fixture cannot
 * make a passing test meaningless, and the ABSENT-never-a-healthy-literal guard is proven with a
 * MUTANT: the unmutated script must reject `unknown`/garbage, and a copy with that rejection
 * removed must fail to reject it — otherwise the test would not be proving the guard exists.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_SCRIPT = join(REPO_ROOT, "scripts", "fleet-heartbeat.sh");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");

interface Beat {
  status: number;
  stdout: string;
  stderr: string;
  published: string;
}

/** A `git` stub answering the handful of subcommands this script reaches, git-plumbing only. */
function gitStub(): string {
  return [
    "#!/usr/bin/env bash",
    "args=(\"$@\"); i=0",
    'while [ "${args[$i]}" = "-C" ]; do i=$((i+2)); done',
    'sub="${args[$i]}"',
    'case "$sub" in',
    '  rev-parse)    printf "abc1234\\n" ;;',
    '  hash-object)  cat > /dev/null; printf "1111111111111111111111111111111111111111\\n" ;;',
    '  mktree)       cat > /dev/null; printf "2222222222222222222222222222222222222222\\n" ;;',
    '  commit-tree)  printf "3333333333333333333333333333333333333333\\n" ;;',
    '  push)         : ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * A container-runtime stub that answers `exec <container> cat /etc/rmd-build-sha` with a fixed
 * string, and a harmless `inspect` so the (unrelated, W1-T483) restart-budget probe does not
 * error out — its numeric fields are simply not asserted on here.
 */
function runtimeStub(execOutput: string | null): string {
  const body =
    execOutput === null
      ? ["exit 1"]
      : [`printf '%s' ${JSON.stringify(execOutput)}`, "exit 0"];
  return [
    "#!/usr/bin/env bash",
    'if [ "$1" = "exec" ]; then',
    ...body.map((l) => `  ${l}`),
    'elif [ "$1" = "inspect" ]; then',
    "  printf '0 0 unless-stopped\\n'",
    "fi",
    "",
  ].join("\n");
}

interface BeatOpts {
  ledger?: string[];
  env?: Record<string, string>;
  dockerStub?: string;
  mutate?: [string, string];
}

function runBeat(opts: BeatOpts = {}): Beat {
  const dir = mkdtempSync(join(tmpdir(), "fleet-heartbeat-imgsha-"));
  const binDir = join(dir, "stubbin");
  const scriptsDir = join(dir, "scripts");
  const root = join(dir, "root");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(dir, "node_modules", ".bin", "tsx"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(dir, "node_modules", ".bin", "tsx"), 0o755);

  // THE SUBJECT IS THE COMMITTED FILE. Copied only so INSTALL_DIR is controllable and, for the
  // mutant test, so the copy has something to edit — byte-equality is asserted below on every
  // unmutated run so a drifted fixture cannot make a passing test meaningless.
  const real = readFileSync(REAL_SCRIPT, "utf8");
  let source = real;
  if (opts.mutate) {
    const [find, replace] = opts.mutate;
    const n = source.split(find).length - 1;
    assert.equal(n, 1, `mutation target must be UNIQUE in the script, found ${n}: ${find}`);
    source = source.replace(find, replace);
    assert.notEqual(source, real, "the mutation must actually change the script");
  } else {
    assert.equal(source, real, "the unmutated subject must be byte-identical to the committed script");
  }
  const scriptPath = join(scriptsDir, "fleet-heartbeat.sh");
  writeFileSync(scriptPath, source, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);

  if (opts.ledger) writeFileSync(join(root, "state", "ledger.ndjson"), opts.ledger.join("\n") + "\n");

  writeFileSync(join(binDir, "git"), gitStub(), { mode: 0o755 });
  chmodSync(join(binDir, "git"), 0o755);

  const dockerPath = join(binDir, "rt-stub");
  if (opts.dockerStub) {
    writeFileSync(dockerPath, opts.dockerStub, { mode: 0o755 });
    chmodSync(dockerPath, 0o755);
  }

  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: join(dir, "home"),
      RMD_ROOT: root,
      RMD_HEARTBEAT_DRY_RUN: "1",
      RMD_HEARTBEAT_DOCKER: opts.dockerStub ? dockerPath : join(binDir, "no-such-runtime"),
      ...(opts.env ?? {}),
    },
  });

  const beat: Beat = {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    published: r.stdout ?? "",
  };
  rmSync(dir, { recursive: true, force: true });
  return beat;
}

/** `key=value` lookup over a published payload. */
function field(payload: string, key: string): string | undefined {
  const line = payload.split("\n").find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

const NOW = new Date();
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString();

const BOOT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const LEDGER_WITH_BOOT = [
  `{"ts":"${iso(9_000_000)}","step":"daemon.boot","head_sha":"${BOOT_SHA}"}`,
  `{"ts":"${iso(45_000)}","step":"daemon.alive","tick":1,"poll_interval_ms":60000}`,
];

const IMAGE_SHA = "b25b305491a113d94b0cb2d8b9aa6bf730c2a23b";

test("bash -n: the committed script parses", () => {
  const r = spawnSync("bash", ["-n", REAL_SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

// ── Claim 1: the image's own build sha is published where an off-host reader can see it without
// shelling into the container ──────────────────────────────────────────────────────────────────
test("a readable /etc/rmd-build-sha is published as image_build_sha in the beat", () => {
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub(IMAGE_SHA),
    env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" },
  });
  assert.equal(beat.status, 0, `${beat.stdout}\n${beat.stderr}`);
  assert.equal(field(beat.published, "image_build_sha"), IMAGE_SHA);
  // The reading is off a `docker exec … cat /etc/rmd-build-sha`, never a porcelain command that
  // would need a live shell session to interpret — the payload alone carries the answer.
  assert.match(String(field(beat.published, "image_build_sha_source")), /exec remudero-daemon cat \/etc\/rmd-build-sha$/);
});

// ── Claim 2: the published image sha is distinguishable from the two checkout shas the beat
// already emits ─────────────────────────────────────────────────────────────────────────────────
test("image_build_sha is a THIRD, independently-valued field — distinct from both mount-side shas", () => {
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub(IMAGE_SHA),
    env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" },
  });
  const image = field(beat.published, "image_build_sha");
  const bootSha = field(beat.published, "daemon_boot_head_sha");
  const installSha = field(beat.published, "install_head_sha");
  assert.equal(image, IMAGE_SHA);
  assert.equal(bootSha, BOOT_SHA);
  assert.equal(installSha, "abc1234");
  // This is the W1-T494 scenario inverted for proof: the two MOUNT shas can legitimately agree
  // (both are `abc1234`/`aaaa…` here, fixed by the stubs) while the IMAGE sha is a third, genuinely
  // different value — exactly the case where an image lagging behind a current mount would
  // otherwise be invisible to a reader of the other two fields alone.
  assert.notEqual(image, bootSha, "the image sha must not collapse onto the boot-ledger sha");
  assert.notEqual(image, installSha, "the image sha must not collapse onto the install-dir sha");
});

// ── Claim 3: an unreadable or unlabelled image degrades to absent rather than to a literal that
// reads as healthy ──────────────────────────────────────────────────────────────────────────────
test("no docker on the host: image_build_sha is ABSENT, not a placeholder", () => {
  const beat = runBeat({ ledger: LEDGER_WITH_BOOT, env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" } });
  assert.equal(beat.status, 0);
  assert.equal(field(beat.published, "image_build_sha"), undefined, "an unreadable image must publish NO field");
  assert.match(String(field(beat.published, "image_build_sha_source")), /^unavailable — no /);
});

test("RMD_HEARTBEAT_CONTAINER=none: image_build_sha is ABSENT, and the beat says why", () => {
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub(IMAGE_SHA),
    env: { RMD_HEARTBEAT_CONTAINER: "none" },
  });
  assert.equal(field(beat.published, "image_build_sha"), undefined);
  assert.match(String(field(beat.published, "image_build_sha_source")), /^skipped — RMD_HEARTBEAT_CONTAINER=none$/);
});

test("docker exec returns nothing (container has no /etc/rmd-build-sha yet): ABSENT, not an empty string", () => {
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub(""),
    env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" },
  });
  assert.equal(field(beat.published, "image_build_sha"), undefined);
  assert.match(String(field(beat.published, "image_build_sha_source")), /returned nothing$/);
});

test("docker exec times out / fails: ABSENT, not an empty string", () => {
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub(null),
    env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" },
  });
  assert.equal(field(beat.published, "image_build_sha"), undefined);
  assert.match(String(field(beat.published, "image_build_sha_source")), /returned nothing$/);
});

// THE CASE THE DOCKERFILE ITSELF MAKES REAL: `ARG RMD_BUILD_SHA=unknown` means an image built
// without the build arg writes the literal string `unknown` to /etc/rmd-build-sha. Publishing that
// verbatim would look like an odd-but-real sha rather than an absent reading — the exact failure
// direction `restart_count=0` (W1-T483) already established as the dangerous one for this beat.
test("docker exec returns the Dockerfile's own default `unknown`: ABSENT, never published as a sha", () => {
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub("unknown"),
    env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" },
  });
  assert.equal(field(beat.published, "image_build_sha"), undefined, "'unknown' must never be published as a sha");
  assert.match(String(field(beat.published, "image_build_sha_source")), /non-sha value$/);
});

test("docker exec returns other garbage (not hex): ABSENT, not published verbatim", () => {
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub("sha256:not-a-git-sha!"),
    env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" },
  });
  assert.equal(field(beat.published, "image_build_sha"), undefined);
  assert.match(String(field(beat.published, "image_build_sha_source")), /non-sha value$/);
});

test("MUTANT: removing the non-sha rejection is caught — 'unknown' would otherwise publish verbatim", () => {
  // With the `*[!0-9a-fA-F]*)` rejection branch's guard weakened to also accept anything, the
  // Dockerfile's own default value flows straight through as a published sha. THE MUTANT MUST
  // PRODUCE THE DEFECT — that is what proves the unmutated rejection above is load-bearing rather
  // than a check this suite never actually exercised.
  const beat = runBeat({
    ledger: LEDGER_WITH_BOOT,
    dockerStub: runtimeStub("unknown"),
    env: { RMD_HEARTBEAT_CONTAINER: "remudero-daemon" },
    mutate: [
      '    *[!0-9a-fA-F]*)\n      IMAGE_BUILD_SHA_SOURCE="unavailable — ${RESTART_RUNTIME} exec ${RESTART_CONTAINER} cat /etc/rmd-build-sha gave a non-sha value"\n      ;;',
      "    *[!0-9a-fA-F]*)\n      IMAGE_BUILD_SHA=\"$IMAGE_BUILD_SHA_RAW\"\n      IMAGE_BUILD_SHA_SOURCE=\"mutated-through\"\n      ;;",
    ],
  });
  assert.equal(
    field(beat.published, "image_build_sha"),
    "unknown",
    "the mutation must actually let 'unknown' through — otherwise this test proves nothing about the guard",
  );
});

// ── Claim 4: the mount-versus-rebuild boundary is written down so an author can tell which half
// a diff lands in ───────────────────────────────────────────────────────────────────────────────
test("CLAUDE.md documents the bind-mount-versus-image-rebuild boundary", () => {
  const text = readFileSync(CLAUDE_MD, "utf8");
  assert.match(
    text,
    /bind-mount|mounted checkout|image rebuild|baked/i,
    "CLAUDE.md must name the mount-vs-image boundary in at least one of its established terms",
  );
  // The table's two column headers, so this is checking the actual boundary content rather than a
  // single stray keyword match.
  assert.match(text, /ships on merge/i, "CLAUDE.md must say what ships on merge (the mount)");
  assert.match(text, /needs an image rebuild/i, "CLAUDE.md must say what needs an image rebuild (the image)");
  // `deploy/entrypoint.sh` is the one row people get wrong in the OTHER direction — the executed
  // entrypoint is baked, not mounted — and `node_modules` is the row people get wrong in THIS
  // direction, per the design doc; both must be named for the table to answer the question it was
  // written to answer.
  assert.match(text, /entrypoint\.sh/, "CLAUDE.md must name deploy/entrypoint.sh as image-baked");
  assert.match(text, /node_modules/, "CLAUDE.md must call out node_modules resolving to the mount");
});

test("CLAUDE.md names the operator-triggered build workflow, not an automatic one", () => {
  const text = readFileSync(CLAUDE_MD, "utf8");
  assert.match(
    text,
    /acr-build\.yml/,
    "the boundary doc must name the real build workflow rather than leaving 'an image rebuild' unexplained",
  );
});
