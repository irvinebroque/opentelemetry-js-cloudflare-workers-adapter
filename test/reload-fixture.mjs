import { mkdir, writeFile } from 'node:fs/promises';

export const reloadFile = new URL('./generated/reload.ts', import.meta.url);
export async function writeReloadFixture(token = 'initial') {
  await mkdir(new URL('./generated/', import.meta.url), { recursive: true });
  await writeFile(reloadFile, `export const reloadToken = ${JSON.stringify(token)};\n`);
}
if (process.argv[1] === new URL(import.meta.url).pathname) await writeReloadFixture();
