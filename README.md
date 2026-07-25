# dotagent-hooks

`dotagent-hooks` contains hooks that stop AI coding agents from running destructive or policy-violating commands.

The current hook:

- blocks destructive shell and Git commands, including `git push`;
- allows `git add`, `git stage`, and commits with valid messages;
- requires commit subjects in the form `<type>[optional scope]: <description>`;
- limits an optional commit body to two lines; and
- tells the user what a blocked command does and how to run it personally.

The hook is written for [Oh My Pi](https://github.com/can1357/oh-my-pi).

## Install from your fork

Fork this repository if you plan to add hooks or change the policy. Your fork becomes the source for `~/.agents/hooks`.

Replace `YOUR_GITHUB_USER` below with your GitHub username:

```sh
mkdir -p ~/.agents
git -C ~/.agents clone git@github.com:YOUR_GITHUB_USER/dotagent-hooks.git hooks
mkdir -p ~/.omp/agent
ln -s ../../.agents/hooks ~/.omp/agent/hooks
```

The clone command creates this layout:

```text
~/.agents/hooks/
├── LICENSE
├── README.md
└── pre/
    └── command-safety.ts
```

The symlink exposes the repository at OMP's user-level hook path:

```text
~/.omp/agent/hooks -> ../../.agents/hooks
```

Start a new OMP session after installing or changing a hook.

### Add another hook

Add the hook under `~/.agents/hooks/pre`, then commit it to your fork:

```sh
git -C ~/.agents/hooks add pre/your-hook.ts
git -C ~/.agents/hooks commit -m 'feat: add your hook'
```

Push the commit yourself when you are ready to publish it.

## Follow this repository

Use this option if you want the hooks as published here and do not plan to maintain your own versions:

```sh
mkdir -p ~/.agents
git -C ~/.agents clone git@github.com:lunatech/dotagent-hooks.git hooks
mkdir -p ~/.omp/agent
ln -s ../../.agents/hooks ~/.omp/agent/hooks
```

To receive later changes:

```sh
git -C ~/.agents/hooks pull --ff-only
```

Run the pull command periodically, then start a new OMP session. `git update` is not a standard Git command; `git pull --ff-only` fetches new commits and updates the local checkout without creating a merge commit.

## Existing installations

The clone commands expect `~/.agents/hooks` not to exist. If it already contains this repository, update it instead:

```sh
git -C ~/.agents/hooks pull --ff-only
```

If `~/.omp/agent/hooks` already exists, inspect it before creating the symlink:

```sh
readlink ~/.omp/agent/hooks
```

Do not replace an existing directory or symlink until you know what it contains.

## License

MIT
