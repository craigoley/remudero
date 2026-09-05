import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECLARED_OPERATOR_DEPLOY_SCRIPTS = [
  "deploy/host-update.sh",
  "deploy/recycle-container.sh",
  "deploy/verify-image.sh",
] as const;

/**
 * test/deploy-scripts-use-mktemp.test.ts — W1-T2915.
 *
 * `deploy/recycle-container.sh` teed `docker pull` into the FIXED path
 * `/tmp/recycle-container-pull.log` and then GREPPED THAT SAME PATH for
 * `authentication required|unauthorized|denied` to decide whether the pull failed on credentials.
 * `/tmp` on this host is sticky and world-writable with two real accounts, so the name is
 * reachable three ways: a pre-existing file owned by another uid makes the `tee` fail outright
 * (host-update.sh MEASURED exactly that — `Permission denied`, 2026-09-04), a symlink makes it
 * write through, and a pre-seeded file merely CONTAINING "denied" flips the verdict. The read side
 * is the sharper half: it turns a scratch path into an input the script trusts.
 *
 * WHAT THE SWEEP ACTUALLY FOUND, re-derived here rather than taken from the filing:
 *   deploy/recycle-container.sh  the one real host-side instance — FIXED by this task
 *   deploy/host-update.sh        ALREADY FIXED; its `/tmp/` hits are the COMMENT recording that fix
 *   deploy/verify-image.sh       two `mktemp -d` calls, but INSIDE `docker run --rm` — they run in
 *                                a throwaway container, touch no host state, and are correctly out
 *                                of scope. A census that demanded an `rmd-` prefix there would be
 *                                asking for a reapable name in a filesystem that ceases to exist.
 *   recycle-container.sh:950     `worktree/tmp/worker-home` inside a printf — a SUBSTRING, not a
 *                                path. The naive regex the filing implies flags it.
 *
 * So the predicate below is scoped and both of its directions are tested: the two false positives
 * above are what a bare `grep /tmp/` would have reported, and reporting them would have made this
 * census something authors learn to route around.
 */

/** The `rmd-` prefix is load-bearing: src/lib/tmp.ts's sweepStaleTempDirs reaps only names that
 *  carry it (W1-T2773), so a per-invocation name WITHOUT it trades a collision for a permanent
 *  leak — the exact thing that campaign exists to stop. */
export const REAPABLE_PREFIX = "rmd-";

