import { corpusDigest, readCorpusBytes, readMapSummary, validateCorpusManifest } from "./read-map-corpus.mjs";

/** Add as a SECOND reporter on an already-required process-isolated Node run. */
export default async function* readMapSummaryReporter(events) {
  const path = process.env.RMD_READ_MAP_MANIFEST;
  if (!path) throw Error("read-map summary reporter requires its own manifest");
  const manifest = validateCorpusManifest(JSON.parse(readCorpusBytes(path, 16 * 1024 ** 2).bytes));
  const hash = corpusDigest(manifest);
  for await (const event of events) {
    const summary = readMapSummary(event, manifest, hash);
    if (summary) yield JSON.stringify(summary) + "\n";
  }
}
