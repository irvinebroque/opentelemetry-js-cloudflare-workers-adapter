import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';

async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}
export const httpFixture = () => listen(httpServer((req, res) => {
  res.writeHead(req.url === '/error' ? 500 : 200, { 'content-type': 'text/plain' });
  res.end(req.url === '/error' ? 'synthetic error' : 'ok');
}));

// Minimal RESP2 transport fixture, not a Redis database. Exercises the real
// clients' encoding, pipelining, reply/error parsing and instrumented methods.
export async function redisFixture() {
  const commands = [];
  const server = createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const head = /^\*(\d+)\r\n/.exec(buffer);
        if (!head) return;
        let offset = head[0].length;
        const args = [];
        for (let i = 0; i < Number(head[1]); i++) {
          const size = /^\$(\d+)\r\n/.exec(buffer.slice(offset));
          if (!size) return;
          offset += size[0].length;
          const length = Number(size[1]);
          if (buffer.length < offset + length + 2) return;
          args.push(buffer.slice(offset, offset + length)); offset += length + 2;
        }
        buffer = buffer.slice(offset);
        commands.push(args);
        const command = args[0].toUpperCase();
        if (command === 'GET') socket.write(args[1] === 'fail' ? '-ERR synthetic failure\r\n' : '$2\r\n42\r\n');
        else if (command === 'INFO') socket.write('$0\r\n\r\n');
        else socket.write('+OK\r\n');
      }
    });
  });
  return { ...await listen(server), commands };
}

// Minimal Mongo wire handshake + ping/error responses. Not a MongoDB engine.
export async function mongoFixture(BSON) {
  const commands = [];
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0)) {
        const message = buffer.subarray(0, buffer.readInt32LE(0)); buffer = buffer.subarray(message.length);
        const opcode = message.readInt32LE(12);
        const offset = opcode === 2004 ? message.indexOf(0, 20) + 9 : 21;
        const command = BSON.deserialize(message.subarray(offset));
        commands.push(command);
        const hello = command.ismaster || command.isMaster || command.hello;
        const doc = BSON.serialize(hello ? { ok: 1, isWritablePrimary: true, minWireVersion: 0, maxWireVersion: 25,
          maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, logicalSessionTimeoutMinutes: 30 }
          : command.fail ? { ok: 0, code: 2, errmsg: 'synthetic failure' } : { ok: 1, answer: 42 });
        const reply = Buffer.alloc((opcode === 2004 ? 36 : 21) + doc.length);
        reply.writeInt32LE(reply.length, 0); reply.writeInt32LE(1, 4); reply.writeInt32LE(message.readInt32LE(4), 8);
        reply.writeInt32LE(opcode === 2004 ? 1 : 2013, 12);
        if (opcode === 2004) reply.writeInt32LE(1, 32);
        doc.copy(reply, opcode === 2004 ? 36 : 21); socket.write(reply);
      }
    });
  });
  return { ...await listen(server), commands };
}
