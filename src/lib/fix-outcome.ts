export type FixOutcome =
  | { kind: "FIXED" | "BASE_RED" | "FLAKE" }
  | { kind: "NEEDS_SCOPE"; paths: string[] }
  | { kind: "NEEDS_DESIGN"; reason: string };

export type FixOutcomeAction =
  | { kind: "legacy" | "commit" | "verify-base" | "rerun-once" }
  | { kind: "scope-needed"; testPaths: string[]; paths: string[] }
  | { kind: "hand-off"; reason: string };

// The prompt lists each outcome as "FIX_OUTCOME: FLAKE — <what it means>", and workers echo that shape back.
// A dash/colon gloss after the keyword is commentary, not a different outcome: before this, every glossed
// FLAKE/BASE_RED parsed as no outcome, so the rerun and base-verify arms never fired (2026-10-09, #10234).
const OUTCOME_GLOSS = /[ \t]*(?:—|–|--?|:)[ \t].*$/;

export function anchoredFixOutcome(report: string): FixOutcome | undefined {
  const lines = [...report.matchAll(/^[ \t]*FIX_OUTCOME:[ \t]*(.*)$/gm)];
  const raw = lines.at(-1)?.[1].trim();
  const glossed = raw !== undefined && /^(?:FIXED|BASE_RED|FLAKE|NEEDS_SCOPE[ \t])/.test(raw) && OUTCOME_GLOSS.test(raw);
  const value = glossed ? raw.replace(OUTCOME_GLOSS, "") : raw;
  if (value === "FIXED" || value === "BASE_RED" || value === "FLAKE") return { kind: value };
  if (value?.startsWith("NEEDS_DESIGN ")) {
    const reason = value.slice("NEEDS_DESIGN ".length).trim();
    return reason.length > 0 && reason.length <= 500 ? { kind: "NEEDS_DESIGN", reason } : undefined;
  }
  if (value?.startsWith("NEEDS_SCOPE ")) {
    const paths = value.slice("NEEDS_SCOPE ".length).split(",").map((path) => path.trim());
    if (paths.every((path) => path.length > 0 && !/^(?:\/|[A-Za-z]:)/.test(path) &&
      !/[\\\s\x00-\x1f\x7f]/.test(path) &&
      !path.split("/").some((part) => part === ".." || part === "." || part === ""))) {
      return { kind: "NEEDS_SCOPE", paths: [...new Set(paths)] };
    }
  }
  return undefined;
}

export function decideFixOutcomeAction(outcome: FixOutcome | undefined, facts: { admitTests: boolean }): FixOutcomeAction {
  if (!outcome) return { kind: "legacy" };
  switch (outcome.kind) {
    case "FIXED": return { kind: "commit" };
    case "BASE_RED": return { kind: "verify-base" };
    case "FLAKE": return { kind: "rerun-once" };
    case "NEEDS_DESIGN": return { kind: "hand-off", reason: outcome.reason };
    case "NEEDS_SCOPE": {
      const testPaths = facts.admitTests ? outcome.paths.filter((path) => path.startsWith("test/")) : [];
      const paths = outcome.paths.filter((path) => !testPaths.includes(path));
      return paths.length > 0 ? { kind: "scope-needed", testPaths, paths } : { kind: "commit" };
    }
  }
}
