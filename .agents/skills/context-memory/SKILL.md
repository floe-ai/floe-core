---
name: context-memory
description: >
  ALWAYS use this skill FIRST when starting work on a project. Search memory
  before reading files. Write memory after completing work. Provides repo-local
  memory retrieval and write-back tools for continuity across agent sessions.
  Keywords: context, history, onboarding, prior work, session memory, project
  knowledge, decisions, summaries.
license: MIT
compatibility: Requires Bun (https://bun.sh). Works with Codex, Copilot, and Claude.
---

# Context Memory Skill

## When to use this skill

**BEFORE you start working — always.** Search memory first, before exploring
files, reading code, or making plans. Prior agents may have already mapped the
codebase, recorded decisions, or left context that saves you significant work.
Starting without checking memory means you risk duplicating effort, contradicting
prior decisions, or missing critical context.

**AFTER you finish working — always.** Write back what you learned. Every
substantial piece of work produces knowledge that will help the next agent:
decisions made, approaches tried, gotchas discovered, architecture understood.
If you don't write it down, the next agent starts from zero.

**The only exception** is trivially obvious tasks — single-line typo fixes,
simple renames, or formatting changes where no prior context could matter.

## How to invoke

All commands must be run from **this skill's directory**. The scripts use their
own location to detect the project root and resolve the database path automatically.

```bash
bun run scripts/memory.ts <command> [args]
```

If you cannot run scripts or the skill directory is not accessible, stop and ask the user.

## Required workflow

### Step 1: Search memory FIRST

Before reading any project files, search for context relevant to your task.

**`recall`** is a fast search against saved memories and indexed documents:

```bash
bun run scripts/memory.ts recall "your task description"
```

**`context`** runs full discovery and indexing first, then builds a richer bundle — use
it when onboarding to a project or when `recall` returns thin results:

```bash
bun run scripts/memory.ts context "your task description"
```

To pull in linked neighbours (memories or documents connected via relationships):

```bash
bun run scripts/memory.ts recall "your task description" --expand-links
```

Use what you find to inform your approach. Only then proceed to explore files.

### Step 2: Do your work

Proceed with the task, informed by the memory context you retrieved.

If you discover important documents during your work, register them so future
agents can find them. Any file under the project — including artefacts stored
under `.ai/` — can be indexed:

```bash
bun run scripts/memory.ts remember docs/architecture.md src/config.py
```

After saving related memories, connect them with a relationship so retrieval
can surface them together:

```bash
bun run scripts/memory.ts link memory <id-a> derived_from document <doc-id>
bun run scripts/memory.ts link memory <id-a> relates_to memory <id-b>
```

See the **Relationship types** table below for valid relation names and their
retrieval weights.

### Step 3: Write back memories BEFORE finishing

This is not optional. Before you consider your work complete, write back:

**What to record — ask yourself these questions:**

- Did I make a decision? → `--type decision`
- Did I discover how something works? → `--type learning`
- Did I find a gotcha or edge case? → `--type issue`
- Did I establish a pattern or convention? → `--type pattern`
- Did I try something that didn't work? Record it so the next agent doesn't repeat it.

**How to record it:**

```bash
bun run scripts/memory.ts save "Chose JWT with refresh tokens over session cookies. API is stateless across regions." --type decision --tags auth,api
```

Multiple memories? Save each one:

```bash
bun run scripts/memory.ts save "FTS5 requires UNINDEXED for metadata columns" --type learning --tags sqlite,search
bun run scripts/memory.ts save "text_cache was bloating the DB - read content from disk" --type issue --tags performance
```

### What good memory records look like

**Good:** *"Chose JWT with refresh token rotation over session cookies. The API is
stateless and deployed across multiple regions, so server-side sessions would
require a shared store. Refresh tokens rotate on each use with a 7-day expiry."*

**Bad:** *"Implemented authentication."*

Good records capture the **decision**, the **reasoning**, and the **constraints**.
Bad records state what happened without explaining why.

## Quick reference

From the skill directory (this file):

| Command | What it does |
|---------|-------------|
| `bun run scripts/memory.ts recall "<query>"` | Search memory for relevant context |
| `bun run scripts/memory.ts context "<objective>"` | Build a context bundle for a task |
| `bun run scripts/memory.ts save "<text>" --type <type> --tags <tags>` | Save a memory |
| `bun run scripts/memory.ts remember <file> [file...]` | Register and index file(s) |
| `bun run scripts/memory.ts status` | Show memory overview |
| `bun run scripts/memory.ts link <src_type> <src_id> <relation> <dst_type> <dst_id>` | Create a relationship |
| `bun run scripts/memory.ts links <type> <id> [--direction out|in|both]` | Query relationships |
| `bun run scripts/memory.ts unlink <relationship_id>` | Remove a relationship |

**Relationship flags:** `--weight <n>`, `--meta <json>`, `--relation <name>`, `--limit <n>`

**Retrieval flags:** `recall` and `context` accept `--expand-links` to include one-hop linked neighbours in results. Filter with `--link-relations <csv>` and `--link-limit <n>`.

### Relationship types

Use these relation names when calling `link`. The retrieval weight shown affects
how strongly linked results rank when `--expand-links` is used — higher means
closer to the source hit's score.

| Relation | Weight | Use when |
|----------|--------|----------|
| `derived_from` | 1.00 | This result was extracted or generated from the source |
| `continues` | 1.00 | This result continues or extends prior work |
| `depends_on` | 1.00 | This result requires the source to make sense |
| `blocks` | 1.00 | This result is blocked by or blocks the source |
| `describes` | 1.00 | This result describes or documents the source |
| `belongs_to` | 0.85 | This result is a component of a larger whole |
| `supersedes` | 0.85 | This result replaces an older source |
| `relates_to` | 0.60 | General association (default for unknown relations) |
| `mentions` | 0.35 | Weak reference — the source merely cites this result |

### Memory types

| Type | Use when |
|------|----------|
| `decision` | You chose between alternatives |
| `learning` | You discovered how something works |
| `pattern` | You established a convention or approach |
| `issue` | You found a bug, gotcha, or edge case |
| `preference` | You noted a project/team preference |
| `constraint` | You identified a technical limitation |

## Guidelines

- **Memory first, files second.** Always search before exploring the codebase.
- **Write before you finish.** Every task that produces knowledge should leave a memory record.
- Keep records concise but complete — capture decisions, reasoning, and constraints.
- All file references in memory are relative paths from the project root.
- The memory database is created automatically at project root under `.ai/memory/memory.db` and is gitignored.
