import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RMD_TMP_PREFIX } from "../src/lib/tmp.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "deploy", "recycle-container.sh");
const BASH_BIN = ["/opt/homebrew/opt/bash/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"].find(existsSync) ?? "bash";

// ── W1-T5706: A LEFTOVER WORKER-SMOKE CONTAINER PINS NO IMAGE ──────────────────────────────────
//
// READ 2026-10-04 on the host: the recycle's reclaim (W1-T2585) protects every image ANY container
// uses, running or not, and by design never runs `docker container prune`. Its own worker smoke runs
// as `${CONTAINER_NAME}-worker-smoke` with `--rm`, and is removed only on the failure path — so a
// smoke left in Created state survives, pins a 4.0 GB image, and ~/reclaim.log reads
// "Total reclaimed space: 0B" every time.
//
// This suite drives the REAL script with a STATEFUL fake docker: a container table and an image
// table on disk. `container rm` really drops a row, and `image prune -af` really deletes every image
// no remaining row references — so "the smoke image is reclaimed" is an outcome of the removal, not
// an echo the stub was told to print. Drop the smoke removal and the smoke row still references its
// image, the prune frees nothing, and the first test below fails (the task's own falsifier).

const SMOKE = "remudero-daemon-worker-smoke";
const CASH = "rmd_cash_attempt_impl_gate_v4";

/** One container row: id, name, state (running|created|exited), image id. */
type Row = [id: string, name: string, state: string, image: string];

/** The host the task record read, reduced: the recycle's own Created smoke, an ad-hoc stopped
 *  container, the cash container, and a stopped container whose name merely CONTAINS the smoke
 *  name (docker's `--filter name=` is a substring match, so exactness must be the script's own). */
function hostRows(smokeState: string | null): Row[] {
  const rows: Row[] = [
    ["c-nifty", "nifty_black", "exited", "sha256:NIFTYIMAGE"],
    ["c-cash", CASH, "exited", "sha256:CASHIMAGE"],
    ["c-near", `${SMOKE}-old`, "exited", "sha256:NEARIMAGE"],
  ];
  if (smokeState) rows.unshift(["c-smoke", SMOKE, smokeState, "sha256:SMOKEIMAGE"]);
  return rows;
}

/** The image table: every image a row is built on, plus the digest the recycle pulls. */
const imagesOf = (rows: Row[]) => [...new Set([...rows.map((r) => r[3]), "sha256:PULLEDID"])];

