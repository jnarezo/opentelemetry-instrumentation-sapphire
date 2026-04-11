import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist']),
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    rules: {
      'arrow-body-style': 'error',
      'camelcase': ['warn'],
      'curly': 'error',
      'dot-notation': 'error',
      'default-param-last': 'error',
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
    },
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.mjs'],
        },
      },
    },
  }
);
