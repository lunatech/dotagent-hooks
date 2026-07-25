# Project instructions

## Scope

This repository publishes OMP hooks from `pre/`. The command-safety hook is a policy boundary: prefer a false positive with a clear advisory over allowing a command whose effect cannot be determined.

The shell parser adapter lives in `lib/shell-ast.ts`. It uses the WASM build of Tree-sitter and the pinned `tree-sitter-bash` grammar. Do not replace it with ad hoc tokenization or regular expressions for shell grammar.

## Changes

- Keep runtime dependencies minimal and pin their exact versions in `package.json` and `package-lock.json`.
- Treat parser errors, unsupported syntax, dynamic executable names, and dynamic policy-control arguments as blocked commands.
- Preserve the advisory contract: explain the effect, show the working directory, and give the user the exact command to run personally.
- Do not weaken the prohibition on `git push` or destructive Git operations.
- Update `README.md` when installation steps, dependencies, supported profiles, or user-visible policy behavior changes.

## Tests

Every policy addition or behavior change must update `test/command-safety.test.mjs` with an observable regression case. Include one case that would have bypassed or falsely triggered the old behavior. Do not add source-text assertions or tests that only prove a helper was called.

Before finishing a change, run:

```sh
npm run check
npm test
```

`npm run check` performs TypeScript and formatting checks. `npm test` exercises the policy and OMP hook registration through the public API.

## Git hooks

This repository tracks its Git hooks in `.githooks`. Enable them once per clone:

```sh
git config core.hooksPath .githooks
```

The pre-commit hook runs the sanity and style checks. Do not bypass it with `--no-verify`; fix the reported issue instead.