function dockerStub(): string {
  return [
    "#!/usr/bin/env bash",
    'printf "%s" "$1" >> "$REC/calls"; for a in "${@:2}"; do printf "\\t%s" "$a" >> "$REC/calls"; done; printf "\\n" >> "$REC/calls"',
    'C="$REC/containers"; I="$REC/images"',
    'verb="$1"; shift',
    'case "$verb" in',
    "  ps)",
    '    if [ "$1" = "-aq" ]; then awk \'{print $1}\' "$C"; exit 0; fi',
    // `docker ps -a --filter name=X --format ...`: a SUBSTRING match, as docker's own is.
    '    pat=""; while [ $# -gt 0 ]; do case "$1" in --filter) pat="${2#name=}"; shift 2 ;; *) shift ;; esac; done',
    '    awk -v p="$pat" \'index($2, p) {print $1, $2, $3}\' "$C"; exit 0 ;;',
    "  container)",
    '    sub="$1"; shift',
    '    case "$sub" in',
    '      run) echo "WORKER-SMOKE PASS fixture"; exit 0 ;;',
    "      rm)",
    '        while [ "${1#-}" != "$1" ]; do shift; done',
    '        for id in "$@"; do',
    '          awk -v id="$id" \'$1 == id && $3 == "running" {r=1} END {exit r ? 0 : 1}\' "$C" && { echo "cannot remove running $id" >&2; exit 1; }',
    '          awk -v id="$id" \'$1 != id\' "$C" > "$C.new"; mv "$C.new" "$C"',
    "        done",
    "        exit 0 ;;",
    "    esac",
    "    exit 0 ;;",
    "  run)",
    // The new tenant comes up on the digest just pulled.
    '    name=""; while [ $# -gt 0 ]; do [ "$1" = "--name" ] && name="$2"; shift; done',
    '    echo "c-new $name running sha256:PULLEDID" >> "$C"; exit 0 ;;',
    "  image)",
    '    sub="$1"; shift',
    '    if [ "$sub" = "prune" ]; then',
    '      freed=0; : > "$I.new"',
    '      while read -r img uniq; do',
    '        if awk -v i="$img" \'$4 == i {f=1} END {exit f ? 0 : 1}\' "$C"; then echo "$img $uniq" >> "$I.new"; else echo "deleted: $img"; freed=1; fi',
    '      done < "$I"',
    '      mv "$I.new" "$I"',
    '      if [ "$freed" = 1 ]; then echo "Total reclaimed space: 4.0GB"; else echo "Total reclaimed space: 0B"; fi',
    "      exit 0",
    "    fi",
    '    if [ "$sub" = "inspect" ]; then',
    '      if [ "$1" = "--format" ]; then echo "sha256:PULLEDID"; exit 0; fi',
    '      awk -v i="$1" \'$1 == i {f=1} END {exit f ? 0 : 1}\' "$I"; exit $?',
    "    fi",
    "    exit 0 ;;",
    "  system)",
    // `docker system df -v`, the Images table only: IMAGE ID is the 12-char short id.
    '    echo "Images space usage:"; echo',
    '    echo "REPOSITORY   TAG   IMAGE ID   CREATED   SIZE   SHARED SIZE   UNIQUE SIZE   CONTAINERS"',
    '    while read -r img uniq; do s="${img#sha256:}"; echo "remudero <none> ${s:0:12} 2 days ago 4.26GB 246.6MB $uniq 1"; done < "$I"',
    '    echo; echo "Containers space usage:"; echo; echo "CONTAINER ID   IMAGE   COMMAND   LOCAL VOLUMES   SIZE   CREATED   STATUS   NAMES"',
    "    exit 0 ;;",
    "  inspect)",
    '    fmt=""',
    '    if [ "$1" = "--format" ]; then fmt="$2"; shift 2; fi',
    '    case "$fmt" in',
    '      "")  exit 1 ;;',
    '      *Mounts*)',
    '        printf "%s\\t/home/node/Remudero\\ttrue\\n" "${RMD_STATE_DIR:-$HOME/rmd-state2}"',
    '        printf "%s\\t/home/node/.claude\\ttrue\\n" "${RMD_CLAUDE_DIR:-$HOME/.claude}"',
    '        codex="${RMD_CODEX_DIR:-$HOME/.codex}"; [ ! -d "$codex" ] || printf "%s\\t/home/node/.codex\\ttrue\\n" "$codex"',
    '        config="${RMD_CONTAINER_CONFIG_DIR:-$HOME/.config/remudero-container}"; [ ! -d "$config" ] || printf "%s\\t/home/node/.config/remudero\\ttrue\\n" "$config"',
    "        exit 0 ;;",
    "    esac",
    // Every other format is answered per container, by id or by name, from the table.
    '    for ref in "$@"; do',
    '      awk -v r="$ref" -v f="$fmt" \'$1 == r || $2 == r { if (f ~ /State.Running/) print $4, "/" $2, ($3 == "running" ? "true" : "false"); else print $4 }\' "$C"',
    "    done",
    "    exit 0 ;;",
    "  pull)",
    '    echo "Status: Downloaded newer image"; exit 0 ;;',
    "esac",
    "exit 0",
    "",
  ].join("\n");
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
  calls: string[][];
  containers: string[];
  images: string[];
}

