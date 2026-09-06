# Cross-Harness Compatibility Plan

Temporary implementation plan for making `dotagent-hooks` load through both Oh My Pi (OMP) and pi.

## Scope

All changes are confined to this repository. Do not modify the OMP repository or the pi repository.

The command policies, shell AST behavior, advisories, and existing OMP behavior must remain unchanged.

## Harness selection

Do not detect the importing harness at runtime.

Each harness selects a different entrypoint through its existing discovery mechanism:

```text
OMP discovery -> dotagent-hooks/pre/*.ts
pi manifest   -> dotagent-hooks/extensions/index.ts
```

The importer is therefore determined statically by the module path selected by the harness. There must be no runtime checks for OMP, pi, package names, or environment variables.

## Shared checkout and existing OMP link

The existing installation uses one shared checkout:

```text
~/.agents/hooks                 dotagent-hooks repository
~/.omp/agent/hooks              -> ../../.agents/hooks
```

That link is already sufficient for OMP to discover `pre/*.ts`. It must not be replaced or duplicated.

Pi does not follow `~/.omp/agent/hooks` as an extension directory. Pi must receive a separate package/settings reference to the same `~/.agents/hooks` directory. The pi package metadata in this repository then selects the pi entrypoint.

This results in two discovery references to one checkout, not two installations or two copies of the hooks:

```text
OMP -> ~/.omp/agent/hooks -> ~/.agents/hooks/pre/*.ts
pi  -> pi package reference -> ~/.agents/hooks/extensions/index.ts
```

The symlink changes installation/discovery only. It does not require runtime harness detection or changes to the shared policy logic.

## Implementation

### 1. Add a local compatibility type

Add a type definition within `dotagent-hooks` describing the common API used by the existing hooks:

- `on` for `tool_call`;
- `on` for `tool_result`;
- `registerCommand`;
- tool-call event data;
- tool-result event data;
- command context and UI notification.

This is a compile-time boundary only. It does not restrict the complete API object supplied by either harness.

### 2. Remove OMP-specific imports from shared hooks

Replace imports of:

```text
@oh-my-pi/pi-coding-agent/extensibility/hooks
```

in shared hook files with the local compatibility type.

Shared policy files must not import either harness’s coding-agent package.

Shared runtime imports may remain for:

- local modules;
- Node built-ins;
- Tree-sitter dependencies.

### 3. Preserve OMP entrypoints

Keep the existing `pre/*.ts` modules as OMP hook entrypoints.

Their default factories should continue to register directly with the OMP API. No changes to OMP discovery or installation are required.

### 4. Add the pi entrypoint

Add an entrypoint under `extensions/` within this repository.

It should import the existing hook factories and register them with the pi API object passed to the entrypoint. It must reuse the existing hook implementations rather than duplicate policy logic.

The pi entrypoint does not need to identify pi at runtime. It is selected because pi loads that path from the package manifest.

### 5. Add pi package metadata

Update this repository’s `package.json` with pi extension metadata pointing to the new pi entrypoint.

The OMP hook layout remains based on `pre/*.ts`; the pi manifest is an additional discovery path. Installation documentation should show pi referencing the existing `~/.agents/hooks` checkout rather than creating another checkout or linking pi to `~/.omp/agent/hooks`.

### 6. Keep adapters at the boundary

If OMP and pi differ in a field used by a hook, normalize that difference in the entrypoint or a small adapter module inside this repository.

Do not add OMP-versus-pi conditionals to policy implementations.

The expected flow is:

```text
OMP API -> OMP-selected entrypoint -> shared hook implementation
pi API  -> pi-selected entrypoint  -> shared hook implementation
```

### 7. Optional capabilities

Only features that genuinely differ between the APIs should be treated as optional capabilities. For example, ask mode may need to account for different available search tools.

This must be handled through the entrypoint or compatibility layer, not by detecting the harness name.

## Verification

Add or update tests only in this repository.

Verify:

- existing OMP hook factories still load;
- the pi manifest entrypoint loads;
- both entrypoints use the same policy implementation;
- destructive commands are blocked through both paths;
- safe commands pass through both paths;
- tool-result annotation still works;
- `/ask` remains correctly registered;
- no shared hook module imports an OMP- or pi-specific coding-agent package.
