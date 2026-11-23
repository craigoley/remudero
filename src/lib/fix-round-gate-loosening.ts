import { posix } from "node:path";
import { z } from "zod";
import { mergeTargetFromPrUrl } from "./arm-auto-merge.js";
import { ghJsonAsync } from "./github-transport.js";
import { classifyInstrumentChange, INSTRUMENT_SURFACE } from "./review.js";

const instrument = new RegExp(INSTRUMENT_SURFACE.join("|"));
const scannerPath = /(?:^|\/)(?:osv-scanner\.toml|\.(?:semgrep|gitleaks|trivy)ignore)$/;
const semgrepConfig = /^\.github\/semgrep\//;

interface RoundDiff {
  diffFiles: string[];
  diff: string;
}

export interface FixPushRefusal {
  reason: "gate-loosening" | "owner-refusal";
  files: string[];
  detail: string;
}

export function gateLooseningRefusal({ diffFiles, diff }: RoundDiff): FixPushRefusal | undefined {
  const files = diffFiles.filter(file =>
    (instrument.test(file) || scannerPath.test(file) || semgrepConfig.test(file)) &&
    classifyInstrumentChange(diff, diffFiles, file) !== "tightening");
  if (files.length === 0) return undefined;
  return {
    reason: "gate-loosening", files,
    detail: "This gate change needs the operator's yes. Route the instrument edit through its own reviewed PR (W1-T11030).",
  };
}

export async function readFixRoundDiff(
  priorHead: string,
  head: string | undefined,
  git: (args: string[]) => Promise<string> | string,
): Promise<RoundDiff | { unreadable: string }> {
  if (!head || !priorHead) return { unreadable: "the PR head or the round head could not be pinned" };
  const range = ["--no-ext-diff", "--no-textconv", "--no-renames", priorHead, head, "--"];
  try {
    const diffFiles = (await git(["diff", "--name-only", "-z", ...range])).split("\0").filter(Boolean);
    const diff = diffFiles.length === 0 ? "" : await git(["diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", ...range]);
    return { diffFiles, diff };
  } catch (error) {
    return { unreadable: String(error).slice(0, 500) };
  }
}

const actor = z.object({ login: z.string().min(1), type: z.string().optional(), is_bot: z.boolean().optional(), isBot: z.boolean().optional() });
const prData = z.object({ author: actor.nullable(), body: z.string().nullable() });
const commentData = z.object({ user: actor.nullable(), author_association: z.string(), body: z.string() });
const commentPages = z.array(z.array(commentData));

export interface PrConversation {
  prAuthor: z.infer<typeof actor> | null;
  body: string;
  comments: z.infer<typeof commentData>[];
}

export type PrConversationRead = PrConversation | { unreadable: string };

const freshGhJson = (args: string[]) => ghJsonAsync(args, undefined, undefined, { fresh: true });

export async function readPrConversation(
  prUrl: string, gh: (args: string[]) => unknown = freshGhJson,
): Promise<PrConversationRead> {
  const target = mergeTargetFromPrUrl(prUrl);
  if (!target) return { unreadable: "unrecognized pull request URL" };
  try {
    const pr = prData.parse(await gh(["pr", "view", prUrl, "--json", "author,body"]));
    const pages = commentPages.parse(await gh(["api",
      `repos/${target.owner}/${target.repo}/issues/${target.prNumber}/comments?per_page=100`, "--paginate", "--slurp"]));
    return { prAuthor: pr.author, body: pr.body ?? "", comments: pages.flat() };
  } catch (error) {
    return { unreadable: String(error).slice(0, 500) };
  }
}

type ChangeKind = "baseline" | "exclusion" | "ignore" | "waiver";

interface OwnerInstruction {
  line: string;
  paths: string[];
  kinds: ChangeKind[];
}

