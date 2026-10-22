/** Metadata only: the native runner owns the counts and physical file identity. */
export default async function* (events) {
  for await (const event of events) {
    if (event.type === 'test:summary') yield JSON.stringify(event) + '\n';
  }
}
