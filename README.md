# dotagent-hooks

`dotagent-hooks` contains hooks that stop AI coding agents from running destructive or policy-violating commands.

The current hook:

- blocks destructive shell and Git commands, including `git push`;
- allows `git add`, `git stage`, and commits with valid messages;
- requires commit subjects in the form `<type>[optional scope]: <description>`;
- limits an optional commit body to two lines; and
- tells the user what a blocked command does and how to run it personally.

The hook is written for [Oh My Pi](https://github.com/can1357/oh-my-pi).

Installation requires Node.js 22.18 or newer with `npm`. OMP executes the hook, while the local Node installation supplies its pinned parser packages and runs the repository tests.

## Install from your fork

Fork this repository if you plan to add hooks or change the policy. Your fork becomes the source for `~/.agents/hooks`.

Replace `YOUR_GITHUB_USER` below with your GitHub username:

```sh
mkdir -p ~/.agents
git -C ~/.agents clone git@github.com:YOUR_GITHUB_USER/dotagent-hooks.git hooks
npm --prefix ~/.agents/hooks install
mkdir -p ~/.omp/agent
ln -s ../../.agents/hooks ~/.omp/agent/hooks
git -C ~/.agents/hooks config core.hooksPath .githooks
```

The clone command creates this layout:

```text
~/.agents/hooks/
├── LICENSE
├── README.md
├── package.json
├── package-lock.json
├── lib/
├── node_modules/
└── pre/
    └── command-safety.ts
```

The `npm install` step installs the Tree-sitter runtime, Bash grammar, and contributor checks. Run it before creating the hook symlink. Without the parser packages, OMP reports that the hook failed to load and does not enforce the command policy.

The symlink exposes the repository at OMP's default-profile hook path:

```text
~/.omp/agent/hooks -> ../../.agents/hooks
```

Start a new OMP session after installing or changing a hook.

### Named OMP profiles

The default symlink is not loaded by named profiles. Link the repository into each profile that should enforce the policy:

```sh
PROFILE=work
mkdir -p ~/.omp/profiles/"$PROFILE"/agent
ln -s ../../../../.agents/hooks ~/.omp/profiles/"$PROFILE"/agent/hooks
```

Replace `work` with the profile name. Start a new session for that profile after creating the link.

### Add another hook

Add the hook under `~/.agents/hooks/pre`, then commit it to your fork:

```sh
git -C ~/.agents/hooks add pre/your-hook.ts
git -C ~/.agents/hooks commit -m 'feat: add your hook'
```

Push the commit yourself when you are ready to publish it.

### Development checks

Every policy addition or behavior change must include a regression case in `test/command-safety.test.mjs`.

The tracked pre-commit hook runs the TypeScript and formatting checks. Enable it once per clone if the repository was installed before these instructions were added:

```sh
git -C ~/.agents/hooks config core.hooksPath .githooks
```

Run the complete local verification before committing:

```sh
npm --prefix ~/.agents/hooks run check
npm --prefix ~/.agents/hooks test
```

`npm run check` runs strict TypeScript validation and checks the TypeScript files with Prettier. The GitHub Actions workflow runs the same checks and tests on Ubuntu and macOS.

## Follow this repository

Use this option if you want the hooks as published here and do not plan to maintain your own versions:

```sh
mkdir -p ~/.agents
git -C ~/.agents clone git@github.com:lunatech/dotagent-hooks.git hooks
npm --prefix ~/.agents/hooks install --omit=dev
mkdir -p ~/.omp/agent
ln -s ../../.agents/hooks ~/.omp/agent/hooks
```

To receive later changes:

```sh
git -C ~/.agents/hooks pull --ff-only
npm --prefix ~/.agents/hooks install --omit=dev
```

Run both commands periodically, then start a new OMP session. `git update` is not a standard Git command; `git pull --ff-only` fetches new commits and updates the local checkout without creating a merge commit. Re-running `npm install` makes the installed parser versions match `package-lock.json`.

## Existing installations

The clone commands expect `~/.agents/hooks` not to exist. If it already contains this repository, update it instead:

```sh
git -C ~/.agents/hooks pull --ff-only
npm --prefix ~/.agents/hooks install --omit=dev
```

If `~/.omp/agent/hooks` already exists, inspect it before creating the symlink:

```sh
readlink ~/.omp/agent/hooks
```

Do not replace an existing directory or symlink until you know what it contains.

## License

MIT