const eligibleAssociations = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const fixLane = /\bfix[\s-]+(?:lane|round|worker)s?\b/i;
const refusal = /\b(?:do not|don['’]t|must not|never)\s+(?:add|change|edit|modify|touch|update|introduce|remove|use|create|commit|include|alter|apply|write|raise|lower)\b/gi;
const kindWord = /\b(baseline|exclusion|ignore|waiver)s?\b/gi;
const pathToken = /\x60([^\x60\r\n]+)\x60|(?:[\w.*-]+\/)+[\w.*-]+|(?:[\w*-]+\.)+[\w*-]+|\.[\w-]+|\b(?:Dockerfile|Makefile|README|LICENSE)\b/g;

function person(user: PrConversation["prAuthor"]): user is NonNullable<PrConversation["prAuthor"]> {
  return user !== null && user.type?.toLowerCase() !== "bot" && !user.is_bot && !user.isBot && !/\[bot\]$/i.test(user.login);
}

function refusedTargets(text: string): Pick<OwnerInstruction, "paths" | "kinds"> {
  const paths: string[] = [];
  const words = text.replace(pathToken, (token, quoted: string | undefined) => {
    const path = (quoted ?? token).replace(/^\.\//, "").replace(/\.+$/, "");
    if (!path || /^(?:baseline|exclusion|ignore|waiver)s?$/i.test(path)) return path;
    paths.push(path);
    return " ";
  });
  const kinds = [...words.matchAll(kindWord)].map(match => match[1]!.toLowerCase() as ChangeKind);
  return { paths, kinds };
}

/** Keep the prose for the prompt and derive push restrictions only from its refusal clauses. */
export function ownerFixLaneInstructions({ prAuthor, body, comments }: PrConversation): OwnerInstruction[] {
  const authorLogin = prAuthor?.login.toLowerCase();
  const texts = [
    ...(person(prAuthor) ? [body] : []),
    ...comments.filter(({ user, author_association }) => person(user) &&
      (user.login.toLowerCase() === authorLogin || eligibleAssociations.has(author_association))).map(comment => comment.body),
  ];
  return texts.flatMap(text => {
    const lines = text.split(/\r?\n/);
    let addressedByHeading = false;
    return lines.flatMap((line, index) => {
      if (line.trim() === "") addressedByHeading = false;
      if (line.trimEnd().endsWith(":")) addressedByHeading = fixLane.test(line);
      if (!addressedByHeading && !fixLane.test(line)) return [];
      const matches = [...line.matchAll(refusal)];
      if (matches.length === 0) return [];
      const targets = matches.map((match, i) => {
        const clause = line.slice(match.index + match[0].length, matches[i + 1]?.index).trimStart().split(/[.!?](?:\s|$)|;/, 1)[0] ?? "";
        const direct = refusedTargets(clause);
        if (direct.paths.length || direct.kinds.length || !/^(?:it|one|them)\b/i.test(clause)) return direct;
        // “No baseline change ... Please do not add one from the fix lane.”
        const preceding = [lines[index - 1], line.slice(0, match.index)].filter(Boolean).join(" ");
        const antecedent = /\bno\s+([^.!?;]+)/i.exec(preceding)?.[1];
        return antecedent ? refusedTargets(antecedent) : direct;
      });
      return [{ line, paths: targets.flatMap(target => target.paths), kinds: targets.flatMap(target => target.kinds) }];
    });
  });
}

function kindMatches(kind: ChangeKind, file: string): boolean {
  const name = posix.basename(file);
  if (kind === "baseline") return /(?:^|[.-])baselines?(?:[.-]|$)/i.test(name);
  if (scannerPath.test(file) || semgrepConfig.test(file)) return kind === "exclusion" || kind === "ignore";
  return new RegExp(kind, "i").test(name);
}

export function ownerFixLaneRefusal(diffFiles: string[], instructions: readonly OwnerInstruction[]): FixPushRefusal | undefined {
  const files = diffFiles.filter(file => instructions.some(({ paths, kinds }) =>
    paths.some(path => file === path || (path.includes("*") && posix.matchesGlob(file, path))) ||
    kinds.some(kind => kindMatches(kind, file))));
  return files.length === 0 ? undefined : {
    reason: "owner-refusal", files,
    detail: "The PR body or an eligible comment forbids this change. Ask the PR author or repository maintainer to resolve the restriction.",
  };
}
