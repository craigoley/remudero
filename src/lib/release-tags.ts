/**
 * W1-T4528 — a release decision leaves a record in git.
 *
 * The primary's deploy judge (`accumulateDeployRestartPressure`) decides when stale code is worth a
 * restart, and until now only its own ledger knew. This module turns that decision into an
 * ANNOTATED tag `release/<YYYYMMDD>-<n>` whose message is a MANIFEST: `key: value` lines after a
 * title line, one `change:` line per scored change. {@link formatReleaseManifest} and
 * {@link parseReleaseManifest} are exact inverses, so the next phases can read a release back.
 *
 * Tags are APPEND-ONLY: this module never moves or deletes one. A name collision retries with the
 * next `n`; any other failure is logged as `release.mint_failed` and swallowed, because the
 * restart the decision already made must never wait on, or fail because of, a bookkeeping tag.
 *
 * Credential path (the caller's {@link ReleaseTagIo}): `deployer.ts` mints through `gh api` under
 * the fleet GitHub App's INSTALLATION token — `process.env.GH_TOKEN`, written by
 * `refreshInstallationToken` (src/lib/github-app.ts) before any verb dispatches — never the
 * workflow `GITHUB_TOKEN`, whose pushes start no workflow run.
 */

export const RELEASE_TAG_PREFIX = "release/";
export const RELEASE_MINTED_STEP = "release.minted";
export const RELEASE_MINT_FAILED_STEP = "release.mint_failed";
export const RELEASE_MINT_SKIPPED_STEP = "release.mint_skipped";
/** BACKSTOP: how many consecutive collisions one mint tolerates before giving up (logged, never
 *  thrown). The primary control is the fresh tag-name derivation each attempt; this only stops a
 *  pathological collision loop. */
export const RELEASE_MINT_MAX_ATTEMPTS = 5;

const MANIFEST_TITLE = "remudero release";
const ABSENT = "none";

export interface ReleaseChange {
  sha: string;
  score: number;
  reason: string;
}

export interface ReleaseManifest {
  sourceSha: string;
  /** The registry image built for the newest baked-path commit at or before `sourceSha`. */
  imageRef?: string;
  /** The release tag this one follows, absent for the first. */
  prevRelease?: string;
  total: number;
  threshold: number;
  decidedAt: string;
  changes: readonly ReleaseChange[];
}

/** A manifest value lives on one line: collapse any whitespace run (newlines included) to a space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatReleaseManifest(m: ReleaseManifest): string {
  const lines = [
    MANIFEST_TITLE,
    `source_sha: ${m.sourceSha}`,
    `image_ref: ${m.imageRef === undefined ? ABSENT : oneLine(m.imageRef)}`,
    `prev_release: ${m.prevRelease === undefined ? ABSENT : oneLine(m.prevRelease)}`,
    `total: ${m.total}`,
    `threshold: ${m.threshold}`,
    `decided_at: ${m.decidedAt}`,
    ...m.changes.map((c) => {
      const reason = oneLine(c.reason);
      return reason === "" ? `change: ${c.sha} ${c.score}` : `change: ${c.sha} ${c.score} ${reason}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

/** The inverse of {@link formatReleaseManifest}; `undefined` for text that is not a manifest. */
export function parseReleaseManifest(text: string): ReleaseManifest | undefined {
  const lines = text.split("\n").filter((l, i, all) => !(i === all.length - 1 && l === ""));
  if (lines[0] !== MANIFEST_TITLE) return undefined;
  const scalars = new Map<string, string>();
  const changes: ReleaseChange[] = [];
  for (const line of lines.slice(1)) {
    const change = /^change: (\S+) (-?\d+(?:\.\d+)?)(?: (.*))?$/.exec(line);
    if (change) {
      changes.push({ sha: change[1], score: Number(change[2]), reason: change[3] ?? "" });
      continue;
    }
    const kv = /^([a-z_]+): (.*)$/.exec(line);
    if (!kv || scalars.has(kv[1])) return undefined;
    scalars.set(kv[1], kv[2]);
  }
  const sourceSha = scalars.get("source_sha");
  const decidedAt = scalars.get("decided_at");
  const total = Number(scalars.get("total"));
  const threshold = Number(scalars.get("threshold"));
  if (!sourceSha || !decidedAt || !Number.isFinite(total) || !Number.isFinite(threshold)) return undefined;
  const optional = (key: string): string | undefined => {
    const v = scalars.get(key);
    return v === undefined || v === ABSENT ? undefined : v;
  };
  const imageRef = optional("image_ref");
  const prevRelease = optional("prev_release");
  return {
    sourceSha,
    ...(imageRef === undefined ? {} : { imageRef }),
    ...(prevRelease === undefined ? {} : { prevRelease }),
    total,
    threshold,
    decidedAt,
    changes,
  };
}

