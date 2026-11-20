import process from 'node:process';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    ...(process.env.CI ? {} : { reporters: ['tree'] }),
  },
});
