/**
 * lib/field-trials-ledger-quarantine.ts — W1-T14781: ledger rows the Field Trials reader skips by name.
 *
 * A clock-shifted suite run without test isolation (fixed by W1-T14780) appended five cli.invoked rows
 * dated 2027-10-14 to the live ledger, archive ledger.2026-11-23T22-53-59-999Z.ndjson.gz. Each made every
 * read observed-partial (ledger-source-future-dated). Craig chose to quarantine exactly these rows by line
 * fingerprint on 2026-11-25 rather than edit the archive. Each entry is the sha256 of the raw line
 * (fingerprintLedgerLine), computed on the host; core is public, so only digests and timestamps live here.
 */
export interface QuarantinedLedgerRow { fingerprint: string; ts: string; reason: string }

const REASON = "W1-T14780 clock-shifted run wrote the live ledger; quarantined by Craig's card 2026-11-25T01:55:33Z";

export const QUARANTINED_LEDGER_ROWS: readonly QuarantinedLedgerRow[] = Object.freeze([
  { fingerprint: "0a4ead1773e04d221dcbd84ff732c81da60ac1edf4b50bd33a1d0d329e324d05", ts: "2027-10-14T21:23:34.063Z", reason: REASON },
  { fingerprint: "0f46b6c9dcfa8a47d7ea0d6a7066c5bbffa10b0dd3516095b1e30e20562cb0c5", ts: "2027-10-14T21:23:34.137Z", reason: REASON },
  { fingerprint: "a9915a7cb423c1b805adfb466c4a12d3a5d2466d36a7e2095b425f7152e171cd", ts: "2027-10-14T21:23:38.323Z", reason: REASON },
  { fingerprint: "b4e3ab71c3487018b095ae5ba6128e4f210daa719f2513f0f15bf2455a814395", ts: "2027-10-14T21:24:38.162Z", reason: REASON },
  { fingerprint: "21389e42428810e9aae94b6e73da0ebe47b78cb803edaf5d91b37b5ccf337977", ts: "2027-10-14T21:24:52.494Z", reason: REASON },
].map((row) => Object.freeze(row)));

/** The fingerprints the reader skips. */
export function quarantinedLedgerFingerprints(rows: readonly QuarantinedLedgerRow[] = QUARANTINED_LEDGER_ROWS): ReadonlySet<string> {
  return new Set(rows.map((row) => row.fingerprint));
}
