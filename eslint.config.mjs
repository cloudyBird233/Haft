import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.config.{js,mjs,cjs,ts}',
      'apps/api/prisma/**',
      'tests/e2e/**-snapshots/**',
      'docs/screenshots/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  {
    // Node utility scripts are plain ESM, so they need Node globals rather than
    // the TypeScript project settings above.
    files: ['apps/api/scripts/**/*.mjs', 'tests/e2e-real/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Real OS fixtures are deliberately plain CommonJS so they can be spawned
    // by the supervisor without a TypeScript loader.
    files: ['apps/runner/test/fixtures/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },
  {
    // NestJS resolves constructor dependencies from decorator metadata. Importing
    // injected classes with `import type` erases that metadata at compile time,
    // so keep the API free to use regular imports for DI tokens.
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='data-testid'] Literal[value='']",
          message: 'data-testid must not be empty.',
        },
      ],
    },
  },
);
