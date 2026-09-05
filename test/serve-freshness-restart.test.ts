import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderConsoleCodeStalenessHtml, renderShellHtml, buildShellRoute, CONSOLE_SHA_UNKNOWN } from "../src/lib/serve.js";
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

test("W1-T2562: the chosen disposition names what it costs in dropped console connections per day", () => {
  const src = SERVE_SRC();
  // (i) exit stale like the daemon: a measured median of 63 merges/day, ~every 23 minutes, each
  // restart dropping the live SSE connections the console holds open.
  assert.match(src, /63\/day|63 merges|median of 63/, "the rejected restart-on-merge option must name its measured cost");
  assert.match(src, /23 minutes/, "and the cadence that cost implies");
  // (iii) exit only when idle: ALREADY SHIPPED as W1-T2229, and it starves under real use.
  assert.match(src, /clients === 0/, "the already-shipped idle-exit gate must be named as the reason a third option is not proposed");
  assert.match(src, /20\s*\n?\s*\*?\s*hours|up 20/, "and the measurement showing it starving");
  // (ii), the chosen one, costs nothing in connections: it drops none.
  assert.match(src, /restarts deliberately/, "the chosen disposition must state that the human, not a timer, decides when a connection drops");
});

test("W1-T2562: the already-shipped idle exit is not removed or weakened by this disposition", () => {
  const src = SERVE_SRC();
  assert.match(src, /export function gateStaleCodeExit/, "W1-T2229's gate stays — a banner replaces nothing");
  assert.match(src, /if \(clients !== 0 \|\| inFlightWrites !== 0\) return;/, "and its refcount condition is untouched");
});

// ── criterion 3: observable without shelling in and comparing inodes ─────────────────────────

test("W1-T2562: a stale-code console is observable without shelling into the container", () => {
  const html = renderConsoleCodeStalenessHtml({ bootSha: "1c6fa65e1111", currentSha: "a01724932222" });
  assert.match(html, /STALE/, html);
  assert.ok(html.includes("1c6fa65e1111"), "the sha it is SERVING must be named");
  assert.ok(html.includes("a017249322"), "and the sha the checkout reads");
  assert.match(html, /Restart remudero-serve/, "and what to do about it — the human restarts deliberately");
});

test("W1-T2562: a current console says so, and never reads stale", () => {
  const html = renderConsoleCodeStalenessHtml({ bootSha: "1c6fa65e1111", currentSha: "1c6fa65e1111" });
  assert.match(html, /current/);
  assert.doesNotMatch(html, /STALE/);
});

test("W1-T2562: an unresolved sha reads UNDECIDED, never a confident current", () => {
  for (const input of [
    { bootSha: CONSOLE_SHA_UNKNOWN, currentSha: "a01724932222" },
    { bootSha: "1c6fa65e1111", currentSha: CONSOLE_SHA_UNKNOWN },
    { bootSha: CONSOLE_SHA_UNKNOWN, currentSha: CONSOLE_SHA_UNKNOWN },
  ]) {
    const html = renderConsoleCodeStalenessHtml(input);
    assert.match(html, /unknown/, JSON.stringify(input));
    assert.doesNotMatch(html, /STALE/, "an unreadable sha is not evidence of drift");
    // THE WHOLE DEFECT IS A CONFIDENT, WRONG YES. "current" must never be the degraded answer.
    assert.doesNotMatch(html, /class="console-code-current"/, JSON.stringify(input));
  }
});

test("W1-T2562: the shell carries the chip, beside the two it already renders server-side", () => {
  const stale = renderConsoleCodeStalenessHtml({ bootSha: "1c6fa65e1111", currentSha: "a01724932222" });
  const html = renderShellHtml(undefined, "1c6fa65e1111", "", undefined, stale);
  assert.ok(html.includes('id="console-code"'), "the chip must be in the shell");
  assert.ok(html.includes("loaded code"), "and labelled for an operator, not a reader of source");
  assert.match(html, /STALE — serving 1c6fa65e1111/, "with the banner's own text rendered");
  // Server-side and static, like its two siblings: no client-script field was added.
  assert.ok(html.includes('id="console-sha"') && html.includes('id="github-credential"'), "the sibling chips are untouched");
});

/** The `loaded code` chip's own inner text, isolated from the rest of the shell. The page ALSO
 *  carries a `#stale-badge` reading "STALE — showing last known data", which is DATA staleness —
 *  a different concern, resolved by `resolveFreshness`, and untouched here. Asserting over the
 *  whole document would read that badge as this chip's and pass (or fail) for the wrong reason. */
function chip(html: string): string {
  const m = /<span class="glance-value" id="console-code">([\s\S]*?)<\/span>\s*<\/span>/.exec(html);
  assert.ok(m, "the loaded-code chip must be present in the shell");
  return m![1]!;
}

test("W1-T2562: the shell defaults to `current` so every existing caller and test is unaffected", () => {
  const html = renderShellHtml();
  assert.doesNotMatch(chip(html), /STALE/, "an unparameterised render must not invent staleness");
  assert.match(chip(html), /current/);
  assert.ok(html.includes('id="stale-badge"'), "and the page's DATA-staleness badge is untouched — a different concern");
});

test("W1-T2562: the served shell resolves the CURRENT sha per request, not once at boot", () => {
  let resolutions = 0;
  const shell = buildShellRoute(undefined as never, "1c6fa65e1111", {}, undefined, () => {
    resolutions += 1;
    return "a01724932222";
  });
  const render = (): string => {
    let body = "";
    shell.handler({} as never, { writeHead: () => {}, end: (b: string) => (body = b) } as never, {} as never);
    return body;
  };
  const first = render();
  assert.match(first, /STALE — serving 1c6fa65e1111 while the checkout reads a017249322/, first.slice(0, 400));
  render();
  assert.equal(resolutions, 2, "a merge landing after boot must show on the very next page load, so the sha is re-read per request");
});

test("W1-T2562: a sha resolution that throws reads UNDECIDED rather than taking the shell down", () => {
  const shell = buildShellRoute(undefined as never, "1c6fa65e1111", {}, undefined, () => {
    throw new Error("git exploded");
  });
  let body = "";
  let threw = false;
  try {
    shell.handler({} as never, { writeHead: () => {}, end: (b: string) => (body = b) } as never, {} as never);
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "the console must still render — a broken staleness read is not a broken board");
  assert.match(body, /unknown/, "and the chip says it cannot tell, never `current`");
});
