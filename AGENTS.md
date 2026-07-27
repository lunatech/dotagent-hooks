# Project instructions

## Scope

This repository publishes OMP hooks from `pre/`. The command-safety hook is a policy boundary: prefer a false positive with a clear advisory over allowing a command whose effect cannot be determined.

The shell parser adapter lives in `lib/shell-ast.ts`. It uses the WASM build of Tree-sitter and the pinned `tree-sitter-bash` grammar. All hooks that inspect shell commands **must** use `parseShellAst` from `lib/shell-ast.ts` to identify executables, sub-commands, flags, and arguments. Do not use regular expressions or ad hoc string splitting for that purpose — they match text inside quoted strings, heredocs, and comments, causing false positives, and they cannot detect dynamic tokens (`$VAR`, `$(cmd)`) that the AST marks with `word.dynamic`.

## Changes

- Keep runtime dependencies minimal and pin their exact versions in `package.json` and `package-lock.json`.
- Treat parser errors, unsupported syntax, dynamic executable names, and dynamic policy-control arguments as blocked commands.
- Preserve the advisory contract: explain the effect, show the working directory, and give the user the exact command to run personally.
- Do not weaken the prohibition on `git push` or destructive Git operations.
- Update `README.md` when installation steps, dependencies, supported profiles, or user-visible policy behavior changes.
- Whenever a blocked command is added or changed, update the blocked-command list in `README.md` in the same change.
- Use `parseShellAst` to detect commands and classify arguments; a `/\btool\b/` regex is acceptable only as a fast-path guard to skip the async WASM parse for commands that clearly do not mention the tool. It must never be the sole basis for a policy decision.
- Treat any `ShellWord` with `dynamic: true` as an unverifiable token and block with a "cannot verify" advisory rather than allowing it through or misclassifying it as an unknown verb.

## Tests

Every policy addition or behavior change must add an observable regression case in the relevant test file under `test/`. Include one case that would have bypassed or falsely triggered the old behavior, and one that proves `echo 'tool subcommand'` is not incorrectly blocked. Do not add source-text assertions or tests that only prove a helper was called.

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
