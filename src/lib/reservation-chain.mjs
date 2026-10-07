/**
 * Pure reservation-holder parsing and takeover adjudication shared by the runtime review and the
 * task-id-existence gate. Keep this under src/: source-only execution sandboxes include it, while
 * deliberately not copying the scripts/ directory.
 */

function decodeHolderValue(raw) {
  return decodeURIComponent(raw.replace(/\+/g, "%20"));
}

/** The holder line's raw key=value map: undefined with no line, { error } on a malformed one. */
function holderLineValues(message) {
  const line = message.split(/\r?\n/).find((part) => part.startsWith("rmd-id holder "));
  if (!line) return undefined;
  const values = new Map();
  for (const token of line.slice("rmd-id holder ".length).trim().split(/[ \t]+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq < 1) return { error: `malformed token ${token}` };
    try {
      values.set(token.slice(0, eq), decodeHolderValue(token.slice(eq + 1)));
    } catch {
      return { error: `malformed value for ${token.slice(0, eq)}` };
    }
  }
  return { values };
}

export function parseReservationHolderLine(message) {
  const read = holderLineValues(message);
  if (read === undefined) return { status: "legacy" };
  if (read.error !== undefined) return { status: "unreadable", reason: read.error };
  const branch = read.values.get("branch");
  // A parsed `branch=unknown` is still unreadable as a claim, but preserves that recorded value.
  if (!branch) return { status: "unreadable", reason: "missing branch" };
  if (branch === "unknown") return { status: "unreadable", reason: "missing branch", recordedBranch: "unknown" };
  return { status: "known", branch };
}

/** Every field the holder line recorded; undefined when the line is absent or unparsable. */
export function parseReservationHolderFields(message) {
  const read = holderLineValues(message);
  if (read === undefined || read.error !== undefined) return undefined;
  const values = read.values;
  return {
    branch: values.get("branch"),
    pid: values.get("pid"),
    host: values.get("host"),
    startedAt: values.get("started_at"),
    source: values.get("source"),
    takenOverFrom: values.get("taken_over_from"),
  };
}

export const RESERVATION_PUSH_GRACE_MS = 2 * 60 * 60 * 1000;

// Weigh each takeover against the rightful holder, even after earlier reclaimers lost.
export function adjudicateReservationChain(links, graceMs = RESERVATION_PUSH_GRACE_MS) {
  const head = links[0];
  if (!head) return { holder: { status: "unreadable", reason: "empty reservation chain" }, fields: undefined };
  const kept = { holder: head.holder, fields: head.fields };
  if (links.length === 1) return kept;
  if (links.some((link) => link.holder.status !== "known" || link.holder.branch === "main" || !Number.isFinite(Date.parse(link.fields?.startedAt)))) return kept;
  let rightful = links.at(-1);
  let takeover;
  for (let i = links.length - 2; i >= 0; i--) {
    const link = links[i];
    const parent = links[i + 1];
    if (link.fields.source !== "reclaimed" || link.fields.takenOverFrom !== parent.holder.branch) return kept;
    const ageMs = Date.parse(link.fields.startedAt) - Date.parse(rightful.fields.startedAt);
    const winner = ageMs < graceMs ? "original" : "reclaimer";
    takeover = { reclaimer: link.fields, original: rightful.fields, ageMs, graceMs, winner };
    if (winner === "reclaimer") rightful = link;
  }
  return { holder: rightful.holder, fields: rightful.fields, takeover };
}
