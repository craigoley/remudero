/** Native counts plus bounded failure diagnostics survive a killed outer buffer. */
export default async function* (events) {
  for await (const event of events) {
    if (event.type === 'test:summary') yield JSON.stringify(event) + '\n';
    else if (event.type === 'test:fail') yield JSON.stringify({type: event.type,
      data: {file: event.data.file, name: String(event.data.name).slice(0, 1024),
        line: event.data.line, column: event.data.column,
        error: String(event.data.details?.error?.stack ?? event.data.details?.error ?? 'native failure').slice(0, 4096)}}) + '\n';
  }
}
