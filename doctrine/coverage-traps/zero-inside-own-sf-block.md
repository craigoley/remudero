- **ZERO A `DA:` VALUE INSIDE THE TARGET's OWN `SF:` BLOCK — a whole-file replace hits another
  file's identical line number and returns a FALSE `OK`.** Every brief here demands this falsifier;
  done naively it proves nothing while looking like it passed. lcov holds one `DA:<line>` PER FILE,
  so replacing `DA:5042,6` across the artefact edited a different record and `diff-coverage` still
  read `OK`. Slice `SF:<path>`→`end_of_record`, assert exactly ONE match in that slice, and require
  the `SF:` count and byte size unchanged. *(#3227)*
