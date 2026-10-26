/**
 * lib/trust-root-text.ts — text an agent obeys must hold nothing a reader cannot see.
 *
 * The TRUST ROOT is every tracked file that instructs an agent here: CLAUDE.md and AGENTS.md, the doctrine
 * bodies, the learnings corpus, the skills and settings under .claude/, the plan (task text is rendered into worker
 * prompts), the narrative stores, and the hooks that set what an agent may run. Machine lanes write much of
 * it: the retro, the gardeners and the triage lane file and amend it every day. The plan, its narrative and the
 * learnings corpus are read from the repo's layout (repo-layout.ts), never named here.
 *
 * A model reads characters a reviewer never sees. Zero-width and format characters split a word so a
 * reviewer and a grep disagree about it; bidirectional controls reorder what a diff displays; Unicode tag
 * characters (U+E0000 block) carry a whole instruction no screen renders; a Cyrillic or Greek letter inside
 * a Latin word makes a token that looks like another. None has a use in these files: on 2026-10-26 the
 * 4,634 trust-root files held none of them. Swamp's CI audits the same classes in its own trust-root files
 * with a model (swamp-club/swamp, .github/workflows/ci.yml, claude-review-integrity); this is the part a
 * deterministic scan can decide, so no model is asked.
 *
 * The plan's feedback/ directory is OUT: it holds external input the triage lane reads as data, and Dependabot
 * release notes there carry U+200B after every "@" on purpose, so a mention cannot ping anyone.
 */
import { relative, sep } from "node:path";

import type { RepoLayout } from "./repo-layout.js";

/** Top-level instruction files no {@link RepoLayout} field names. */
const INSTRUCTION_FILES: readonly string[] = ["CLAUDE.md", "AGENTS.md", "DECISIONS.md", "LEARNINGS.md"];

/** Instruction directories no {@link RepoLayout} field names, each ending in `/`. */
const INSTRUCTION_DIRS: readonly string[] = ["doctrine/", ".claude/", "hooks/"];

/** A repo's trust root as repo-relative, `/`-separated paths; every directory ends in `/`. */
export interface TrustRoot {
  files: readonly string[];
  dirs: readonly string[];
  /** Directories inside {@link dirs} that hold external input, not instructions. */
  excludedDirs: readonly string[];
}

/** The trust root of the repo `layout` describes: the fixed instruction files and directories, plus the plan
 *  directory, the plan's narrative and the learnings corpus wherever the layout puts them. */
export function trustRootFor(layout: Pick<RepoLayout, "root" | "planDir" | "masterPlan" | "learningsDir">): TrustRoot {
  const rel = (path: string): string => relative(layout.root, path).split(sep).join("/");
  const planDir = `${rel(layout.planDir)}/`;
  return {
    files: [...INSTRUCTION_FILES, rel(layout.masterPlan)],
    dirs: [...INSTRUCTION_DIRS, `${rel(layout.learningsDir)}/`, planDir],
    excludedDirs: [`${planDir}feedback/`],
  };
}

/** Whether a repo-relative, `/`-separated path is in `root`. */
export function isTrustRootPath(root: TrustRoot, path: string): boolean {
  if (root.excludedDirs.some((dir) => path.startsWith(dir))) return false;
  return root.files.includes(path) || root.dirs.some((dir) => path.startsWith(dir));
}

/** Every refused code point range, inclusive, with the name a finding prints. */
const HIDDEN_RANGES: readonly (readonly [number, number, string])[] = [
  [0x00ad, 0x00ad, "SOFT HYPHEN"],
  [0x061c, 0x061c, "ARABIC LETTER MARK"],
  [0x180e, 0x180e, "MONGOLIAN VOWEL SEPARATOR"],
  [0x200b, 0x200b, "ZERO WIDTH SPACE"],
  [0x200c, 0x200c, "ZERO WIDTH NON-JOINER"],
  [0x200d, 0x200d, "ZERO WIDTH JOINER"],
  [0x200e, 0x200f, "DIRECTIONAL MARK"],
  [0x202a, 0x202e, "BIDIRECTIONAL EMBEDDING OR OVERRIDE"],
  [0x2060, 0x2064, "WORD JOINER OR INVISIBLE OPERATOR"],
  [0x2066, 0x2069, "BIDIRECTIONAL ISOLATE"],
  [0xfe00, 0xfe0f, "VARIATION SELECTOR"],
  [0xfeff, 0xfeff, "ZERO WIDTH NO-BREAK SPACE"],
  [0xe0000, 0xe007f, "TAG CHARACTER"],
  [0xe0100, 0xe01ef, "VARIATION SELECTOR SUPPLEMENT"],
];

const EMOJI_PRESENTATION = 0xfe0f;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const LETTER_RUN = /[\p{L}\p{M}]+/gu;
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE_SCRIPTS: readonly (readonly [RegExp, string])[] = [[/\p{Script=Cyrillic}/u, "Cyrillic"], [/\p{Script=Greek}/u, "Greek"]];

export interface HiddenTextFinding {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, counted in code points. */
  column: number;
  kind: "hidden-character" | "mixed-script";
  /** `U+XXXX NAME` for a hidden character; the token and its scripts for a mixed-script word. */
  detail: string;
}

function hiddenName(codePoint: number): string | undefined {
  return HIDDEN_RANGES.find(([low, high]) => codePoint >= low && codePoint <= high)?.[2];
}

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Every hidden character and mixed-script word in `text`. U+FE0F directly after a pictographic
 *  character is an emoji's own presentation selector and is allowed; anywhere else it is refused. */
export function scanTrustRootText(path: string, text: string): HiddenTextFinding[] {
  const findings: HiddenTextFinding[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const chars = [...line];
    for (const [column, char] of chars.entries()) {
      const codePoint = char.codePointAt(0)!;
      const name = hiddenName(codePoint);
      if (name === undefined) continue;
      if (codePoint === EMOJI_PRESENTATION && column > 0 && PICTOGRAPHIC.test(chars[column - 1]!)) continue;
      findings.push({ path, line: index + 1, column: column + 1, kind: "hidden-character", detail: `${codePointLabel(codePoint)} ${name}` });
    }
    for (const match of line.matchAll(LETTER_RUN)) {
      const token = match[0];
      const others = LOOKALIKE_SCRIPTS.filter(([script]) => script.test(token)).map(([, name]) => name);
      if (!LATIN.test(token) || others.length === 0) continue;
      const column = [...line.slice(0, match.index)].length + 1;
      findings.push({ path, line: index + 1, column, kind: "mixed-script", detail: `"${token}" mixes Latin with ${others.join(" and ")}` });
    }
  }
  return findings;
}

/** One line per finding, naming where it is, what it is, and the remedy. */
export function renderHiddenTextFinding(finding: HiddenTextFinding): string {
  const remedy = finding.kind === "hidden-character"
    ? "delete it; an instruction file never needs an invisible character"
    : "retype the word in one script";
  return `${finding.path}:${finding.line}:${finding.column}: ${finding.kind} ${finding.detail} — ${remedy}`;
}
