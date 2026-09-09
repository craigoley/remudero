/**
 * IS THIS RED THE AUTHOR'S, OR DID THEY INHERIT IT?
 *
 * A ratchet compares the working tree against a recorded baseline. It cannot, on its own, tell a
 * file the AUTHOR grew from one that was ALREADY over its ceiling on the base branch — both look
 * identical at the point of refusal, and the remedy it prints ("record this number") reads as
 * "your growth", which for the second case is wrong and confusing.
 *
 * THE TEST IS THE SAME ONE THE REVIEWER ALREADY MAKES FOR PROOFS. `classifyBaseProofOutcome`
 * (src/lib/review.ts) re-runs a proof against the merge base and calls a pass there STALE, because
 * a check that holds on both sides discriminates nothing. A violation that reproduces on the base
 * is that same shape: it is not evidence about this diff.
 *
 * IT LABELS, IT NEVER SILENCES. An inherited violation still blocks — main being broken is not a
 * licence to merge past the gate, and recording it here is a real repair. What changes is that the
 * author is told whose repair it is, which is the difference between "I broke this" and "I am
 * doing main's housekeeping in my PR".
 *
 * Incident that motivated this: learnings/ci.yaml#inherited-violation-not-authors (W1-T3037).
 */

/**
 * Read one file's content at `ref`, or `undefined` when it does not exist there (a NEW file, whose
 * violation cannot be inherited by construction) or when git could not be asked.
 *
 * @param {(cmd: string, args: string[]) => { status: number | null, stdout: string }} run
 */
export function contentAtRef(run, ref, path) {
  let res;
  try {
    res = run("git", ["show", `${ref}:${path}`]);
  } catch {
    return { kind: "unreadable", why: "git show threw" };
  }
  // THREE OUTCOMES, NEVER TWO. `status === 0` is content. A NON-ZERO status is git answering
  // "no such path at that ref" — genuinely absent, so the violation is new in this diff. A NULL
  // status is git NOT ANSWERING: spawnSync returns it when the child is killed or its output
  // exceeds maxBuffer, which is not hypothetical here — src/run-task.ts is over 1MB at the base
  // and blew the default buffer, so the first draft of this helper read "unreadable" as "absent"
  // and reported an INHERITED violation as INTRODUCED. Silently, and in the exact case it was
  // written for.
  if (res.status === null) return { kind: "unreadable", why: "git produced no exit status (killed, or output over maxBuffer)" };
  if (res.status !== 0) return { kind: "absent" };
  return { kind: "content", text: res.stdout };
}

/**
 * Does `ref` resolve to a commit in THIS checkout?
 *
 * `git show <ref>:<path>` exits 128 for a MISSING REF and for a MISSING PATH alike, so {@link
 * contentAtRef} cannot tell them apart and reads an unfetched base as `absent` — which classifies
 * every violation as INTRODUCED. `rev-parse --verify --quiet` separates them: 0 for a real ref, 1
 * for one that is not there. A caller that can ask this must, before trusting any `absent`.
 *
 * @param {(cmd: string, args: string[]) => { status: number | null, stdout: string }} run
 */
export function refResolvable(run, ref) {
  try {
    return run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).status === 0;
  } catch {
    // Git not answering is not git saying yes. W1-T3037's own rule, applied one level up.
    return false;
  }
}

/**
 * Partition violations into those that reproduce at `ref` and those that do not.
 *
 * `measure` takes the file's content at the ref and returns the same figure the ratchet compares —
 * line count, comment count, whatever this gate counts — so this helper is shared by gates that
 * measure different things. A file absent at the ref is NEVER inherited: it is new in this diff.
 * An UNREADABLE ref is not treated as clean either; it yields `undetermined`, because "we could not
 * ask" and "the base is fine" must not arrive as the same answer.
 *
 * @returns {{ inherited: object[], introduced: object[], undetermined: object[] }}
 */
export function splitInheritedViolations(violations, { run, ref, measure, baselineFor, refPresent }) {
  // W1-T3141: a caller that can establish the ref is believed over `git show`'s ambiguous 128. When
  // the ref is not there, NOTHING about the base is knowable, so every violation is undetermined
  // rather than blamed on this diff. OPTIONAL on purpose: a caller passing no predicate gets
  // W1-T3037's behaviour unchanged, and its eleven falsifiers keep holding.
  if (refPresent && !refPresent()) return { inherited: [], introduced: [], undetermined: [...violations] };
  const inherited = [];
  const introduced = [];
  const undetermined = [];
  for (const v of violations) {
    const read = contentAtRef(run, ref, v.path);
    if (read.kind === "unreadable") {
      // "We could not ask" is not "the base is fine": an unreadable ref yields UNDETERMINED, never
      // a clean verdict. Reporting it as introduced would blame an author for a red they inherited.
      undetermined.push(v);
      continue;
    }
    if (read.kind === "absent") {
      // Genuinely not at the ref — the ordinary NEW-FILE case, definitively not inherited.
      introduced.push(v);
      continue;
    }
    let atRef;
    try {
      atRef = measure(read.text, v.path);
    } catch {
      undetermined.push(v);
      continue;
    }
    const ceiling = baselineFor(v.path);
    if (typeof ceiling !== "number") {
      // No recorded ceiling at all: the file entered at an allowance of zero, so any content is
      // over it and the violation IS inherited.
      inherited.push(v);
      continue;
    }
    (atRef > ceiling ? inherited : introduced).push(v);
  }
  return { inherited, introduced, undetermined };
}

/** The sentence a gate prints for the inherited set. Names the ref, so a reader can check it. */
export function inheritedNotice(inherited, ref, tool) {
  if (inherited.length === 0) return undefined;
  const names = inherited.map((v) => v.path).join(", ");
  return (
    `${tool}: ${inherited.length} of these already exceed their ceiling at ${ref} (${names}) — ` +
    `INHERITED, not introduced by this diff. Every open pull request sees the same refusal, and no ` +
    `diff can be written that avoids it. Recording it here is a real repair of ${ref}, not an ` +
    `admission about this change; it is worth saying so in the commit message.`
  );
}

/** The sentence a gate prints when it could NOT make the split. An absent notice and "we could not
 * ask" are the two readings this module exists to keep apart, and without this they render
 * identically — as silence. */
export function undeterminedNotice(undetermined, ref, tool) {
  if (undetermined.length === 0) return undefined;
  const names = undetermined.map((v) => v.path).join(", ");
  return (
    `${tool}: could not determine whether ${undetermined.length} of these are INHERITED from ${ref} ` +
    `(${names}) — that ref is not readable in this checkout, so no claim is made either way. This ` +
    `says nothing about whether the violation is yours; it says the comparison could not be run.`
  );
}
