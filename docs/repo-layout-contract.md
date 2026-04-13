# Floe Repository Layout Contract

This document defines the file/directory layout for the floe-core Pi package
and for projects using Floe.

## Pi Package Layout (floe-core)

```
floe-core/
├── package.json              Pi package manifest (pi.extensions, pi.skills, pi.prompts)
├── extensions/
│   └── floe.ts               Main Floe extension for Pi
├── daemon/
│   ├── service.ts            DaemonService — core orchestration
│   ├── feature-workflow.ts   Feature workflow state machine
│   ├── pi-substrate.ts       Pi SDK session substrate
│   ├── store.ts              Event store and state persistence
│   ├── server.ts             Unix socket server
│   ├── worker-channel.ts     Persistent socket transport
│   ├── worker-client.ts      Worker-side client
│   ├── client.ts             Daemon request client
│   ├── types.ts              Protocol types
│   ├── registry.ts           Session registry
│   ├── dod.ts                Definition of Done loader
│   ├── worker-types.ts       Worker config/session types
│   └── __tests__/            Test suite
├── skills/
│   ├── floe-exec/SKILL.md
│   ├── floe-preflight/SKILL.md
│   └── sizing-heuristics/SKILL.md
├── prompts/
│   ├── floe.md               Interface agent role
│   ├── implementer.md        Implementation worker role
│   ├── reviewer.md           Review worker role
│   └── planner.md            Planning worker role
├── scripts/                  Bun scripts for state/artefact operations
└── docs/
```

## Project-Local State (.floe/)

Created automatically when Floe first runs in a project.

```
.floe/
├── config.json               Project configuration
├── dod.json                  Definition of Done
├── state/                    Runtime state (gitignored)
│   ├── current.json          Active pointers (mode, active release/epic/feature)
│   ├── sessions.json         Worker session registry
│   └── daemon/               Daemon state, event journals
├── prompts/                  (optional) Project-local prompt overrides
├── .gitignore                Keeps state/ out of version control
```

## Delivery Artefacts

```
delivery/
├── releases/                 Release definitions (YAML)
├── epics/                    Epic definitions
├── features/                 Feature definitions
├── reviews/                  Rolling review records
├── summaries/                Execution summaries
├── notes/                    Pre-planning inbox
└── escalations/              Escalation records
```

## Key Principles

1. **Pi owns the harness** — sessions, models, tools, context, compaction
2. **Floe extends Pi** — extension registers tools, daemon manages workflows
3. **Global engine, local state** — no framework code copied into projects
4. **Skills loaded by Pi** — via standard Pi skill discovery, not file paths
5. **Workers are Pi SDK sessions** — created via `createAgentSession()`
