# W1-T12223 catalog migration receipt

Source record: plan/tasks.d/W1-T12223-map-the-ledger-step-registry-in-the-ledger-forensics-page-decision-relev.yaml
Source commit: a62d80e9ec82814f2ddedaacc864b902dcd86ef5
Source blob: 56161783c0a51de8786f64ecb0439d23d6f5fd7e
Destination catalog: craigoley/remudero-ops
Target code repository: craigoley/remudero

The source commit preserves the original queued record, including the operator's narrower documentation scope approved in PR #19196. The next protected plan PR adds those bytes plus a provenance line after the public removal has merged.

For rollback, confirm the destination lacks the record before restoring the exact public blob. If the destination addition has merged, remove it through normal plan gates before restoring the public record.