function recycle(rows: Row[], extraEnv: Record<string, string> = {}): Outcome {
  const binDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-pin-bin-`));
  const recDir = mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-pin-rec-`));
  writeFileSync(join(binDir, "docker"), dockerStub(), { mode: 0o755 });
  writeFileSync(join(binDir, "az"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(recDir, "containers"), rows.map((r) => r.join(" ")).join("\n") + "\n");
  writeFileSync(join(recDir, "images"), imagesOf(rows).map((i) => `${i} 4.0GB`).join("\n") + "\n");
  const cashKeyPath = join(recDir, "openweight-api-key");
  writeFileSync(cashKeyPath, "fixture-cash-key\n", { mode: 0o600 });

  const r = spawnSync(BASH_BIN, [SCRIPT], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REC: recDir,
      RMD_STATE_DIR: mkdtempSync(join(tmpdir(), `${RMD_TMP_PREFIX}smoke-pin-state-`)),
      RMD_DAEMON_CONTAINER: "remudero-daemon",
      RMD_RECYCLE_WAIT_S: "1",
      RMD_RECYCLE_POLL_S: "1",
      RMD_RECYCLE_FIRST_BOOT: "1",
      // Same credential neutralisation as test/nothing-reclaims-the-images-the-recycle-pulls.test.ts:
      // a synthetic shell token carries section 1, and the ambient App trio is stated EMPTY.
      GH_TOKEN: "fixture-token-value",
      GH_APP_ID: "",
      GH_APP_INSTALLATION_ID: "",
      GH_APP_PRIVATE_KEY_PATH: "",
      RMD_OPENWEIGHT_API_KEY_PATH: cashKeyPath,
      RMD_RECYCLE_DOCKERENV_PATH: join(tmpdir(), "smoke-pin-no-such-dockerenv-marker"),
      ...extraEnv,
    },
  });

  const lines = (f: string) => readFileSync(join(recDir, f), "utf8").split("\n").filter(Boolean);
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    calls: (existsSync(join(recDir, "calls")) ? lines("calls") : []).map((l) => l.split("\t")),
    containers: lines("containers").map((l) => l.split(" ")[1]),
    images: lines("images").map((l) => l.split(" ")[0]),
  };
}

const removals = (o: Outcome) => o.calls.filter((c) => (c[0] === "container" && c[1] === "rm") || c[0] === "rm");
const pinLines = (o: Outcome) => o.stdout.split("\n").filter((l) => /recycle-container:\s+PINNED /.test(l));

test("with a fake docker, a Created worker-smoke container from an earlier recycle is removed before the prune and its image is reclaimed, a stopped container with any other name still protects its image and is named in the pin report, and the cash container is never removed", () => {
  // Half one: the Created smoke is removed BEFORE the prune, so the prune reclaims its image.
  const left = recycle(hostRows("created"));
  assert.equal(left.status, 0, `expected a clean recycle; stderr:\n${left.stderr}`);
  const rmAt = left.calls.findIndex((c) => c[0] === "container" && c[1] === "rm" && c.includes("c-smoke"));
  const pruneAt = left.calls.findIndex((c) => c[0] === "image" && c[1] === "prune");
  assert.ok(rmAt >= 0, `the leftover ${SMOKE} must be removed; calls:\n${left.calls.map((c) => c.join(" ")).join("\n")}`);
  assert.ok(pruneAt > rmAt, "the smoke must be removed BEFORE the prune, or its image is still protected");
  assert.ok(!left.containers.includes(SMOKE), "the smoke row must be gone");
  assert.ok(!left.images.includes("sha256:SMOKEIMAGE"), `the smoke's image must be reclaimed; stdout:\n${left.stdout}`);
  assert.match(left.stdout, /reclaimed 4\.0GB/, left.stdout);
  // Every other stopped container still protects its image and is never removed.
  for (const keep of ["nifty_black", CASH, `${SMOKE}-old`]) assert.ok(left.containers.includes(keep), `${keep} must survive`);
  for (const img of ["sha256:NIFTYIMAGE", "sha256:CASHIMAGE", "sha256:NEARIMAGE", "sha256:PULLEDID"]) {
    assert.ok(left.images.includes(img), `${img} is still referenced and must survive the prune`);
  }
  assert.deepEqual(removals(left).map((c) => c[c.length - 1]), ["c-smoke"], "the smoke is the ONLY container removed");

  // Half two: with nothing left to reclaim, the 0B line names what pins each image.
  const pinned = recycle(hostRows(null));
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.match(pinned.stdout, /reclaimed 0B/, pinned.stdout);
  const nifty = pinLines(pinned).find((l) => l.includes("sha256:NIFTYIMAGE"));
  assert.ok(nifty, `the pin report must name the image nifty_black holds; stdout:\n${pinned.stdout}`);
  assert.match(nifty, /4\.0GB/, "with its unique bytes");
  assert.match(nifty, /\bnifty_black\b/, "and the container pinning it, by name");
  assert.deepEqual(removals(pinned), [], "the pin report removes nothing, the cash container included");
  assert.ok(pinned.containers.includes(CASH), "the cash container is never removed");
});

