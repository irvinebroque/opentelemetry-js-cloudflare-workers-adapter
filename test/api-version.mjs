// Select matching integration generations without changing runtime dependencies.
// New instrumentation uses the Logs API introduced in @opentelemetry/api 1.10.
import { readFile, writeFile } from 'node:fs/promises';
const version = process.argv[2];
if (!['1.9.0', '1.10.0'].includes(version)) throw new Error('Expected API 1.9.0 or 1.10.0');
const versions = {
  pino: ['0.69.0', '0.70.0'], pg: ['0.76.0', '0.77.0'], graphql: ['0.71.0', '0.72.0'], winston: ['0.68.0', '0.69.0'],
  redis: ['0.71.0', '0.72.0'], ioredis: ['0.71.0', '0.72.0'], mongodb: ['0.76.0', '0.77.0'], knex: ['0.67.0', '0.68.0'],
  'aws-sdk': ['0.78.0', '0.79.0'], kafkajs: ['0.32.0', '0.33.0'], amqplib: ['0.70.0', '0.71.0'],
  undici: ['0.33.0', '0.34.0'], fetch: ['0.223.0', '0.300.0'],
};
const file = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(await readFile(file, 'utf8'));
manifest.devDependencies['@opentelemetry/api'] = version;
for (const [name, pair] of Object.entries(versions)) manifest.devDependencies[`@opentelemetry/instrumentation-${name}`] = pair[version === '1.9.0' ? 0 : 1];
await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
