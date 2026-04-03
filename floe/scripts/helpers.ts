#!/usr/bin/env bun
/**
 * Shared helpers for floe-exec scripts.
 * Handles project root detection, path resolution, schema loading, and JSON I/O.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";

// ── Project root detection ────────────────────────────────────────────

const MARKERS = [".git", ".floe", ".github", ".agents", ".claude", "package.json"];

export function findProjectRoot(from?: string): string {
  let dir = from ?? dirname(dirname(import.meta.dir)); // up from scripts/ -> floe/ -> project root
  for (let i = 0; i < 20; i++) {
    if (MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(dirname(import.meta.dir));
}

// ── Path helpers ──────────────────────────────────────────────────────

export function paths(root?: string) {
  const projectRoot = root ?? findProjectRoot();
  return {
    root: projectRoot,
    delivery: join(projectRoot, "delivery"),
    releases: join(projectRoot, "delivery", "releases"),
    epics: join(projectRoot, "delivery", "epics"),
    features: join(projectRoot, "delivery", "features"),
    reviews: join(projectRoot, "delivery", "reviews"),
    summaries: join(projectRoot, "delivery", "summaries"),
    notes: join(projectRoot, "delivery", "notes"),
    docs: join(projectRoot, "docs"),
    prd: join(projectRoot, "docs", "prd"),
    architecture: join(projectRoot, "docs", "architecture"),
    decisions: join(projectRoot, "docs", "decisions"),
    floe: join(projectRoot, ".floe"),
    state: join(projectRoot, ".floe", "state"),
    memory: join(projectRoot, ".floe", "memory"),
    schemas: join(dirname(import.meta.dir), "schemas"),
  };
}

// ── JSON I/O ──────────────────────────────────────────────────────────

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeJson(path: string, data: any): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── Schema loading ────────────────────────────────────────────────────

const schemaCache = new Map<string, any>();

export function loadSchema(name: string): any {
  if (schemaCache.has(name)) return schemaCache.get(name)!;
  const schemaPath = join(paths().schemas, `${name}.json`);
  if (!existsSync(schemaPath)) throw new Error(`Schema not found: ${name}`);
  const schema = readJson(schemaPath);
  schemaCache.set(name, schema);
  return schema;
}

// ── Lightweight validation ────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateArtefact(data: any, schemaName: string): ValidationResult {
  const schema = loadSchema(schemaName);
  const errors: string[] = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (data[field] === undefined || data[field] === null) {
        errors.push(`missing required field: ${field}`);
      }
    }
  }

  // Check enum values
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
      if (data[key] !== undefined && prop.enum) {
        if (!prop.enum.includes(data[key])) {
          errors.push(`${key}: invalid value "${data[key]}", expected one of: ${prop.enum.join(", ")}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── ID generation ─────────────────────────────────────────────────────

export function generateId(prefix: string, slug: string): string {
  const clean = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return `${prefix}-${clean}`;
}

export function timestamp(): string {
  return new Date().toISOString();
}

// ── Listing helpers ───────────────────────────────────────────────────

export function listArtefacts(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(join(dir, f)));
}

export function findArtefact(dir: string, id: string): any | null {
  const filePath = join(dir, `${id}.json`);
  if (existsSync(filePath)) return readJson(filePath);
  return null;
}

// ── Output formatting ─────────────────────────────────────────────────

export function output(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}

export function ok(message: string, data?: any): void {
  output({ ok: true, message, ...data });
}

export function fail(message: string, data?: any): never {
  output({ ok: false, error: message, ...data });
  process.exit(1);
}

// ── floe-mem integration ──────────────────────────────────────────────

export function floeMemAvailable(): boolean {
  const p = paths();
  // Check for context-memory skill in any of the standard locations
  const candidates = [
    join(p.root, ".github", "skills", "context-memory", "scripts", "memory.ts"),
    join(p.root, ".agents", "skills", "context-memory", "scripts", "memory.ts"),
    join(p.root, ".claude", "skills", "context-memory", "scripts", "memory.ts"),
  ];
  return candidates.some((c) => existsSync(c));
}

export function floeMemScriptPath(): string | null {
  const p = paths();
  const candidates = [
    join(p.root, ".github", "skills", "context-memory", "scripts", "memory.ts"),
    join(p.root, ".agents", "skills", "context-memory", "scripts", "memory.ts"),
    join(p.root, ".claude", "skills", "context-memory", "scripts", "memory.ts"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}
