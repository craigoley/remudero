/** Map the existing string metadata port to REST or one fixed read-only GraphQL query. */
export function securityMetadataGhArgs(request) {
  if (typeof request !== 'string') throw new TypeError('security metadata request must be a string');
  const reserved = 'security-workflow-source', marker = reserved + ':';
  if (!request.startsWith(reserved)) return ['api', request];
  if (!request.startsWith(marker)) throw new Error('invalid security workflow source marker');
  const id = request.slice(marker.length);
  // Opaque ASCII only: do not decode IDs or permit quotes, escapes or trailing newlines.
  if (id.length < 8 || id.length > 200 || /[^A-Za-z0-9_=-]/.test(id)) {
    throw new Error('invalid security workflow source node ID');
  }
  const query = `query{node(id:"${id}"){__typename ... on WorkflowRun{url runAttempt file{path repositoryName repositoryFileUrl run{url runAttempt}}}}}`;
  return ['api', 'graphql', '-f', 'query=' + query];
}
