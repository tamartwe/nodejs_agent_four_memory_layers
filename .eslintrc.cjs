module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
    ecmaVersion: 2022,
  },
  extends: [
    'airbnb-base',
    'airbnb-typescript/base',
  ],
  plugins: ['@typescript-eslint'],
  settings: {
    'import/resolver': {
      typescript: { project: './tsconfig.json' },
    },
  },
  ignorePatterns: ['dist', 'node_modules', '.cache', '*.cjs'],
  rules: {
    // This is a talk repo: every demo is a top-level script, not a module
    // that gets imported, so console output IS the product.
    'no-console': 'off',

    // Demos intentionally run their turns in sequence, on stage, so the
    // printed step/turn numbers line up with real per-call token usage.
    // Parallelising them would be correct for a service, wrong for a demo.
    'no-await-in-loop': 'off',

    // for...of reads better than reduce/forEach for the top-level demo
    // scripts, and Airbnb's rationale (regenerator overhead) doesn't apply
    // under a modern target.
    'no-restricted-syntax': 'off',

    // ToolRunState.seq and MemoryStore.rrf rank counters are simple and
    // idiomatic with ++.
    'no-plusplus': 'off',

    // These are single-file demos and small libraries, not a public
    // package — forcing a default export per file adds ceremony with no
    // reader benefit.
    'import/prefer-default-export': 'off',
    'import/no-default-export': 'off',

    // TS import resolution already enforces extensionless relative
    // imports via moduleResolution "bundler"; requiring .js extensions on
    // .ts source files fights the toolchain instead of the language.
    'import/extensions': 'off',

    // Classes such as MemoryStore expose small pure helpers (preview,
    // hist) that don't touch `this` by design.
    'class-methods-use-this': 'off',
  },
  overrides: [
    {
      // Top-level demo/entry scripts use await at module scope by design.
      files: [
        'src/00-basic-agent/agent.ts',
        'src/*/before.ts',
        'src/*/after.ts',
        'src/*/seed.ts',
        'src/*/demo.ts',
      ],
      rules: {
        '@typescript-eslint/no-unused-expressions': 'off',
      },
    },
  ],
};
