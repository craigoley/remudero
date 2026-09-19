// Minimal patch: integrate a JSONL cap-aware writer for Codex output
import { JsonlWriteResult, writeJsonlLineWithCap } from "./jsonl_writer";

type CodexEvent = any;

export class CodexWorker {
  private maxBytes: number;
  private currentBytes: number = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  // Simulated method that writes a single event line to the stream with cap logic
  writeEvent(stream: NodeJS.WritableStream, ev: CodexEvent): JsonlWriteResult {
    const res = writeJsonlLineWithCap(stream, ev, this.maxBytes, this.currentBytes);
    // Update currentBytes only if we actually wrote the line (not the cap marker)
    if (res.written) {
      this.currentBytes += res.bytesWritten;
    } else if (res.truncated) {
      // Cap reached; keep currentBytes capped at maxBytes
      this.currentBytes = this.maxBytes;
    }
    return res;
  }
}
