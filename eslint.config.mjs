// Flat ESLint config for the whole monorepo.
// Type-aware rules are enabled via projectService, which is why TypeScript is
// pinned to 6.0.x — typescript-eslint declares `typescript: ">=4.8.4 <6.1.0"`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/dev-dist/**',
      '**/openapi/openapi.json',
    ],
  },

  // ── Base JS/TS ─────────────────────────────────────────────────────────────
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // ── Node / server code ─────────────────────────────────────────────────────
  {
    files: ['apps/api/**/*.ts', '**/*.config.{ts,mts}', '**/scripts/**/*.ts'],
    languageOptions: { globals: globals.node },
  },

  // ── React apps ─────────────────────────────────────────────────────────────
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/driver/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.serviceworker },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // ── Shared UI package ──────────────────────────────────────────────────────
  {
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      // shadcn/ui co-locates a component with its `cva` variants, and
      // `npx shadcn add` generates files that do exactly that — so enforcing
      // this here means fighting the generator forever. It also buys nothing:
      // this package is a consumed library, not an HMR boundary.
      'react-refresh/only-export-components': 'off',
    },
  },

  // ── Tests ──────────────────────────────────────────────────────────────────
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