/** `release/20261002-3` → `{ date: "20261002", n: 3 }`; anything else is not a release tag. */
export function parseReleaseTagName(name: string): { date: string; n: number } | undefined {
  const m = /^release\/(\d{8})-(\d+)$/.exec(name);
  return m ? { date: m[1], n: Number(m[2]) } : undefined;
}

export function releaseTagName(date: string, n: number): string {
  return `${RELEASE_TAG_PREFIX}${date}-${n}`;
}

/** `n` = 1 + the highest `n` among `existing` tags dated `date` (1 when none). */
export function nextReleaseNumber(date: string, existing: readonly string[]): number {
  let highest = 0;
  for (const name of existing) {
    const p = parseReleaseTagName(name);
    if (p && p.date === date && p.n > highest) highest = p.n;
  }
  return highest + 1;
}

/** The newest release tag among `existing` (latest date, then highest n), or undefined. */
export function latestReleaseTag(existing: readonly string[]): string | undefined {
  let best: { name: string; date: string; n: number } | undefined;
  for (const name of existing) {
    const p = parseReleaseTagName(name);
    if (!p) continue;
    if (!best || p.date > best.date || (p.date === best.date && p.n > best.n)) best = { name, ...p };
  }
  return best?.name;
}

/** The seam to git/GitHub. `createTag` MUST refuse (throw) when the name already exists. */
export interface ReleaseTagIo {
  listTags: () => readonly string[];
  createTag: (name: string, sourceSha: string, message: string) => void;
  isCollision: (err: unknown) => boolean;
}

export interface MintReleaseInput extends Omit<ReleaseManifest, "prevRelease"> {
  /** W1-T4527's answer. Only `true` mints; `false` and `undefined` (unknown) mint nothing. */
  isPrimary: boolean | undefined;
}

export type MintReleaseResult =
  | { minted: true; tag: string; attempts: number }
  | { minted: false; reason: string };

/**
 * Mint the release tag for a restart decision. NEVER THROWS: every failure is a returned
 * `{ minted: false }` plus a `release.mint_failed` row, so the deploy that follows is unaffected.
 */
export function mintReleaseTag(
  input: MintReleaseInput,
  io: ReleaseTagIo,
  log: (step: string, data?: Record<string, unknown>) => void,
): MintReleaseResult {
  if (input.isPrimary !== true) {
    const reason = input.isPrimary === false ? "not the primary" : "primary unknown";
    log(RELEASE_MINT_SKIPPED_STEP, { reason, source_sha: input.sourceSha });
    return { minted: false, reason };
  }
  const date = input.decidedAt.slice(0, 10).replace(/-/g, "");
  if (!/^\d{8}$/.test(date)) {
    const reason = `decided_at is not an ISO timestamp: ${input.decidedAt}`;
    log(RELEASE_MINT_FAILED_STEP, { reason, source_sha: input.sourceSha });
    return { minted: false, reason };
  }
  let existing: readonly string[];
  try {
    existing = io.listTags();
  } catch (err) {
    const reason = `could not list release tags: ${err instanceof Error ? err.message : String(err)}`;
    log(RELEASE_MINT_FAILED_STEP, { reason, source_sha: input.sourceSha });
    return { minted: false, reason };
  }
  const known = [...existing];
  const { isPrimary: _isPrimary, ...rest } = input;
  for (let attempt = 1; attempt <= RELEASE_MINT_MAX_ATTEMPTS; attempt += 1) {
    const tag = releaseTagName(date, nextReleaseNumber(date, known));
    const prevRelease = latestReleaseTag(known);
    const message = formatReleaseManifest({ ...rest, ...(prevRelease === undefined ? {} : { prevRelease }) });
    try {
      io.createTag(tag, input.sourceSha, message);
    } catch (err) {
      if (io.isCollision(err)) {
        known.push(tag); // somebody holds this name — append-only means we take the next, never move it
        continue;
      }
      const reason = err instanceof Error ? err.message : String(err);
      log(RELEASE_MINT_FAILED_STEP, { reason, tag, source_sha: input.sourceSha, attempt });
      return { minted: false, reason };
    }
    log(RELEASE_MINTED_STEP, {
      tag,
      source_sha: input.sourceSha,
      prev_release: prevRelease ?? null,
      total: input.total,
      threshold: input.threshold,
      attempts: attempt,
    });
    return { minted: true, tag, attempts: attempt };
  }
  const reason = `${RELEASE_MINT_MAX_ATTEMPTS} consecutive name collisions`;
  log(RELEASE_MINT_FAILED_STEP, { reason, source_sha: input.sourceSha });
  return { minted: false, reason };
}
