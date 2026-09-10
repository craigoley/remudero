- **(g) A CHANGE THAT REMOVES AN ACCESS PATH MUST PROVE THE REPLACEMENT FIRST, FROM A NEW SESSION
  — AN EXISTING CONNECTION IS NOT EVIDENCE.** `PasswordAuthentication no` went live against a
  0-byte `authorized_keys`; two pre-change sessions survived only because sshd never
  re-authenticates an established connection, and no third could have opened by any method. Prove
  the replacement under `BatchMode=yes` (which fails rather than prompting) and keep the old path
  until it does. The recurring shape is CREDENTIAL AND ACCESS ROTATION, not ssh. *(2026-08-16)*
