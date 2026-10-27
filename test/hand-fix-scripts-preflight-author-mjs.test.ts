import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorPublicationIdentitySubjectUrl } from '#test/helpers/author-publication-identity-subject.js';

type Identity = { state: string; message: string };
const author = await import(authorPublicationIdentitySubjectUrl()) as {
  authorPublicationIdentity: (input: { headSha: string; baseSha: string }, git: (args: string[]) => string) => Identity;
};

test("W1-T10133: hand_fix:scripts/preflight-author.mjs is prevented, not retried", () => {
  const sha = 'a'.repeat(40);
  const result = author.authorPublicationIdentity({ headSha: sha, baseSha: 'b'.repeat(40) }, () => 'run-W1-T10133-1\n');
  assert.equal(result.state, 'unknown-target');
  assert.match(result.message, /--head-ref run-W1-T10133-1 --head-sha a{40}/);
  assert.match(result.message, /identity NOT verified/);
  const detached = author.authorPublicationIdentity({ headSha: sha, baseSha: sha }, () => 'HEAD\n');
  assert.match(detached.message, /--head-ref <destination branch>/);
  const broken = author.authorPublicationIdentity({ headSha: sha, baseSha: sha }, () => { throw new Error('no git'); });
  assert.equal(broken.state, 'unknown-target');
  assert.match(broken.message, /--head-ref <destination branch>/);
});