test("W1-T5706: a RUNNING worker-smoke container is never removed, and its image is not reported as a stopped pin", () => {
  const out = recycle(hostRows("running"));
  assert.equal(out.status, 1, "a live smoke blocks the recycle before another smoke can start");
  assert.match(out.stderr, new RegExp(`REFUSING.*${SMOKE} \\(running\\).*blocks the smoke`));
  assert.match(out.stderr, new RegExp(`docker rm ${SMOKE}`), "the refusal names the manual remedy");
  assert.deepEqual(removals(out), [], "a running smoke is someone's live probe, not a leftover");
  assert.ok(out.containers.includes(SMOKE));
  assert.ok(out.images.includes("sha256:SMOKEIMAGE"));
  assert.ok(!out.calls.some((c) => c[0] === "container" && c[1] === "run"), "no competing smoke starts");
  assert.ok(!out.calls.some((c) => c[0] === "image" && c[1] === "prune"), "refusal never reaches reclaim");
  assert.equal(pinLines(out).filter((l) => l.includes("sha256:SMOKEIMAGE")).length, 0, "a running container's image is not a stopped pin");
  assert.equal(pinLines(out).filter((l) => l.includes("sha256:PULLEDID")).length, 0, "nor is the tenant's own image");
});

test("W1-T5706: only the EXACT smoke name is removed — a name that merely contains it is a stopped pin, not a leftover", () => {
  const out = recycle(hostRows("exited"));
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(removals(out).map((c) => c[c.length - 1]), ["c-smoke"]);
  assert.ok(out.containers.includes(`${SMOKE}-old`), "docker's name filter is a substring match; the script's must not be");
  assert.ok(out.images.includes("sha256:NEARIMAGE"));
});

test("W1-T5706: a skipped reclaim still clears a stale smoke before the worker probe", () => {
  const out = recycle(hostRows("created"), { RMD_RECYCLE_SKIP_RECLAIM: "1" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /reclaim SKIPPED/, out.stdout);
  assert.match(out.stdout, new RegExp(`removed leftover ${SMOKE} \\(created\\) before the smoke`));
  assert.match(out.stdout, /worker smoke PASSED/, "the freed name is usable by the probe");
  assert.deepEqual(removals(out).map((c) => c[c.length - 1]), ["c-smoke"]);
  const removalAt = out.calls.findIndex((c) => c[0] === "container" && c[1] === "rm" && c.includes("c-smoke"));
  const smokeAt = out.calls.findIndex((c) => c[0] === "container" && c[1] === "run");
  assert.ok(removalAt >= 0 && smokeAt > removalAt, "the leftover is removed before the probe runs");
  assert.ok(!out.calls.some((c) => c[0] === "image" && c[1] === "prune"), "reclaim stays skipped");
  assert.ok(!out.containers.includes(SMOKE));
  assert.ok(out.containers.includes(`${SMOKE}-old`), "a name containing the smoke name remains");
});
