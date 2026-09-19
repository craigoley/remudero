// Minimal patch to address the described bug: ensure that when the codex JSONL output
// cap is reached, we emit a cap-truncation marker instead of continuing to spill event prose
// into the stream. This allows the recovery logic to distinguish tool-output volume from agent
// prose. The change is isolated to the point where the retry/retro path consumes the Codex
// worker's JSONL stream.
