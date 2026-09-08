// @source-text-subject - this suite's subject is the source text named by docs symbol citations.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

export interface SymbolCitation {
  path: string;
  symbol: string;
}

function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

function isCamelCaseIdentifier(token: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token) && /^[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/.test(token);
}

export function extractBaseRefContractSymbolCitations(markdown: string): SymbolCitation[] {
  const citations: SymbolCitation[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const pathCell = cells[0] ?? "";
    const srcPaths = backtickedTokens(pathCell).filter((token) => /^src\/.*\.ts$/.test(token));
    if (srcPaths.length !== 1) continue;

    const path = srcPaths[0]!;
    for (const token of backtickedTokens(pathCell)) {
      if (token === path) continue;
      if (isCamelCaseIdentifier(token)) citations.push({ path, symbol: token });
    }
  }
  return citations;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sourceDefinesSymbol(sourceText: string, symbol: string): boolean {
  const name = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`),
    new RegExp(`\\b(?:readonly\\s+)?${name}\\??\\s*:`),
  ];
  return patterns.some((pattern) => pattern.test(sourceText));
}

export function unresolvedSymbolCitations(
  markdown: string,
  readSource: (path: string) => string,
): SymbolCitation[] {
  return extractBaseRefContractSymbolCitations(markdown).filter(
    ({ path, symbol }) => !sourceDefinesSymbol(readSource(path), symbol),
  );
}

test("docs-cite-real-symbols: every base-ref contract src symbol resolves in its cited file", () => {
  const markdown = readFileSync(join(REPO_ROOT, "docs", "base-ref-contract.md"), "utf8");
  const citations = extractBaseRefContractSymbolCitations(markdown);

  assert.ok(citations.some((c) => c.symbol === "refreshOriginMain"), "control: the src symbol table was parsed");
  assert.ok(citations.some((c) => c.symbol === "worktreeMergeBase"), "control: the run-task.ts row was parsed");

  const failures = unresolvedSymbolCitations(markdown, (path) => readFileSync(join(REPO_ROOT, path), "utf8"));
  assert.deepEqual(
    failures,
    [],
    "docs/base-ref-contract.md cites symbol(s) that do not resolve in their cited source file: " +
      failures.map((f) => `${f.path}#${f.symbol}`).join(", "),
  );
});

test(
  "docs-cite-real-symbols: extraction audits src rows without mistaking commands or shell symbols for src definitions",
  () => {
    const markdown =
      "| Path | What it reads |\n" +
      "| --- | --- |\n" +
      "| `src/lib/a.ts` (`firstSymbol`, `secondSymbol`) | `git show origin/main:<path>` |\n" +
      "| `deploy/entrypoint.sh` (`resolve_target`) | shell helper, outside src |\n" +
      "| `src/lib/b.ts`, `src/lib/c.ts` | `gh pr create --fill --base main` |\n";

    assert.deepEqual(extractBaseRefContractSymbolCitations(markdown), [
      { path: "src/lib/a.ts", symbol: "firstSymbol" },
      { path: "src/lib/a.ts", symbol: "secondSymbol" },
    ]);
  },
);

test("docs-cite-real-symbols: unresolved citations go red, including interface properties", () => {
  const markdown = "| `src/lib/a.ts` (`presentSymbol`, `propertySymbol`, `missingSymbol`) | reads something |\n";
  const source = "export function presentSymbol() {}\ninterface Options { propertySymbol?: () => void; }\n";

  assert.deepEqual(unresolvedSymbolCitations(markdown, () => source), [
    { path: "src/lib/a.ts", symbol: "missingSymbol" },
  ]);
});
