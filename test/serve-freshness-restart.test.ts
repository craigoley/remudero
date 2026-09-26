import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSOLE_SHA_UNKNOWN } from "../src/lib/serve.js";
import { DAEMON_EXIT_STALE } from "../src/lib/daemon.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const ENTRYPOINT = () => readFileSync(join(REPO_ROOT, "deploy", "entrypoint.sh"), "utf8");
const SERVE_SRC = () => readFileSync(join(REPO_ROOT, "src", "lib", "serve.ts"), "utf8");

// ── W1-T2562: rmd serve RUNS BOOT-TIME CODE WHILE THE CHECKOUT ADVANCES UNDER IT ─────────────
//
// MEASURED 2026-09-01: `remudero-serve` up 20 hours, ONE boot line, ZERO freshness restarts,
// booted at 1c6fa65e while `git rev-parse HEAD` inside that same container read a0172493 — 60
// commits ahead, dated 21 hours later. `remudero-daemon` over the same window: ELEVEN restarts.
//
// AND THE TWO CONTAINERS SHARE ONE CHECKOUT, WHICH IS WHAT MAKES IT INVISIBLE. `stat -c %d:%i` on
// package.json returns the IDENTICAL device:inode from both, so every file-level diagnostic run
// against serve reports CURRENT code — because the files genuinely are current. Only the loaded
// modules are stale, and nothing reported those. A reader checking "is serve up to date" by
// reading its tree got a confident, wrong yes.
//
// THE DISPOSITION IS (ii), THE CONSOLE BANNER, ratified by the operator. The shard named three and
// deliberately picked none; the two it did not choose are pinned below with what each costs, so a
// later reader can see the trade rather than re-derive it.

// ── criterion 1: the entrypoint's freshness branch is reachable for the verb serve runs ──────

test("W1-T2562: the entrypoint's freshness restart is not gated on a verb, so it is reachable for serve", () => {
  const sh = ENTRYPOINT();
  assert.ok(sh.includes(`DAEMON_EXIT_STALE=${DAEMON_EXIT_STALE}`), "control: the entrypoint really does duplicate the constant this branch keys on");
  // The restart loop keys on the EXIT CODE alone. Nothing narrows it to `rmd daemon`, so the
  // branch is structurally available to whatever `exec "$@"` runs — the falsifiable invariant the
  // shard says is worth pinning either way. What serve lacks is a reason to EMIT 75, not access
  // to the branch.
  assert.doesNotMatch(
    sh,
    /\$\{?1\}?["' ]*(==|=)\s*["']?daemon|case\s+"\$1"\s+in[\s\S]{0,400}daemon\)[\s\S]{0,400}DAEMON_EXIT_STALE/,
    "the freshness restart must not be conditioned on the daemon verb",
  );
});

test("W1-T2562: serve does not emit the freshness exit code, which is why the branch never fires for it", () => {
  const src = SERVE_SRC();
  assert.ok(!new RegExp(`exit\\(${DAEMON_EXIT_STALE}\\)`).test(src), "serve never exits 75 — the entrypoint is not wrong, it faithfully restarts on a signal serve does not send");
  assert.ok(/gateStaleCodeExit/.test(src), "control: serve DOES carry a stale-code exit path, so this query can see its corpus");
});

// ── criterion 2: the chosen disposition names what it costs ──────────────────────────────────

test("W1-T2562: the already-shipped idle exit is not removed or weakened by this disposition", () => {
  const src = SERVE_SRC();
  assert.match(src, /export function gateStaleCodeExit/, "W1-T2229's gate stays — a banner replaces nothing");
  // SUPERSEDED LINE, NOT A WEAKENED ONE. This used to pin the literal
  // `if (clients !== 0 || inFlightWrites !== 0) return;`. The client half of that condition was
  // deliberately replaced by a backlog-scaled budget — see `consoleRecyclePatienceMs` and
  // test/serve-recycles-under-change-pressure.test.ts — because the edge-only trigger left the
  // live console 8 commits behind for 3h25m (MEASURED 2026-09-15). What this criterion was
  // actually protecting is that the gate never exits out from under work, and THAT half is
  // absolute and still pinned here, as a line pressure can never reach past.
  assert.match(src, /if \(inFlightWrites !== 0\) return;/, "an in-flight write is still an unconditional refusal");
  // SUPERSEDED A SECOND TIME, SAME REASON. The free-moment line was `clients === 0`; it is now
  // `attention <= 0`, because counting only SSE SUBSCRIBERS reported "nobody watching" while an
  // operator was reading the polling console, and the daemon recycled out from under him
  // (MEASURED 2026-09-15: an 86.5s boot window, cloudflared logging connection refused and then
  // connection reset by peer against remudero-serve:4317). The invariant this criterion protects
  // is that a GENUINELY free moment still costs nothing, and that is what is pinned — over the
  // broader signal rather than the narrower one.
  assert.match(src, /if \(attention <= 0\) return RECYCLE_PATIENCE_FREE_MS;/, "a genuinely unwatched moment still costs nothing to take");
  assert.match(
    src,
    /const attention = clients \+ readAttention\(msSinceLastRead\);/,
    "and 'watched' means read OR subscribed, so a polling console is not invisible to the gate",
  );
});

// ── criterion 3: observable without shelling in and comparing inodes ─────────────────────────





/** The `loaded code` chip's own inner text, isolated from the rest of the shell. The page ALSO
 *  carries a `#stale-badge` reading "STALE — showing last known data", which is DATA staleness —
 *  a different concern, resolved by `resolveFreshness`, and untouched here. Asserting over the
 *  whole document would read that badge as this chip's and pass (or fail) for the wrong reason. */
function chip(html: string): string {
  const m = /<span class="glance-value" id="console-code">([\s\S]*?)<\/span>\s*<\/span>/.exec(html);
  assert.ok(m, "the loaded-code chip must be present in the shell");
  return m![1]!;
}



