// @ts-check
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

/**
 * Flat ESLint config (ESLint 9+, "eslint.config.js").
 *
 * Beyond standard TypeScript linting, this file encodes three
 * project-specific bans lifted directly from SECURITY.md's threat model.
 * They are `error`, not `warn` — a change that weakens one of these is,
 * per SECURITY.md's own header, "an explicit, documented decision," and a
 * silenced/downgraded lint rule should not be how that happens.
 */

const restrictedSyntaxSecurityRules = [
  {
    // SECURITY.md §3.7 (XSS): "dangerouslySetInnerHTML is banned by lint
    // rule." Mail log content and other server-derived strings are treated
    // as untrusted; React's default escaping must not be bypassed.
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message:
      'dangerouslySetInnerHTML is banned (SECURITY.md §3.7). Render untrusted content as text, never as HTML.',
  },
  {
    // SECURITY.md §3.2 (command injection) / ARCHITECTURE.md §5: commands
    // are invoked as argv arrays only, never via a shell. `exec`/`execSync`
    // run their argument through `/bin/sh -c`, so building that string with
    // interpolation is exactly the injection pattern the broker forbids.
    selector:
      "CallExpression[callee.name=/^(exec|execSync)$/] > TemplateLiteral[expressions.length>0]",
    message:
      'child_process exec/execSync must not be called with an interpolated template literal (SECURITY.md §3.2). Use execFile/execFileSync/spawn with an argv array instead.',
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(exec|execSync)$/] > TemplateLiteral[expressions.length>0]",
    message:
      'child_process exec/execSync must not be called with an interpolated template literal (SECURITY.md §3.2). Use execFile/execFileSync/spawn with an argv array instead.',
  },
  {
    selector:
      "CallExpression[callee.name=/^(exec|execSync)$/] > BinaryExpression[operator='+']",
    message:
      'child_process exec/execSync must not be called with a string built by concatenation (SECURITY.md §3.2). Use execFile/execFileSync/spawn with an argv array instead.',
  },
  {
    selector:
      "CallExpression[callee.property.name=/^(exec|execSync)$/] > BinaryExpression[operator='+']",
    message:
      'child_process exec/execSync must not be called with a string built by concatenation (SECURITY.md §3.2). Use execFile/execFileSync/spawn with an argv array instead.',
  },
  {
    // SECURITY.md §3.2 / ARCHITECTURE.md §5, the argv-array loophole: banning
    // child_process.exec is not sufficient, because `['sh', '-c', input]`
    // reintroduces a shell through a perfectly well-formed argv array — and
    // that is precisely how a Docker exec (dockerode, or `docker exec`) would
    // smuggle one in. The broker's operation allowlist is the real control;
    // this rule stops the pattern reaching review in the first place.
    selector: "ArrayExpression > Literal[value='-c']",
    message:
      "Passing '-c' in an argv array invokes a shell (SECURITY.md §3.2), which defeats the point of using argv. Invoke the target binary directly with its arguments as separate array elements.",
  },
  {
    selector: "ArrayExpression > Literal[value=/^(\\/bin\\/)?(sh|bash|zsh|ash|dash)$/]",
    message:
      'Naming a shell in an argv array is banned (SECURITY.md §3.2). Commands run inside the mail container must invoke the target binary directly — see ARCHITECTURE.md §5 command construction rules.',
  },
  {
    // SECURITY.md §3.8 (SQL injection): every query uses parameterised
    // statements. Targets db.prepare(...) — the API of `node:sqlite`'s
    // DatabaseSync (ARCHITECTURE.md §3.1) — called with a built-up string
    // instead of a parameterised literal.
    selector:
      "CallExpression[callee.property.name='prepare'] > TemplateLiteral[expressions.length>0]",
    message:
      'SQL passed to .prepare() must not be an interpolated template literal (SECURITY.md §3.8). Use a static query string with parameter placeholders (?).',
  },
  {
    selector:
      "CallExpression[callee.property.name='prepare'] > BinaryExpression[operator='+']",
    message:
      'SQL passed to .prepare() must not be built by string concatenation (SECURITY.md §3.8). Use a static query string with parameter placeholders (?).',
  },
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      '**/blob-report/**',
      '**/.vite/**',
      '**/*.tsbuildinfo',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
      globals: {
        ...globals.es2024,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-restricted-syntax': ['error', ...restrictedSyntaxSecurityRules],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'child_process',
              importNames: ['exec', 'execSync'],
              // SECURITY.md §3.2 — argv arrays only, never a shell.
              message:
                'exec/execSync run a shell (SECURITY.md §3.2). Import execFile/execFileSync/spawn and pass an argv array.',
            },
            {
              name: 'node:child_process',
              importNames: ['exec', 'execSync'],
              message:
                'exec/execSync run a shell (SECURITY.md §3.2). Import execFile/execFileSync/spawn and pass an argv array.',
            },
          ],
        },
      ],
    },
  },

  // apps/server and apps/broker run under Node.js.
  {
    files: ['apps/server/**/*.{ts,tsx}', 'apps/broker/**/*.{ts,tsx}', 'packages/*/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // apps/web runs in the browser.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Config files (this file, vite.config.ts, etc.) run under Node.js at
  // build/dev time regardless of which workspace they live in.
  {
    files: ['**/*.config.{js,ts,mjs,cjs}', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];