export function deployScripts(root = REPO_ROOT): string[] {
  return execFileSync("git", ["ls-files", "deploy/*.sh"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

export function declaredOperatorDeployScripts(root = REPO_ROOT): string[] {
  const tracked = new Set(deployScripts(root));
  const missing = DECLARED_OPERATOR_DEPLOY_SCRIPTS.filter((f) => !tracked.has(f));
  assert.deepEqual(missing, [], "the declared operator-run deploy scripts must stay tracked");
  return [...DECLARED_OPERATOR_DEPLOY_SCRIPTS];
}

/**
 * Which lines run ON THE HOST, as opposed to inside a script handed to `docker run`.
 *
 * A `docker run … sh -c '…'` block is a DIFFERENT filesystem with a different lifetime: with
 * `--rm` the container is the cleanup, so a trap and a reapable prefix there defend nothing. The
 * region is detected by single-quote parity opened on a `docker run` line — a real structural
 * property, not an allowlist, so a NEW container script is classified correctly the day it lands
 * instead of needing a row added for it.
 */
export function hostScopedLines(script: string): Array<{ n: number; text: string }> {
  const out: Array<{ n: number; text: string }> = [];
  let inContainer = false;
  script.split("\n").forEach((text, i) => {
    const oddQuotes = (text.match(/'/g) ?? []).length % 2 === 1;
    if (!inContainer) {
      out.push({ n: i + 1, text });
      if (/\bdocker\s+run\b/.test(text) && oddQuotes) inContainer = true;
    } else if (oddQuotes) {
      // The CLOSING line is host shell — it carries the `' 2>&1)"` that ends the command
      // substitution — so it is included. Its left-hand side is technically still container text,
      // which makes this marginally over-inclusive; that errs toward FLAGGING, the safe direction
      // for a gate, and the real files have nothing on that side of the quote.
      inContainer = false;
      out.push({ n: i + 1, text });
    }
  });
  return out;
}

/** A literal `/tmp/<name>` used AS A PATH — `/tmp/` must sit at a path boundary, so the
 *  `worktree/tmp/worker-home` substring inside a printf is not a match, and `${TMPDIR:-/tmp}` is
 *  not one either (no trailing slash before a name). Comment lines are excluded: host-update.sh's
 *  own hits are the prose recording that it was fixed. */
export function literalTmpPaths(script: string): Array<{ n: number; text: string }> {
  return hostScopedLines(script)
    .filter(({ text }) => !/^\s*#/.test(text))
    .filter(({ text }) => /(^|[\s"'`>|=(:])\/tmp\/[A-Za-z0-9_.-]/.test(text));
}

/**
 * Host-scoped `mktemp` invocations, classified by WHAT THEY ALLOCATE — because two different
 * idioms wear the same call and only one of them owes a reapable name:
 *
 *   TEMP-DIR    — the template names a temp dir (`${TMPDIR:-/tmp}/…`, a literal `/tmp/…`) or there
 *                 is NO template at all (bare `mktemp` / `mktemp -d` defaults to TMPDIR). This is
 *                 the leak class: the file outlives the run if nothing removes it, and
 *                 `sweepStaleTempDirs` can only reap it if it carries {@link REAPABLE_PREFIX}.
 *   SIBLING     — the template is a computed directory that is NOT a temp dir, i.e. the
 *                 same-directory staging file of a `mktemp` + `mv -f` ATOMIC WRITE. It is renamed
 *                 over its target, so it neither leaks nor is ever seen by a sweep of /tmp, and
 *                 demanding the prefix there would be asking for a reapable name in a directory
 *                 nothing reaps. `deploy/install-container-runtime-mount-order.sh`'s `atomic_write`
 *                 is the real instance, and conflating the two flagged it on the first draft.
 */
export interface MktempSite {
  readonly n: number;
  readonly text: string;
  readonly kind: "temp-dir" | "sibling";
  readonly prefixed: boolean;
}

export function hostMktempSites(script: string): MktempSite[] {
  return hostScopedLines(script)
    .filter(({ text }) => /\bmktemp\b/.test(text) && !/^\s*#/.test(text))
    .map(({ n, text }) => {
      // A captured token starting with `-` is a FLAG, not a template: `mktemp -d` with no
      // template defaults to TMPDIR and is therefore temp-dir, not sibling. The first draft's
      // regex captured `-d` as the template and classified the leak class as exempt — the exact
      // direction a census must never be wrong in.
      const captured = /mktemp\s+((?:-\w+\s*)*)["']?([^"'\s)]*)/.exec(text)?.[2];
      const template = captured === undefined || captured === "" || captured.startsWith("-") ? undefined : captured;
      const namesTempDir = template === undefined || /TMPDIR|^\/tmp\//.test(template);
      return { n, text, kind: namesTempDir ? ("temp-dir" as const) : ("sibling" as const), prefixed: text.includes(REAPABLE_PREFIX) };
    });
}

/** The shell variable a `mktemp` site assigns to, or `undefined` when it assigns to none. */
export function allocatedVar(text: string): string | undefined {
  return /(?:^|\s|!\s*)([A-Za-z_]\w*)="?\$\(\s*mktemp\b/.exec(text)?.[1] ?? /\blocal\s+(\w+)\b/.exec(text)?.[1];
}

/**
 * Is THIS site's allocation cleaned up by a pre-installed `trap … EXIT` whose cleanup function
 * names ITS OWN variable?
 *
 * SCOPED TO THE VARIABLE, NOT THE SCRIPT, and that is the whole point. The first draft asked only
 * whether the file contained any `trap … EXIT` or any `rm -f "${…}"`; recycle-container.sh is
 * 1100 lines and carries plenty of unrelated `rm -f`s, so deleting this task's OWN trap and its
 * own `rm -f` left the census GREEN. The second draft still accepted a bare `rm -f` with no trap;
 * this predicate now requires the trap handler itself, registered before the allocation.
 */
export function cleanupFunctionBody(script: string, name: string): string | undefined {
  const lines = hostScopedLines(script);
  const start = lines.findIndex(({ text }) => new RegExp(`^\\s*${name}\\s*\\(\\)\\s*\\{\\s*$`).test(text));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const { text } of lines.slice(start + 1)) {
    if (/^\s*}\s*$/.test(text)) return body.join("\n");
    body.push(text);
  }
  return undefined;
}

export function trapHandlersBefore(script: string, n: number): string[] {
  return hostScopedLines(script)
    .filter(({ n: line, text }) => line < n && !/^\s*#/.test(text))
    .map(({ text }) => /\btrap\s+([A-Za-z_]\w*)\s+EXIT\b/.exec(text)?.[1])
    .filter((handler): handler is string => handler !== undefined);
}

export function cleanupFunctionRemovesVar(script: string, name: string, variable: string): boolean {
  const body = cleanupFunctionBody(script, name);
  if (body === undefined) return false;
  const ref = new RegExp(`\\$\\{?${variable}\\b`);
  return body.split("\n").some((text) => /\brm\s+-f/.test(text) && ref.test(text));
}

export function siteHasPreInstalledExitTrap(script: string, site: MktempSite): boolean {
  const v = allocatedVar(site.text);
  if (v === undefined) return false;
  return trapHandlersBefore(script, site.n).some((handler) => cleanupFunctionRemovesVar(script, handler, v));
}

// ── the census over the real tree ──────────────────────────────────────────────────────────────

test("W1-T2915: no operator-run deploy script writes to or reads a literal /tmp path", () => {
  const scripts = declaredOperatorDeployScripts();
  assert.equal(scripts.length, DECLARED_OPERATOR_DEPLOY_SCRIPTS.length, `the census must SEE the declared corpus (found ${scripts.length} scripts)`);

  const offenders: string[] = [];
  for (const f of scripts) {
    for (const { n, text } of literalTmpPaths(readFileSync(join(REPO_ROOT, f), "utf8"))) {
      offenders.push(`  ${f}:${n}: ${text.trim().slice(0, 110)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a fixed /tmp path in a script run on a sticky, world-writable, two-account host is " +
      "pre-creatable by anyone: the write can fail or follow a symlink, and a path the script " +
      "later READS is an input it trusts.\n" +
      offenders.join("\n") +
      `\n  THE REMEDY: TMP=$(mktemp "\${TMPDIR:-/tmp}/${REAPABLE_PREFIX}<name>.XXXXXX") with ` +
      "an EXIT trap installed BEFORE it, exactly as deploy/host-update.sh does.",
  );
});

test("W1-T2915: every declared host-scoped temp-dir mktemp has a pre-installed EXIT cleanup trap", () => {
  const withMktemp: string[] = [];
  const offenders: string[] = [];
  for (const f of declaredOperatorDeployScripts()) {
    const src = readFileSync(join(REPO_ROOT, f), "utf8");
    const tempDirSites = hostMktempSites(src).filter((s) => s.kind === "temp-dir");
    if (tempDirSites.length === 0) continue;
    withMktemp.push(f);
    for (const s of tempDirSites) {
      if (!s.prefixed) offenders.push(`  ${f}:${s.n}: mktemp without the '${REAPABLE_PREFIX}' prefix — sweepStaleTempDirs cannot reap it`);
      if (!siteHasPreInstalledExitTrap(src, s)) {
        offenders.push(`  ${f}:${s.n}: ${allocatedVar(s.text) ?? "this allocation"} is not removed by a cleanup function already trapped on EXIT`);
      }
    }
  }
  // CONTROL: a zero here would make the assertion below vacuous over an empty set.
  assert.ok(withMktemp.length >= 2, `the census must find real host-scoped temp-dir users (found ${withMktemp.length})`);
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

// ── the predicate, both directions ─────────────────────────────────────────────────────────────

test("W1-T2915: the predicate matches a real fixed path and NOT the two things a bare grep would flag", () => {
  assert.equal(literalTmpPaths('tee /tmp/recycle-container-pull.log').length, 1, "the instance this task fixed");
  assert.equal(literalTmpPaths('grep -q x /tmp/some.log 2>/dev/null').length, 1, "the READ side too");
  assert.equal(literalTmpPaths('out="$(cat /tmp/a.txt)"').length, 1, "inside a substitution");

  assert.equal(literalTmpPaths('# this script wrote /tmp/host-update-pull.log until 2026-09-04').length, 0,
    "a COMMENT recording the old path is not a use — host-update.sh's own hits are exactly this");
  assert.equal(literalTmpPaths(`printf '{"cleaned":"none — worktree/tmp/worker-home have owners"}'`).length, 0,
    "worktree/tmp/ is a SUBSTRING, not a path — the naive regex flags it");
  assert.equal(literalTmpPaths('TMPDIR_="${TMPDIR:-/tmp}"').length, 0, "the TMPDIR fallback names no file");
  assert.equal(literalTmpPaths('T="$(mktemp "${D%/}/rmd-x.XXXXXX")"').length, 0, "the fixed form itself");
});

test("W1-T2915: host scope stops at a docker-run script, and resumes after it", () => {
  const script = [
    'host_before=/tmp/a.log',
    "out=\"$(docker run --rm \"${REF}\" sh -c '",
    '  d=$(mktemp -d)',
    '  echo /tmp/inside-the-container',
    "' 2>&1)\"",
    'host_after=/tmp/b.log',
  ].join("\n");
  const host = hostScopedLines(script).map((l) => l.n);
  assert.deepEqual(host, [1, 2, 5, 6], "lines 3-4 run in the container, not on the host");

  const flagged = literalTmpPaths(script).map((l) => l.n);
  assert.deepEqual(flagged, [1, 6], "the container's own /tmp path is not the host's problem");
  assert.deepEqual(hostMktempSites(script), [], "and its mktemp -d is not a host site");

  // The other direction: the SAME mktemp on the host IS a site, and is unprefixed.
  assert.deepEqual(hostMktempSites("d=$(mktemp -d)"), [
    { n: 1, text: "d=$(mktemp -d)", kind: "temp-dir", prefixed: false },
  ], "a bare `mktemp -d` has no template and defaults to TMPDIR — it is the leak class, not a sibling");
  const prefixed = hostMktempSites('T="$(mktemp "${TMPDIR:-/tmp}/rmd-x.XXXXXX")"')[0]!;
  assert.equal(prefixed.kind, "temp-dir");
  assert.equal(prefixed.prefixed, true);
  // And the atomic-write idiom: a template naming a computed sibling directory is NOT temp-dir.
  const sibling = hostMktempSites('tmp="$(mktemp "${dir}/.$(basename "${target}").XXXXXX")"')[0]!;
  assert.equal(sibling.kind, "sibling", "same-directory staging for an atomic rename owes no reapable name");
});

test("W1-T2915: cleanup proof rejects rm-only cleanup and traps installed after mktemp", () => {
  const hasTrap = (script: string): boolean => {
    const site = hostMktempSites(script)[0]!;
    return siteHasPreInstalledExitTrap(script, site);
  };

  assert.equal(hasTrap([
    'PULL_LOG=""',
    'cleanup_tmp() {',
    '  [ -n "${PULL_LOG}" ] && rm -f "${PULL_LOG}"',
    '}',
    'trap cleanup_tmp EXIT',
    'PULL_LOG="$(mktemp "${TMPDIR:-/tmp}/rmd-recycle.XXXXXX")"',
  ].join("\n")), true, "the fixed shape registers the cleanup trap before allocation");

  assert.equal(hasTrap([
    'PULL_LOG=""',
    'cleanup_tmp() {',
    '  [ -n "${PULL_LOG}" ] && rm -f "${PULL_LOG}"',
    '}',
    'PULL_LOG="$(mktemp "${TMPDIR:-/tmp}/rmd-recycle.XXXXXX")"',
  ].join("\n")), false, "a bare rm helper is not enough without the EXIT trap");

  assert.equal(hasTrap([
    'PULL_LOG=""',
    'cleanup_tmp() {',
    '  [ -n "${PULL_LOG}" ] && rm -f "${PULL_LOG}"',
    '}',
    'PULL_LOG="$(mktemp "${TMPDIR:-/tmp}/rmd-recycle.XXXXXX")"',
    'trap cleanup_tmp EXIT',
  ].join("\n")), false, "the trap has to be installed before the mktemp can fail");
});

test("W1-T2915: the container-scope detection is derived, not an allowlist — verify-image.sh's real sites are classified by it", () => {
  // The two `mktemp -d` calls this census must NOT demand a prefix from are inside
  // `docker run --rm` blocks in the real file, and the classifier is what says so.
  const src = readFileSync(join(REPO_ROOT, "deploy", "verify-image.sh"), "utf8");
  const raw = src.split("\n").filter((l) => /\bmktemp\b/.test(l) && !/^\s*#/.test(l));
  assert.ok(raw.length >= 2, `verify-image.sh still has the container-side mktemp calls (found ${raw.length})`);
  assert.deepEqual(hostMktempSites(src), [], "and none of them is host-scoped");
});
