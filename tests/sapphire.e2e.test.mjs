import { execFile } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'vitest';

const runNode = promisify(execFile);
const app = fileURLToPath(new URL('./sapphire-app.mjs', import.meta.url));

test.each(['CommonJS', 'ESM'])(
  'patches Sapphire and exports a listener trace with %s loading',
  async (format) => {
    await runNode(process.execPath, [app, format], { timeout: 15_000 });
  },
  20_000
);
