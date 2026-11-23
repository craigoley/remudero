import { posix } from "node:path";
import { z } from "zod";
import { mergeTargetFromPrUrl } from "./arm-auto-merge.js";
import { ghJsonAsync } from "./github-transport.js";
import { classifyInstrumentChange, INSTRUMENT_SURFACE } from "./review.js";

const instrument = new RegExp(INSTRUMENT_SURFACE.join("|"));
const scannerRules = /(?:^|\/)(?:osv-scanner\.toml|\.(?:semgrep|gitleaks|trivy)ignore)$|^\.github\/semgrep\//;

export function isFixRoundGatePath(path: string): boolean {
  return instrument.test(path) || scannerRules.test(path);
}

export interface FixRoundRefusal {
  reason: string;
  files: string[];
  detail: string;
}

export function gateLooseningRefusal({ diffFiles, diff }: { diffFiles: string[]; diff: string }): FixRoundRefusal | undefined {
  const files = diffFiles.filter(file => isFixRoundGatePath(file) &&
    classifyInstrumentChange(diff, diffFiles, file) !== "tightening");
  if (files.length === 0) return undefined;
  return {
    reason: "gate-loosening", files,
    detail: "This gate change needs the operator's yes. Route it through its own reviewed instrument PR (W1-T11030).",
  };
}

const actor = z.object({ login: z.string().min(1), type: z.string().optional(), is_bot: z.boolean().optional(), isBot: z.boolean().optional() });
const prData = z.object({ author: actor.nullable(), body: z.string().nullable() });
const commentData = z.object({ user: actor.nullable(), author_association: z.string(), body: z.string() });
const commentPages = z.array(z.array(commentData));

interface PrConversation {
  prAuthor: z.infer<typeof actor> | null;
  body: string;
  comments: readonly z.infer<typeof commentData>[];
}

export type PrConversationRead = PrConversation | { unreadable: string };

export async function readPrConversation(prUrl: string,
  gh: (args: string[]) => unknown = args => ghJsonAsync(args, undefined, undefined, { fresh: true }),
): Promise<PrConversationRead> {
  const target = mergeTargetFromPrUrl(prUrl);
  if (!target) return { unreadable: "unrecognized pull request URL" };
  try {
    const pr = prData.parse(await gh(["pr", "view", prUrl, "--json", "author,body"]));
    const comments = commentPages.parse(await gh(["api",
      `repos/${target.owner}/${target.repo}/issues/${target.prNumber}/comments?per_page=100`, "--paginate", "--slurp"]));
    return { prAuthor: pr.author, body: pr.body ?? "", comments: comments.flat() };
  } catch (error) {
    return { unreadable: String(error).slice(0, 500) };
  }
}

const maintainers = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const fixLane = /\bfix[ -]+(?:lane|round|worker)s?\b/i;
const prohibition = /\b(?:do not|don['’]t|must not|never)\s+(?:add|change|edit|modify|touch|update|introduce|remove|create|commit|include|apply|write|raise|lower)\b/gi;
const changeKind = /\b(baseline|exclusion|ignore|waiver)s?\b/gi;
const pathToken = /`([^`]+)`|(?:[\w.*-]+\/)+[\w.*-]+|(?:[\w*-]+\.)+[\w*-]+|\.[\w-]+|\b(?:Dockerfile|Makefile|README|LICENSE)\b/g;

interface OwnerInstruction {
  line: string;
  paths: string[];
  kinds: string[];
}

function human(user: PrConversation["prAuthor"]): user is NonNullable<PrConversation["prAuthor"]> {
  return user !== null && user.type?.toLowerCase() !== "bot" && !user.is_bot && !user.isBot && !/\[bot\]$/i.test(user.login);
}

function refusedTargets(clause: string): Pick<OwnerInstruction, "paths" | "kinds"> {
  const paths: string[] = [];
  const prose = clause.replace(pathToken, (token, quoted: string | undefined) => {
    const path = (quoted ?? token).trim().replace(/^\.\//, "").replace(/\.+$/, "");
    if (/^(?:baseline|exclusion|ignore|waiver)s?$/i.test(path)) return path;
    if (path) paths.push(path);
    return " ";
  });
  return { paths, kinds: [...prose.matchAll(changeKind)].map(match => match[1].toLowerCase()) };
}

export function ownerFixLaneInstructions({ prAuthor, body, comments }: PrConversation): OwnerInstruction[] {
  const authorLogin = prAuthor?.login.toLowerCase();
  const eligible = comments.filter(({ user, author_association }) => human(user) &&
    (user.login.toLowerCase() === authorLogin || maintainers.has(author_association)));
  const texts = [...(human(prAuthor) ? [body] : []), ...eligible.map(comment => comment.body)];
  return texts.flatMap(text => {
    const lines = text.split(/\r?\n/);
    let laneHeading = false;
    return lines.flatMap((line, index) => {
      if (!line.trim()) laneHeading = false;
      if (line.trimEnd().endsWith(":")) laneHeading = fixLane.test(line);
      if (!laneHeading && !fixLane.test(line)) return [];
      const refusals = [...line.matchAll(prohibition)];
      if (refusals.length === 0) return [];
      const targets = refusals.map((refusal, clauseIndex) => {
        const rest = line.slice(refusal.index + refusal[0].length, refusals[clauseIndex + 1]?.index).trimStart();
        const clause = rest.split(/[.!?](?:\s|$)|;/, 1)[0];
        // The refusal can point to a baseline forbidden in the preceding sentence.
        const previous = `${lines[index - 1] ?? ""} ${line.slice(0, refusal.index)}`;
        const antecedent = /\bno\s+([^.!?;]+)/i.exec(previous)?.[1];
        return refusedTargets(antecedent && /^(?:it|one|them)\b/i.test(clause) ? antecedent : clause);
      });
      return [{ line, paths: targets.flatMap(({ paths }) => paths), kinds: targets.flatMap(({ kinds }) => kinds) }];
    });
  });
}

export function ownerFixLaneRefusal(diffFiles: string[], instructions: readonly OwnerInstruction[]): FixRoundRefusal | undefined {
  const files = diffFiles.filter(file => instructions.some(({ paths, kinds }) =>
    paths.some(path => file === path || (!path.includes("/") && posix.basename(file) === path) ||
      (path.includes("*") && posix.matchesGlob(file, path))) ||
    kinds.some(kind => posix.basename(file).toLowerCase().includes(kind) ||
      ((kind === "ignore" || kind === "exclusion") && scannerRules.test(file)))));
  if (files.length === 0) return undefined;
  return { reason: "owner-refusal", files, detail: "The PR body or an eligible comment forbids these changes. Ask the PR author or repository maintainer to resolve the restriction." };
}
