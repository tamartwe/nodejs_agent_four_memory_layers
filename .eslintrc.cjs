/* eslint-env node */
module.exports = {
  root: true,
  env: {
    node: true,
    es2023: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    sourceType: 'module',
    ecmaVersion: 2023,
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'airbnb-base',
    'airbnb-typescript/base',
    'plugin:prettier/recommended',
  ],
  ignorePatterns: ['dist/**', 'node_modules/**', '*.cjs'],
  settings: {
    'import/resolver': {
      typescript: {
        alwaysTryTypes: true,
        project: './tsconfig.json',
      },
    },
  },
  rules: {
    // This is an ESM project — relative imports use an explicit .js extension
    // pointing at .ts source (resolved by the TS/tsx toolchain), which is the
    // opposite of what Airbnb's CJS-era default expects.
    'import/extensions': ['error', 'ignorePackages', { js: 'always', ts: 'never' }],
    // Every act/tool file in this repo exports several named things by design —
    // there is no single "main" export to prefer.
    'import/prefer-default-export': 'off',
    // A demo repo run via `npm run actN`, not a library — devDependencies vs
    // dependencies isn't a meaningful boundary here (act scripts, tsx, vitest.config
    // all live under the same "dev tooling" umbrella).
    'import/no-extraneous-dependencies': 'off',
    'no-restricted-syntax': 'off', // for...of over Maps/Sets/async iterables is idiomatic here
    'no-plusplus': 'off', // counters in loops (l1/leak-probe, model/client, l3/registry)
    'no-continue': 'off', // used for early-exit clarity in tool/script generators
    'no-await-in-loop': 'off', // the agent loop is deliberately sequential, turn by turn
    'no-underscore-dangle': 'off',
    'no-bitwise': 'off', // FNV-1a hashing (model/client) and byte-size math (64 << 20) are real bit ops
    'class-methods-use-this': 'off', // ModelClient/Tool implementations have methods that don't touch `this`
    'max-classes-per-file': 'off',
    'no-console': 'off', // this whole repo IS a console dashboard — that's the product, not a leftover debug statement
    '@typescript-eslint/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
    '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: false }],
  },
};
