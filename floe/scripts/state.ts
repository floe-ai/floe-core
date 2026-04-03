#!/usr/bin/env bun
/**
 * floe-exec state — read and write runtime state.
 *
 * Usage:
 *   bun run scripts/state.ts get                          # read full state
 *   bun run scripts/state.ts get <field>                  # read one field
 *   bun run scripts/state.ts set <field> <value>          # set one field
 *   bun run scripts/state.ts set-mode <mode>              # shortcut for setting mode
 *   bun run scripts/state.ts set-active <type> <id>       # set active release/epic/feature
 *   bun run scripts/state.ts set-blocker <class> <desc>   # set current blocker
 *   bun run scripts/state.ts clear-blocker                # clear blocker
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths, readJson, writeJson, timestamp, output, ok, fail } from "./helpers.ts";

const p = paths();
const stateFile = join(p.state, "current.json");

function loadState(): any {
  if (!existsSync(stateFile)) fail("Runtime state not found. Run init first.");
  return readJson(stateFile);
}

function saveState(state: any): void {
  state.updated_at = timestamp();
  writeJson(stateFile, state);
}

const MODES = ["initialise", "discover", "plan", "execute", "review", "idle"];
const ACTIVE_TYPES = ["release", "epic", "feature"];
const BLOCKER_CLASSES = [
  "missing_context", "ambiguous_requirement", "architecture_conflict",
  "environment_issue", "flaky_test", "dependency_not_ready",
  "feature_too_large", "implementation_error", "unexpected_regression",
  "user_decision_required", "scope_change_required",
];

const [cmd, ...args] = Bun.argv.slice(2);

switch (cmd) {
  case "get": {
    const state = loadState();
    if (args[0]) {
      output({ ok: true, field: args[0], value: state[args[0]] ?? null });
    } else {
      output({ ok: true, state });
    }
    break;
  }

  case "set": {
    if (args.length < 2) fail("Usage: state set <field> <value>");
    const state = loadState();
    let value: any = args[1];
    // Try to parse as JSON for complex values
    try { value = JSON.parse(value); } catch {}
    state[args[0]] = value;
    saveState(state);
    ok(`Set ${args[0]}`, { field: args[0], value });
    break;
  }

  case "set-mode": {
    if (!args[0] || !MODES.includes(args[0])) {
      fail(`Invalid mode. Expected one of: ${MODES.join(", ")}`);
    }
    const state = loadState();
    state.mode = args[0];
    saveState(state);
    ok(`Mode set to ${args[0]}`);
    break;
  }

  case "set-active": {
    if (!args[0] || !ACTIVE_TYPES.includes(args[0])) {
      fail(`Invalid type. Expected one of: ${ACTIVE_TYPES.join(", ")}`);
    }
    const field = `active_${args[0]}_id`;
    const state = loadState();
    state[field] = args[1] || null;
    saveState(state);
    ok(`Active ${args[0]} set to ${args[1] || "null"}`);
    break;
  }

  case "set-blocker": {
    if (!args[0] || !BLOCKER_CLASSES.includes(args[0])) {
      fail(`Invalid blocker class. Expected one of: ${BLOCKER_CLASSES.join(", ")}`);
    }
    const state = loadState();
    state.blocker = {
      class: args[0],
      description: args.slice(1).join(" ") || "No description",
      since: timestamp(),
    };
    saveState(state);
    ok(`Blocker set: ${args[0]}`);
    break;
  }

  case "clear-blocker": {
    const state = loadState();
    delete state.blocker;
    saveState(state);
    ok("Blocker cleared");
    break;
  }

  default:
    fail(`Unknown command: ${cmd}. Expected: get, set, set-mode, set-active, set-blocker, clear-blocker`);
}
