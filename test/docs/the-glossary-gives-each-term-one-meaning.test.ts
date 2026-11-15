import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { REPO_ROOT } from "#test/helpers/repo-root.js";

// W1-T12038: docs/glossary.md gives each term one meaning, and docs/plain-language.md points at it.
// Each check is a function of the text, so each test also proves that a broken copy fails.

const GLOSSARY = "docs/glossary.md";
const STANDARD = "docs/plain-language.md";
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

/** The cells of one table line, split on unescaped pipes, or undefined when the line is not a table line. */
function cellsOf(line: string | undefined): string[] | undefined {
  if (line === undefined || !line.trimStart().startsWith("|")) return undefined;
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
}

const isSeparator = (cells: string[] | undefined): boolean => cells !== undefined && cells.every((cell) => /^:?-+:?$/.test(cell));

/** Every table row of a document. A separator row and the header row above it are left out. */
function tableRows(markdown: string): string[][] {
  const lines = markdown.split("\n");
  return lines.flatMap((line, i) => {
    const cells = cellsOf(line);
    return cells === undefined || isSeparator(cells) || isSeparator(cellsOf(lines[i + 1])) ? [] : [cells];
  });
}

/** Criterion 1: four cells in each row, none empty, and no term twice. A source with no file is a dash. */
function rowProblems(markdown: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const cells of tableRows(markdown)) {
    const term = (cells[0] ?? "").toLowerCase();
    if (cells.length !== 4) problems.push(`"${term}" has ${cells.length} cells, not 4`);
    if (cells.some((cell) => cell === "")) problems.push(`"${term}" has an empty cell`);
    if (seen.has(term)) problems.push(`"${term}" is defined twice`);
    seen.add(term);
  }
  return problems;
}

/** Criterion 2: a word not to use is not a term, unless the row names the meaning: "lane (for this meaning)". */
function forbiddenTermProblems(markdown: string): string[] {
  const rows = tableRows(markdown);
  const terms = new Set(rows.map((cells) => (cells[0] ?? "").toLowerCase()));
  return rows.flatMap((cells) =>
    (cells[2] ?? "").split(",").map((word) => word.trim().toLowerCase())
      .filter((word) => terms.has(word))
      .map((word) => `"${cells[0]}" forbids "${word}", which is a term; name the meaning, as in "${word} (for this meaning)"`));
}

/** The relative link targets of a document, as paths from the repo root. */
function relativeLinks(docPath: string, markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => (match[1] ?? "").split("#")[0] ?? "")
    .filter((target) => target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target))
    .map((target) => join(dirname(docPath), target));
}

/** Criterion 3: each relative link of a document resolves to a file. */
function linkProblems(docPath: string, markdown: string): string[] {
  return relativeLinks(docPath, markdown)
    .filter((target) => !existsSync(join(REPO_ROOT, target)))
    .map((target) => `${docPath} links ${target}, which does not exist`);
}

test("W1-T12038 criterion 1: every glossary row has four filled cells and no term is defined twice", () => {
  const glossary = read(GLOSSARY);
  assert.ok(tableRows(glossary).length >= 50, "the parser must find the rows of the glossary");
  assert.deepEqual(rowProblems(glossary), []);

  assert.deepEqual(rowProblems(`${glossary}\n| Operator | A second meaning. | owner | — |\n`), ['"operator" is defined twice']);
  assert.deepEqual(rowProblems("| Term | Meaning | Do not use |\n|---|---|---|\n| lane | A position. | slot |\n"), ['"lane" has 3 cells, not 4']);
  assert.deepEqual(rowProblems("| lane | A position. |  | — |\n"), ['"lane" has an empty cell']);
  assert.deepEqual(tableRows("| a \\| b | c |\n"), [["a \\| b", "c"]], "an escaped pipe does not split a cell");
});

test("W1-T12038 criterion 2: no word not to use is itself a term, unless the row names the meaning", () => {
  const glossary = read(GLOSSARY);
  assert.deepEqual(forbiddenTermProblems(glossary), []);

  const unnamed = forbiddenTermProblems(`${glossary}\n| stall | A made-up term. | Lane, halt | — |\n`);
  assert.equal(unnamed.length, 1);
  assert.match(unnamed[0] ?? "", /"stall" forbids "lane"/);
  assert.deepEqual(forbiddenTermProblems(`${glossary}\n| stall | A made-up term. | lane (for this meaning), halt | — |\n`), []);
});

test("W1-T12038 criterion 3: the writing standard links the glossary and the two older standards, and every link resolves", () => {
  const standard = read(STANDARD);
  const linked = relativeLinks(STANDARD, standard);
  for (const target of [GLOSSARY, "docs/operator-message-standard.md", "docs/comment-standard.md"]) {
    assert.ok(linked.includes(target), `${STANDARD} must link ${target}`);
  }
  assert.deepEqual(linkProblems(STANDARD, standard), []);
  assert.deepEqual(linkProblems(GLOSSARY, read(GLOSSARY)), []);

  assert.deepEqual(linkProblems(STANDARD, `${standard}\n[a missing page](no-such-page.md#part)\n`),
    [`${STANDARD} links docs/no-such-page.md, which does not exist`]);
  assert.deepEqual(linkProblems(STANDARD, "[a site](https://example.com/x.md) and [a part](#why)"), []);
});
