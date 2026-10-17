// Fixture-only mutation selector. Production imports and files are never redirected or edited.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeMutantModule } from './mutant-module.js';

const AUTHOR_PATH = fileURLToPath(new URL('../../scripts/preflight-author.mjs', import.meta.url));
const EARLY_REFUSAL = [
  "    if (receipt.publicationIdentity.state === 'refused') {",
  "      receipt.affectedTestsNotRunReason = 'publication identity refused; no selection, dependency, census, heavy slot, static or test phase was started';",
  '      throw new Error(receipt.publicationIdentity.message);',
  '    }',
  '',
].join('\n');

/** Default: the real module. Explicit mutant: remove ONLY main's early refusal block.
 *  Keep the predicate, its call, identity receipt and all fixture assertions intact. */
export function authorPublicationIdentitySubjectUrl(): string {
  const mode = process.env.RMD_TEST_AUTHOR_PUBLICATION_MUTANT;
  if (mode === undefined) return pathToFileURL(AUTHOR_PATH).href;
  if (mode !== 'remove-early-refusal') throw new Error(`unknown publication identity fixture mutant: ${mode}`);
  const source = readFileSync(AUTHOR_PATH, 'utf8');
  const mainStart = source.indexOf('export function main(');
  const helperStart = source.indexOf('export function authorPublicationIdentity(');
  const removalStart = source.indexOf(EARLY_REFUSAL);
  if (helperStart < 0 || mainStart <= helperStart || removalStart <= mainStart ||
      source.split(EARLY_REFUSAL).length !== 2) {
    throw new Error('publication identity falsifier requires exactly one early refusal block after the intact helper');
  }
  const mutant = source.slice(0, removalStart) + source.slice(removalStart + EARLY_REFUSAL.length);
  if (mutant.slice(0, mainStart) !== source.slice(0, mainStart) ||
      !mutant.includes('receipt.publicationIdentity = authorPublicationIdentity(')) {
    throw new Error('publication identity falsifier must preserve the helper and its receipt-producing call');
  }
  // Reuse the repo's mutation fixture: relative imports keep the real collaborators, copies live
  // under ignored test/mutants-*/, and its existing exit handler cleans up only its own copies.
  const path = writeMutantModule('author-publication-refusal-removed.mjs', mutant, dirname(AUTHOR_PATH));
  const loaded = readFileSync(path, 'utf8');
  if (loaded.slice(loaded.indexOf('export function authorPublicationIdentity('),
    loaded.indexOf('export function main(')) !== source.slice(helperStart, mainStart)) {
    throw new Error('publication identity falsifier changed the helper while resolving imports');
  }
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  console.error(JSON.stringify({ fixture: 'publication-identity-remove-early-refusal', removedBlocks: 1,
    helperPreserved: true, sourceSha256: digest(source), mutantSha256: digest(loaded) }));
  return pathToFileURL(path).href;
}
