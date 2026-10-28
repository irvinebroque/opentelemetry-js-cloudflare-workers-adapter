// Minimal PostgreSQL wire fixture: real pg connection/query/error handling,
// deterministic responses, no database service or external credentials.
import { createServer } from 'node:net';

export async function postgresServer() {
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
  const short = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
  const packet = (tag: string, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from(tag), int(body.length + 4), body]);
  };
  const ready = packet('Z', Buffer.from('I'));
  const queries: string[] = [];
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    let startup = true;
    socket.on('error', () => {});
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const size = buffer.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (buffer.length < size) return;
        const message = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        if (startup) {
          startup = false;
          socket.write(Buffer.concat([packet('R', int(0)), ready]));
        } else if (message[0] === 88) socket.end(); // Terminate
        else if (message[0] === 81) { // Simple Query
          const query = message.subarray(5, -1).toString();
          queries.push(query);
          socket.write(query.includes('fail')
            ? Buffer.concat([packet('E', Buffer.from('SERROR\0C42601\0Msynthetic query failure\0\0')), ready])
            : Buffer.concat([
              packet('T', short(1), Buffer.from('answer\0'), int(0), short(0), int(23), short(4), int(-1), short(0)),
              packet('D', short(1), int(2), Buffer.from('42')),
              packet('C', Buffer.from('SELECT 1\0')), ready,
            ]));
        } else socket.destroy(new Error('Unexpected PostgreSQL fixture message'));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { queries, port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
