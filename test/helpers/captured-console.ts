import { AssertionError } from "node:assert";

/**
 * W1-T2812 — SUPPRESS THE SUBJECT'S STDERR, BUT KEEP IT FOR THE RED.
 *
 * 57 suites stub `console.error` around a CLI entrypoint and then assert on a bare
 * exit code. 15 of them stub it to `() => {}`, and the other 50 capture into an
 * array nothing ever reads on failure — which is the same black hole with extra
 * steps. Either way a failure renders as `1 !== 2` while the explanation the
 * subject printed was discarded by the test itself, in the same window that
 * produced the failure.
 *
 * The suppression is deliberate and stays: green runs must not gain noise. What
 * changes is that a FAILING assertion carries the captured stderr with it.
 */

/** Separator between an assertion's own text and the subject's stderr. Exported so a test greps a constant, never loose prose. */
export const CAPTURED_STDERR_HEADING = "--- captured console.error ---";

/**
 * Render captured lines beneath an assertion's own failure text.
 *
 * Deliberately declared ABOVE the interface below. Per CLAUDE.md's coverage
 * traps, `--experimental-test-coverage` stamps `DA:<line>,0` across a NEW file's
 * leading and trailing source-line records, so a type-only declaration parked at
 * either end is reported as uncovered code. Sandwiching the interface between two
 * executed functions keeps every line here instrumented and hit.
 */
function appendCaptured(message: string, lines: readonly string[]): string {
  const body = lines.length > 0 ? lines.join("\n") : "(the subject printed nothing to console.error)";
  return `${message}\n${CAPTURED_STDERR_HEADING}\n${body}`;
}

export interface CapturedConsoleError {
  /** Every line the subject wrote to `console.error` while captured, in order. */
  readonly lines: readonly string[];
  /** Put the real `console.error` back. Idempotent, so a `finally` and an early return cannot double-restore. */
  restore(): void;
  /**
   * Run `assertion`. On success nothing is printed and its value is returned, so
   * a green run is byte-identical to one that never called this. On failure the
   * error's own message — node's generated value disagreement included — is
   * augmented with the captured stderr and rethrown.
   *
   * The dump fires HERE, on failure, never in a `finally`: a `finally` dump
   * prints on every run including passes, which is the green-run noise the
   * stubbing exists to prevent.
   */
  explains<T>(assertion: () => T): T;
}

export function captureConsoleError(): CapturedConsoleError {
  const lines: string[] = [];
  const real = console.error;
  let restored = false;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  return {
    lines,
    restore(): void {
      if (restored) return;
      restored = true;
      console.error = real;
    },
    explains<T>(assertion: () => T): T {
      try {
        return assertion();
      } catch (e) {
        if (e instanceof Error) {
          e.message = appendCaptured(e.message, lines);
          // An AssertionError whose message node GENERATED is re-rendered from the
          // operands by some reporters unless it is marked as author-supplied, which
          // would drop the text just appended.
          if (e instanceof AssertionError) (e as { generatedMessage: boolean }).generatedMessage = false;
        }
        throw e;
      }
    },
  };
}
