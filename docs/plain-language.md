# The writing standard

How to write anything a person reads in this repo: rules for agents, task files, commit messages,
pull requests, issues, code comments, command help and screen text.

It applies to people and to agents. It builds on two older standards, which stay in force for their
own surfaces: [the operator message standard](operator-message-standard.md) and
[the comment standard](comment-standard.md).

## Why

The operator asked for this on 2026-11-10: "Much of what I read today is hard to parse."
The numbers below come from `main` on that day.

| Text | Finding |
|---|---|
| Task titles (5,084 task files) | 44 words on average. 72% are longer than 30 words. |
| Commit subjects (last 300) | 60% are longer than 72 characters. 25% are cut off with "…". |
| `CLAUDE.md` | 142 words in capitals. 23% of sentences are longer than 25 words. |
| `docs/operator-guide.md` | 38% of sentences are longer than 25 words. |

## The four tests (ISO 24495-1)

A text is plain when its reader can do four things. Check them in this order.

1. **Relevant.** The reader gets what they need. Name the reader before you write. Leave out what
   they do not need.
2. **Findable.** The reader can find it. Put the main point first. Use a heading or a list when
   there are three or more parts.
3. **Understandable.** The reader understands it on the first reading.
4. **Usable.** The reader can act on it. Say what happens next and who does it.

## The rules (from ASD-STE100)

These rules make a text understandable. They come from Simplified Technical English. Its authors
wrote it so that a tired reader cannot misread an instruction. It also helps a reader whose first
language is not English.

1. **One sentence, one idea.** An instruction has 20 words or fewer. A description has 25 words or
   fewer.
2. **One word, one meaning.** Use the term in [the glossary](glossary.md). Do not use a second
   word for the same thing. Do not use a glossary term for a different thing.
3. **Use the active voice.** Name who does the action: "the sweep reviews the pull request", not
   "the pull request is reviewed".
4. **Give an instruction as a command.** "Run the preflight." Not "the preflight should be run".
5. **Write a full sentence.** Keep the articles and the verb: "The daemon is not running." Not
   "daemon down".
6. **Use no more than three nouns in a row.** Write "the limit on plan filings that wait for
   admission", not "plan filing admission bound".
7. **Use a list for a sequence or a set.** Number the steps of a procedure. One step, one action.
8. **Put the condition first.** "If the claim is refused, stop." The reader must know the condition
   before the action.
9. **Use normal capitals.** Do not write a word in capitals to stress it. If a point is important,
   put it first.
10. **Say it directly.** No metaphor in place of a term, no double negative, no "not unlike".
11. **Write a number with its unit and its source.** "45 failures on 39 heads, 2026-11-07 to
    2026-11-10", not "many failures".
12. **Spell out an abbreviation on first use**, unless it is in the glossary.

A machine-read part of a text keeps its exact form. This covers trailers, task ids, the acceptance
block, proof lines and ledger step names. The rules apply to the words around them.

## Each kind of text

| Text | Shape |
|---|---|
| **Task title** | One sentence of 15 words or fewer that states what will be true when the task is done. Evidence goes in `rationale`. |
| **Task rationale** | First line: what was observed, where and when. Then a short list of facts with numbers. |
| **Commit subject and pull request title** | `type(scope): what is now true (task id)`. 72 characters or fewer. Never cut with "…": write a shorter sentence. |
| **Pull request body** | `Why`, `What`, `Acceptance`, `Decisions`. Each part opens with its main point. |
| **Issue that asks the operator for something** | The title is the question or the decision. The body opens with what happened, what is needed and what happens if the operator does nothing. Machine fields go last. |
| **Code comment** | See the comment standard. State the rule the code keeps, then cite the record. |
| **Command help and screen text** | See the operator message standard. Say what the thing is before how it works. |
| **Agent rule** (`CLAUDE.md`, doctrine) | The headline is the whole rule, as one command. The body gives the reason and one example. |

## Examples from this repo

| Before | After |
|---|---|
| `[MANUAL] TRIAGE-incident-ba882173ff28a357: PR …/17617 needs a clarification — PR stage stalled: #17617 …/17617 — awaiting-review` | `Pull request #17617 has waited 49 minutes for a review. Decide: review it again, or close it.` |
| `fix(arm): an already-clean plan pr whose direct merge github refuses with "base branch… (W1-T11259)` | `fix(arm): the fleet retries a plan merge that GitHub refuses (W1-T11259)` |
| `EVERY proof needs a dialect prefix — unit test: or grep:. A bare title is PROSE and never executes.` | `Start every proof with "unit test:" or "grep:". A proof without one does not run.` |
| `plan filing admission bound` | `the limit on plan filings that wait for admission` |

## How the standard is kept

- **Each prompt tells its agent.** Every prompt that asks an agent to write for a person names this
  standard and the rules for that kind of text.
- **A script measures text and blocks nothing.** A script reports sentence length, words in
  capitals, cut-off subjects and terms that are not in the glossary, for each kind of text. A
  measurement never fails a pull request. The operator ruled this for comments on 2026-10-24 and it
  holds here.
- **A gardener rewrites the worst text first.** A gardener reads the measurements, picks the text
  that is hardest to read and most often read, and files a task to rewrite it.
- **A rewrite keeps the meaning.** A rewrite changes words, never a rule, a number or a
  machine-read part. Fix a message that states something false before you reword it.
