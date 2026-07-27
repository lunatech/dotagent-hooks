# dotagent-hooks

`dotagent-hooks` provides an [Oh My Pi](https://github.com/can1357/oh-my-pi) hook that stops AI coding agents from running destructive or policy-violating commands.

## Command policy

The hooks block these commands and shell behaviors by default:

- every command invoked through `sudo`;
- file removal or replacement: `rm`, `rmdir`, `unlink`, `shred`, `truncate`, and `mv`;
- process and system control: `kill`, `killall`, `pkill`, `halt`, `poweroff`, `reboot`, and `shutdown`;
- disk writes: `mkfs*`, `dd` with an `of=` target, and destructive `diskutil` operations;
- resource deletion: `terraform destroy`, `kubectl delete`, Docker `rm`, `rmi`, and prune operations;
- package removal through `npm`, `pnpm`, `yarn`, `pip`, `pip3`, `brew`, `gem`, or `cargo`;
- `find -delete`, `find -exec`, `find -execdir`, and `xargs`;
- Git operations that publish, delete, or discard work: `push`, `clean`, `rm`, destructive `reset`, `restore`, `checkout`, forced `switch`, branch or tag deletion, and `stash drop` or `stash clear`;
- shell output redirection, command or process substitution, malformed syntax, dynamic executable names, and dynamic policy-control arguments;
- AWS CLI write/mutating operations: any `aws <service> <action>` where the action is not a read-only prefix (`describe`, `list`, `get`, `head`, `check`, `query`, `scan`, `search`, `validate`, `generate-presigned`, `help`, `wait`);
- `curl` requests that mutate remote state: `-X POST/PUT/DELETE/PATCH`, `--request POST/PUT/DELETE/PATCH`, or any `--data`/`-d` flag;
- `gcx` CLI operations that mutate live Grafana Cloud state: write verbs such as `create`, `update`, `delete`, `push`, `apply`, `set`, `reset`, and others; unrecognised verbs are blocked conservatively;
- `kubectl` write operations: `apply`, `create`, `delete`, `replace`, `patch`, `edit`, `scale`, `drain`, `cordon`, `uncordon`, `taint`, `annotate`, `label`, `exec`, `cp`, and destructive `rollout` sub-commands (`restart`, `undo`, `pause`, `resume`);
- package installs that modify environments silently: `pip`/`pip3 install`, `uv add`, `npm install`/`npm i`, and `brew install`.

The commit-safety hook also requires Git commit subjects in the form `<type>[optional scope]: <description>` and limits an optional commit body to two lines. A blocked-command advisory explains the effect, shows the working directory, identifies the local opt-in file for supported non-sudo executables, and gives the user the exact command to run personally. It also states that opt-in cannot override `sudo`, destructive Git operations, or shell behavior whose effects cannot be inspected safely.

The `ask-mode` hook provides a `/ask` slash command that restricts the agent to `read` and `web_search` only. Toggle with `/ask`, `/ask off`, and `/ask status`, or start with `OMP_ASK_MODE=1`.

When a Python command fails with a `ModuleNotFoundError` or `ImportError`, the `guard-pkg-install` hook appends `uv`/`uvx` guidance to the output without blocking the result.

### User-allowed commands

The optional `user-allowed-commands` file lives in the repository root beside `user-allowed-commands.example`. It is ignored by Git, so each checkout can keep its own policy without modifying tracked files.

Create it from the example:

```sh
cp user-allowed-commands.example user-allowed-commands
```

The example lists every configurable executable with each entry commented out. Remove the leading `#` only from executables the agent may run destructively as the current user:

```text
# kill
# killall
pkill
```

Put one executable name on each enabled line. Blank lines and lines beginning with `#` are ignored. Entries match the executable name, so `pkill` also permits `/usr/bin/pkill`. Do not include arguments. The hook reads the local file for every command, so edits apply immediately.

The file cannot permit `sudo`, destructive Git operations, output redirection, command or process substitution, malformed or dynamic syntax, `xargs`, or `find -exec`/`-execdir`. For example, listing `pkill` permits `pkill -f worker` but `sudo pkill -f worker` remains blocked.

For the standard installation, the local file is `~/.agents/hooks/user-allowed-commands`. Named OMP profiles linked to the same checkout share it.

## Requirements

- OMP 16.4.5 or newer
- Node.js 22.18 or newer with `npm`

Check both versions before installing:

```sh
omp --version
node --version
```

Run `omp update` if OMP is older than 16.4.5.

### Why OMP 16.4.5 is required

OMP 16.4.3 and 16.4.4 discover the hook but fail while importing it in compiled binaries. The bundled `header-generator` dependency tries to read data files from the build machine's path, so OMP never registers the `tool_call` guard and the command policy is not enforced.

[Issue #5178](https://github.com/can1357/oh-my-pi/issues/5178) tracks the failure. [PR #5180](https://github.com/can1357/oh-my-pi/pull/5180) contains the runtime fix shipped in OMP 16.4.5.

## Install

Choose the source you intend to maintain:

- **Follow this repository** if you want the published policy without local changes.
- **Install from your fork** if you plan to add hooks or change the policy.

The commands below expect `~/.agents/hooks` and `~/.omp/agent/hooks` not to exist. If this repository is already installed, use [Update an existing installation](#update-an-existing-installation). If only the OMP hook path exists, inspect it before continuing:

```sh
readlink ~/.omp/agent/hooks
```

Do not replace an existing directory or symlink until you know what it contains.

### Follow this repository

```sh
mkdir -p ~/.agents
git -C ~/.agents clone git@github.com:lunatech/dotagent-hooks.git hooks
cp ~/.agents/hooks/user-allowed-commands.example ~/.agents/hooks/user-allowed-commands
npm --prefix ~/.agents/hooks install --omit=dev
mkdir -p ~/.omp/agent
ln -s ../../.agents/hooks ~/.omp/agent/hooks
```

### Install from your fork

Fork this repository, replace `YOUR_GITHUB_USER` below with your GitHub username, and run:

```sh
mkdir -p ~/.agents
git -C ~/.agents clone git@github.com:YOUR_GITHUB_USER/dotagent-hooks.git hooks
cp ~/.agents/hooks/user-allowed-commands.example ~/.agents/hooks/user-allowed-commands
npm --prefix ~/.agents/hooks install
mkdir -p ~/.omp/agent
ln -s ../../.agents/hooks ~/.omp/agent/hooks
git -C ~/.agents/hooks config core.hooksPath .githooks
```

### How installation works

The repository lives at `~/.agents/hooks`. `npm install` supplies the pinned Tree-sitter runtime and Bash grammar used by the hook; without those packages, OMP reports a load failure and does not enforce the policy.

The symlink exposes the repository at OMP's default-profile hook path:

```text
~/.omp/agent/hooks -> ../../.agents/hooks
```

Exit OMP and launch a new OMP process after installation. OMP discovers hooks during process startup; opening another conversation in an existing process does not reload them.

## Named OMP profiles

Named profiles do not load the default-profile symlink. Link the repository into every profile that should enforce the policy:

```sh
PROFILE=work
mkdir -p ~/.omp/profiles/"$PROFILE"/agent
ln -s ../../../../.agents/hooks ~/.omp/profiles/"$PROFILE"/agent/hooks
```

Replace `work` with the profile name, then exit and relaunch that profile's OMP process.

## Update an existing installation

To follow the published repository:

```sh
git -C ~/.agents/hooks pull --ff-only
npm --prefix ~/.agents/hooks install --omit=dev
```

If you maintain a fork and need the development tools:

```sh
git -C ~/.agents/hooks pull --ff-only
npm --prefix ~/.agents/hooks install
```

`git pull --ff-only` updates the checkout without creating a merge commit. Re-running `npm install` keeps the installed parser versions aligned with `package-lock.json`.

Exit OMP and launch a new process after every update so it loads the current hook.

## Develop the policy

Add hook factories under `pre/`. Every policy addition or behavior change must include an observable regression case in `test/command-safety.test.mjs`.

Run the full local verification before committing:

```sh
npm --prefix ~/.agents/hooks run check
npm --prefix ~/.agents/hooks test
```

`npm run check` performs strict TypeScript and formatting checks. `npm test` exercises the command policy and OMP hook registration through the public API. GitHub Actions runs the same checks on Ubuntu and macOS.

This repository tracks a pre-commit hook that runs `npm run check`. Enable it once per clone:

```sh
git -C ~/.agents/hooks config core.hooksPath .githooks
```

The Git hook runs before `git commit`; it does not run before `git push`. The OMP command-safety hook enforces the push policy for agent-issued shell commands after OMP loads it.

To add and commit another hook:

```sh
git -C ~/.agents/hooks add pre/your-hook.ts
git -C ~/.agents/hooks commit -m 'feat: add your hook'
```

Push the commit yourself when you are ready to publish it.

## License

MIT
