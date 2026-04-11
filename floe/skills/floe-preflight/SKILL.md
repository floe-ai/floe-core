---
name: floe-preflight
description: >
  Setup and readiness checks for the Floe execution framework. Handles first-run
  initialisation, model configuration, git setup, remote configuration, and
  repo-readiness validation. Invoked automatically on first conversation or when
  readiness is missing. After preflight completes, hand off to floe for
  normal feature work.
  Keywords: setup, init, configure, preflight, bootstrap, onboarding, git, remote,
  model, readiness.
license: MIT
compatibility: Requires Bun (https://bun.sh).
---

# Floe Preflight Skill

## When to use this skill

Use this skill when the system is **not yet ready for normal feature work**:

- Framework not installed (`.floe/` missing or damaged)
- Configuration missing or incomplete (`configured: false`)
- Git repository not initialised
- Remote not configured (when the user wants one)
- Any pre-condition for normal floe operation is unmet

This skill is **not loaded during normal feature execution**. Floe invokes it only when readiness checks fail.

## Readiness check sequence

Run these checks in order. Stop at the first failure and address it before continuing.

### 1. Framework presence

```bash
bun run .floe/scripts/state.ts get
```

If this fails or `.floe/` is missing:

```bash
bun run .floe/scripts/init.ts
```

This scaffolds the full delivery structure, creates runtime state, and initialises a local git repository.

### 2. Git repository

After init, check `git_initialised` in the response. If `true`, the repo is ready.

**Ask the user about remote setup:**

> "The framework is initialised and a local git repository is ready. Do you want to push this project to a remote (e.g. GitHub)? If yes, paste the repository URL and I'll configure the remote, set up credential storage, and push the initial commit. If you prefer to work locally for now, we can skip this."

If the user provides a URL:

```bash
bun run .floe/scripts/init.ts --remote <url> [--branch main]
```

- HTTPS remotes: configures `credential.helper` (osxkeychain on macOS, wincred on Windows, store on Linux)
- SSH remotes: uses existing SSH key
- Makes initial commit and pushes with upstream tracking

Check `remote_setup.ok` in the response. If `false`, surface the error.

If the user skips: proceed. They can add a remote later with `bun run .floe/scripts/init.ts --remote <url>`.

### 3. Model configuration

```bash
bun run .floe/bin/floe.ts show-config
```

If config is missing or `configured` is `false`:

```bash
bun run .floe/bin/floe.ts configure
```

Present the user with model options and recommend a default. Once the user agrees:

```bash
bun run .floe/bin/floe.ts configure --model <model> --thinking <level>
```

**Rules:**
- Model names are free text — the Pi substrate validates them at session creation time.
- Do not drive a TUI wizard. The configure command is a data endpoint. You own the UX.

### 4. Readiness confirmation

When all checks pass, emit a clear completion state:

> "Setup complete. Repo ready. Runtime configured. Feature work can begin."

## Re-invocation

This skill can be re-invoked at any time if readiness is lost (e.g. config wiped after reinstall). Any role encountering a readiness failure should surface the problem — floe then invokes preflight to restore readiness.

## Model configuration changes (runtime)

When the user mentions a model or thinking level in plain text during normal operation:

1. Check current config: `bun run .floe/bin/floe.ts show-config`
2. Apply: `bun run .floe/bin/floe.ts update-config --role <role|all> --model <exact-id> [--thinking <level>]`
3. Confirm what changed.

If no config exists, run the full preflight flow.
