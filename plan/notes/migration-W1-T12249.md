# W1-T12249 catalog migration receipt

Source record: plan/tasks.d/W1-T12249-record-whether-the-overlapping-retro-preflight-changes-are-already-on-ma.yaml
Source commit: 99d38e6b554f0167c6b1ab4214eb88ff03751638
Source blob: 87d7bdf2ebeb217adf00d41c2b15a459ab511262
Destination catalog: craigoley/remudero-ops
Target code repository: craigoley/remudero

This change removes the public catalog record. The next protected plan PR adds the original bytes plus a provenance line to the destination catalog. The source commit keeps the original record recoverable.

For rollback, confirm that the destination lacks the record before restoring the exact public blob. If the destination addition has merged, remove it through the normal plan gates before restoring the public record.
