import { execFile } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { describe, test } from 'vitest';
import { lifecycleScenarioNames } from './sapphire-lifecycle.mjs';

const runNode = promisify(execFile);
const app = fileURLToPath(new URL('./sapphire-app.mjs', import.meta.url));
const options = { timeout: 15_000 };
const testTimeout = 20_000;

describe.each(['CommonJS', 'ESM'])('%s loading', (format) => {
  test(
    'patches and unpatches Sapphire listeners',
    async () => {
      await runNode(process.execPath, [app, format, 'loader'], options);
    },
    testTimeout
  );

  test.each(lifecycleScenarioNames)(
    '%s',
    async (scenario) => {
      await runNode(process.execPath, [app, format, scenario], options);
    },
    testTimeout
  );
});
