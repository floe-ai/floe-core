#!/usr/bin/env bun
/**
 * Self-contained memory service for AI coding agents.
 * Zero external dependencies — uses bun:sqlite (built-in).
 *
 * Usage (run from the skill directory — path to project root is auto-detected):
 *   bun run memory.ts save "We chose JWT for auth" --type decision --tags auth,api
 *   bun run memory.ts recall "authentication"
 *   bun run memory.ts status
 *   bun run memory.ts remember docs/architecture.md
 *   bun run memory.ts context "implement user login"
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { resolve, dirname, relative } from "path";

// ─── Configuration ─────────────────────────────────────────────────

/**
 * Resolve the project root. When installed project-locally, the script lives at:
 *   <project-root>/{.agents|.github|.claude}/skills/context-memory/scripts/memory.ts
 * Walk up from the script's directory until we find a folder that contains
 * one of those client directories as a sibling — that folder is the project root.
 * For .git repos we also accept the .git marker.
 * Falls back to process.cwd() for global installs (no client-dir siblings present).
 */
function findProjectRoot(): string {
  const CLIENT_DIRS = [".agents", ".github", ".claude"];
  let dir = import.meta.dir;
  for (let i = 0; i < 20; i++) {
    if (
      existsSync(resolve(dir, ".git")) ||
      CLIENT_DIRS.some((d) => existsSync(resolve(dir, d)))
    ) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const REPO_ROOT = findProjectRoot();
const DB_PATH = resolve(REPO_ROOT, ".ai/memory/memory.db");
const SCHEMA_VERSION = 3;

// ─── Database ──────────────────────────────────────────────────────

function openDb(dbPath: string = DB_PATH): Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

function initSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      locator TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'doc',
      digest TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      stale INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'learning',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      agent TEXT NOT NULL DEFAULT 'unknown',
      task TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      heading TEXT,
      text_content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      source_digest TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
      source_type UNINDEXED,
      source_id UNINDEXED,
      heading,
      text_content
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS relationships (
      id           TEXT PRIMARY KEY,
      src_type     TEXT NOT NULL,
      src_id       TEXT NOT NULL,
      dst_type     TEXT NOT NULL,
      dst_id       TEXT NOT NULL,
      relation     TEXT NOT NULL,
      weight       REAL NOT NULL DEFAULT 1.0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rel_src ON relationships (src_type, src_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rel_dst ON relationships (dst_type, dst_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rel_rel ON relationships (relation)`);
  db.run(
    `INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)`,
    [String(SCHEMA_VERSION)]
  );
}

// ─── Utilities ─────────────────────────────────────────────────────

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function utcNow(): string {
  return new Date().toISOString();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function estimateTokens(text: string): number {
  if (!text) return 1;
  return Math.max(1, Math.round(text.split(/\s+/).length / 0.75));
}

function autoTitle(content: string, maxLen = 80): string {
  const line = content.trim().split("\n")[0];
  if (line.length <= maxLen) return line;
  return line.slice(0, maxLen - 3) + "...";
}

// ─── Text Chunking ─────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

function chunkText(text: string): Array<{ heading: string; body: string }> {
  const lines = text.split("\n");
  const sections: Array<{ heading: string; lines: string[] }> = [
    { heading: "ROOT", lines: [] },
  ];

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      sections.push({ heading: m[2].trim(), lines: [line] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  const result: Array<{ heading: string; body: string }> = [];
  for (const { heading, lines: bodyLines } of sections) {
    const body = bodyLines.join("\n").trim();
    if (body) {
      result.push({ heading, body: body.slice(0, 12000) });
    }
  }
  return result;
}

// ─── Indexing ──────────────────────────────────────────────────────

function indexDocuments(db: Database): { documents: number; chunks: number } {
  const staleDocs = db
    .query<{ id: string; locator: string }, []>(
      "SELECT id, locator FROM documents WHERE stale = 1"
    )
    .all();

  let docCount = 0;
  let chunkCount = 0;

  for (const doc of staleDocs) {
    docCount++;
    // Remove old chunks for this document
    const oldChunks = db
      .query<{ rowid: number }, [string, string]>(
        "SELECT rowid FROM chunks WHERE source_type = 'document' AND source_id = ?"
      )
      .all(doc.id);
    for (const c of oldChunks) {
      db.run("DELETE FROM fts_chunks WHERE rowid = ?", [c.rowid]);
    }
    db.run(
      "DELETE FROM chunks WHERE source_type = 'document' AND source_id = ?",
      [doc.id]
    );

    // Read file content
    const absPath = resolve(REPO_ROOT, doc.locator);
    let text = "";
    try {
      if (existsSync(absPath)) text = readFileSync(absPath, "utf-8");
    } catch {
      /* skip unreadable files */
    }

    // Chunk and index
    const chunks = chunkText(text);
    const digest = sha256(text);
    for (const { heading, body } of chunks) {
      const chunkId = newId("chk");
      const tokenEst = estimateTokens(body);
      db.run(
        `INSERT INTO chunks (id, source_type, source_id, heading, text_content, token_estimate, source_digest, created_at)
         VALUES (?, 'document', ?, ?, ?, ?, ?, ?)`,
        [chunkId, doc.id, heading, body, tokenEst, digest, utcNow()]
      );
      // Get the rowid we just inserted
      const row = db
        .query<{ rowid: number }, [string]>(
          "SELECT rowid FROM chunks WHERE id = ?"
        )
        .get(chunkId);
      if (row) {
        db.run(
          "INSERT INTO fts_chunks (rowid, source_type, source_id, heading, text_content) VALUES (?, 'document', ?, ?, ?)",
          [row.rowid, doc.id, heading || "", body]
        );
        chunkCount++;
      }
    }

    db.run("UPDATE documents SET stale = 0, digest = ?, updated_at = ? WHERE id = ?", [
      digest,
      utcNow(),
      doc.id,
    ]);
  }

  return { documents: docCount, chunks: chunkCount };
}

function indexMemories(db: Database): { memories: number; chunks: number } {
  // Index memories that don't have chunks yet
  const allMems = db
    .query<{ id: string; type: string; title: string; content: string }, []>(
      "SELECT id, type, title, content FROM memories"
    )
    .all();

  let memCount = 0;
  let chunkCount = 0;

  for (const mem of allMems) {
    const existing = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM chunks WHERE source_type = 'memory' AND source_id = ?"
      )
      .get(mem.id);

    // Re-index if content changed
    const text = `${mem.title}\n${mem.content}`;
    const digest = sha256(text);
    const existingDigest = existing
      ? db
          .query<{ source_digest: string }, [string]>(
            "SELECT source_digest FROM chunks WHERE source_type = 'memory' AND source_id = ? LIMIT 1"
          )
          .get(mem.id)?.source_digest
      : null;

    if (existing && existingDigest === digest) continue;

    memCount++;

    // Remove old chunks
    if (existing) {
      const oldChunks = db
        .query<{ rowid: number }, [string]>(
          "SELECT rowid FROM chunks WHERE source_type = 'memory' AND source_id = ?"
        )
        .all(mem.id);
      for (const c of oldChunks) {
        db.run("DELETE FROM fts_chunks WHERE rowid = ?", [c.rowid]);
      }
      db.run(
        "DELETE FROM chunks WHERE source_type = 'memory' AND source_id = ?",
        [mem.id]
      );
    }

    const chunkId = newId("chk");
    const tokenEst = estimateTokens(text);
    db.run(
      `INSERT INTO chunks (id, source_type, source_id, heading, text_content, token_estimate, source_digest, created_at)
       VALUES (?, 'memory', ?, ?, ?, ?, ?, ?)`,
      [chunkId, mem.id, mem.type, text, tokenEst, digest, utcNow()]
    );
    const row = db
      .query<{ rowid: number }, [string]>(
        "SELECT rowid FROM chunks WHERE id = ?"
      )
      .get(chunkId);
    if (row) {
      db.run(
        "INSERT INTO fts_chunks (rowid, source_type, source_id, heading, text_content) VALUES (?, 'memory', ?, ?, ?)",
        [row.rowid, mem.id, mem.type, text]
      );
      chunkCount++;
    }
  }

  return { memories: memCount, chunks: chunkCount };
}

// ─── Search ────────────────────────────────────────────────────────

interface SearchResult {
  id: string;
  type: string;
  tier: string;
  snippet: string;
  score: number;
}

function search(db: Database, query: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Tier 1: Exact match on document locator or memory ID
  const exactDocs = db
    .query<{ id: string; locator: string }, [string, string]>(
      "SELECT id, locator FROM documents WHERE id = ? OR locator LIKE ?"
    )
    .all(query, `%${query}%`);
  for (const doc of exactDocs) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    results.push({
      id: doc.id,
      type: "document",
      tier: "exact",
      snippet: doc.locator,
      score: 100,
    });
  }

  const exactMems = db
    .query<{ id: string; title: string }, [string]>(
      "SELECT id, title FROM memories WHERE id = ?"
    )
    .all(query);
  for (const mem of exactMems) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    results.push({
      id: mem.id,
      type: "memory",
      tier: "exact",
      snippet: mem.title,
      score: 95,
    });
  }

  if (results.length >= limit) return results.slice(0, limit);

  // Tier 2: FTS search
  try {
    // FTS5 treats spaces as AND — use OR for broader matching
    const ftsQuery = query.trim().split(/\s+/).join(" OR ");
    const ftsRows = db
      .query<
        { source_type: string; source_id: string; heading: string; text_content: string },
        [string]
      >(
        `SELECT source_type, source_id, heading, text_content FROM fts_chunks WHERE fts_chunks MATCH ? LIMIT 20`,
      )
      .all(ftsQuery);
    for (const row of ftsRows) {
      if (seen.has(row.source_id)) continue;
      seen.add(row.source_id);
      results.push({
        id: row.source_id,
        type: row.source_type,
        tier: "fts",
        snippet: (row.text_content || "").slice(0, 300),
        score: 50,
      });
      if (results.length >= limit) return results.slice(0, limit);
    }
  } catch {
    // FTS match can fail on malformed queries — fall through to recent
  }

  // Tier 3: Recent memories (fallback)
  if (results.length < limit) {
    const recentMems = db
      .query<{ id: string; title: string; content: string }, []>(
        "SELECT id, title, content FROM memories ORDER BY updated_at DESC LIMIT 20"
      )
      .all();
    for (const mem of recentMems) {
      if (seen.has(mem.id)) continue;
      const text = `${mem.title} ${mem.content}`.toLowerCase();
      if (text.includes(query.toLowerCase())) {
        seen.add(mem.id);
        results.push({
          id: mem.id,
          type: "memory",
          tier: "recent",
          snippet: mem.content.slice(0, 300),
          score: 30,
        });
        if (results.length >= limit) break;
      }
    }
  }

  return results.slice(0, limit);
}

// ─── File Discovery ────────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "dist", "build"]);
const SKIP_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".zip", ".pdf", ".bin", ".ico", ".woff", ".woff2", ".ttf"]);
const MAX_FILE_SIZE = 300_000;
const MAX_DISCOVER = 200;

function discoverFiles(db: Database): number {
  let count = 0;
  const root = REPO_ROOT;

  // Use glob for discovery
  const glob = new Bun.Glob("**/*");
  for (const path of glob.scanSync({ cwd: root, dot: false })) {
    if (count >= MAX_DISCOVER) break;

    // Skip unwanted directories and .ai/memory (internal storage)
    const parts = path.split("/");
    if (parts.some((p) => SKIP_DIRS.has(p))) continue;
    if (path.startsWith(".ai/memory/") || path === ".ai/memory") continue;

    const absPath = resolve(root, path);
    try {
      const stat = statSync(absPath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE) continue;
    } catch {
      continue;
    }

    // Skip binary extensions
    const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
    if (SKIP_EXTS.has(ext)) continue;

    // Register if not already registered
    const existing = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM documents WHERE locator = ?"
      )
      .get(path);
    if (!existing) {
      const now = utcNow();
      db.run(
        "INSERT INTO documents (id, locator, kind, stale, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
        [newId("doc"), path, inferKind(path), now, now]
      );
    }
    count++;
  }
  return count;
}

function inferKind(path: string): string {
  const low = path.toLowerCase();
  if (/\.(py|ts|tsx|js|jsx|go|rs|java|rb|php|c|cpp|h)$/.test(low)) return "code";
  if (low.includes("adr")) return "adr";
  if (low.includes("prd")) return "prd";
  return "doc";
}

// ─── Commands ──────────────────────────────────────────────────────

function cmdSave(db: Database, args: string[]): object {
  const content = args[0];
  if (!content) throw new Error("content is required. Usage: save <content> [--type <type>] [--tags <tags>]");

  const type = getFlag(args, "--type") || "learning";
  const tags = getFlag(args, "--tags")?.split(",").map((t) => t.trim()) || [];
  const title = getFlag(args, "--title") || autoTitle(content);
  const agent = getFlag(args, "--agent") || "unknown";
  const task = getFlag(args, "--task") || "";
  const recordId = getFlag(args, "--record-id");

  const id = recordId || newId("mem");
  const now = utcNow();

  if (recordId) {
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM memories WHERE id = ?")
      .get(recordId);
    if (existing) {
      db.run(
        "UPDATE memories SET type = ?, title = ?, content = ?, tags = ?, agent = ?, task = ?, updated_at = ? WHERE id = ?",
        [type, title, content, JSON.stringify(tags), agent, task, now, recordId]
      );
      return { saved: recordId, type, title, updated: true };
    }
  }

  db.run(
    "INSERT INTO memories (id, type, title, content, tags, agent, task, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, type, title, content, JSON.stringify(tags), agent, task, now, now]
  );

  // Index immediately
  const text = `${title}\n${content}`;
  const digest = sha256(text);
  const chunkId = newId("chk");
  const tokenEst = estimateTokens(text);
  db.run(
    `INSERT INTO chunks (id, source_type, source_id, heading, text_content, token_estimate, source_digest, created_at)
     VALUES (?, 'memory', ?, ?, ?, ?, ?, ?)`,
    [chunkId, id, type, text, tokenEst, digest, now]
  );
  const row = db
    .query<{ rowid: number }, [string]>("SELECT rowid FROM chunks WHERE id = ?")
    .get(chunkId);
  if (row) {
    db.run(
      "INSERT INTO fts_chunks (rowid, source_type, source_id, heading, text_content) VALUES (?, 'memory', ?, ?, ?)",
      [row.rowid, id, type, text]
    );
  }

  return { saved: id, type, title };
}

function cmdRecall(db: Database, args: string[]): object {
  const query = args[0];
  if (!query) throw new Error("query is required. Usage: recall <query> [--limit <n>] [--expand-links] [--link-relations <csv>] [--link-limit <n>]");

  const limit = parseInt(getFlag(args, "--limit") || "5", 10);
  const expandLinks_ = args.includes("--expand-links");
  const linkRelations = getFlag(args, "--link-relations")?.split(",").map((s) => s.trim()) ?? null;
  const linkLimit = parseInt(getFlag(args, "--link-limit") || "5", 10);

  const results = search(db, query, limit);
  if (expandLinks_) {
    const neighbours = expandLinks(db, results, linkRelations, linkLimit);
    const merged = [...results, ...neighbours].sort((a, b) => b.score - a.score);
    return { query, count: merged.length, memories: merged };
  }
  return { query, count: results.length, memories: results };
}

function cmdStatus(db: Database): object {
  const docCount =
    db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM documents").get()
      ?.c || 0;
  const memCount =
    db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM memories").get()
      ?.c || 0;
  const chunkCount =
    db.query<{ c: number }, []>("SELECT COUNT(*) as c FROM chunks").get()?.c ||
    0;

  const recent = db
    .query<
      { id: string; type: string; title: string; updated_at: string },
      []
    >("SELECT id, type, title, updated_at FROM memories ORDER BY updated_at DESC LIMIT 10")
    .all();

  return {
    documents: docCount,
    memories: memCount,
    chunks: chunkCount,
    recent: recent.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      updated: r.updated_at,
    })),
  };
}

function cmdRemember(db: Database, args: string[]): object {
  const files = args.filter((a) => !a.startsWith("--"));
  if (files.length === 0) throw new Error("at least one file path is required. Usage: remember <file> [file...]");

  const kind = getFlag(args, "--kind") || "doc";
  const registered: Array<{ file: string; doc_id: string }> = [];

  for (const filepath of files) {
    const absPath = resolve(REPO_ROOT, filepath);
    const relPath = relative(REPO_ROOT, absPath);
    const now = utcNow();

    // Read file for digest
    let text = "";
    try {
      if (existsSync(absPath)) text = readFileSync(absPath, "utf-8");
    } catch {
      /* skip */
    }
    const digest = sha256(text);
    const sizeBytes = Buffer.byteLength(text, "utf-8");

    const existing = db
      .query<{ id: string }, [string]>(
        "SELECT id FROM documents WHERE locator = ?"
      )
      .get(relPath);

    let docId: string;
    if (existing) {
      docId = existing.id;
      db.run(
        "UPDATE documents SET kind = ?, digest = ?, size_bytes = ?, stale = 1, updated_at = ? WHERE id = ?",
        [kind, digest, sizeBytes, now, docId]
      );
    } else {
      docId = newId("doc");
      db.run(
        "INSERT INTO documents (id, locator, kind, digest, size_bytes, stale, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        [docId, relPath, kind, digest, sizeBytes, now, now]
      );
    }
    registered.push({ file: relPath, doc_id: docId });
  }

  // Discover + index
  discoverFiles(db);
  const docIdx = indexDocuments(db);
  const memIdx = indexMemories(db);

  return {
    registered,
    indexed: {
      documents: docIdx.documents,
      memories: memIdx.memories,
      chunks: docIdx.chunks + memIdx.chunks,
    },
  };
}

function cmdContext(db: Database, args: string[]): object {
  const objective = args[0];
  if (!objective) throw new Error("objective is required. Usage: context <objective> [--profile <profile>] [--expand-links] [--link-relations <csv>] [--link-limit <n>]");

  const profile = getFlag(args, "--profile") || "implementer";
  const budgetStr = getFlag(args, "--token-budget");
  const budgets: Record<string, number> = {
    generic: 1800,
    implementer: 2200,
    reviewer: 2200,
    planner: 2600,
    floe: 2800,
  };
  const budget = budgetStr ? parseInt(budgetStr, 10) : budgets[profile] || 2200;
  const expandLinks_ = args.includes("--expand-links");
  const linkRelations = getFlag(args, "--link-relations")?.split(",").map((s) => s.trim()) ?? null;
  const linkLimit = parseInt(getFlag(args, "--link-limit") || "5", 10);

  // Index everything first
  discoverFiles(db);
  indexDocuments(db);
  indexMemories(db);

  // Search + optional one-hop expansion
  const directResults = search(db, objective, 40);
  const allResults = expandLinks_
    ? [...directResults, ...expandLinks(db, directResults, linkRelations, linkLimit)]
        .sort((a, b) => b.score - a.score)
    : directResults;

  // Build bundle within token budget
  let usedTokens = 0;
  const items: object[] = [];

  for (const r of allResults) {
    const est = estimateTokens(r.snippet);
    if (usedTokens + est > budget) continue;
    items.push({
      source_type: r.type,
      source_id: r.id,
      tier: r.tier,
      snippet: r.snippet,
      score: r.score,
      token_estimate: est,
    });
    usedTokens += est;
  }

  return {
    objective,
    profile,
    token_budget: budget,
    token_used: usedTokens,
    items,
  };
}

// ─── Relationships ─────────────────────────────────────────────────

function resolveEntityType(db: Database, type: string, id: string): boolean {
  if (type === "document") {
    return !!db.query<{ id: string }, [string]>("SELECT id FROM documents WHERE id = ?").get(id);
  }
  if (type === "memory") {
    return !!db.query<{ id: string }, [string]>("SELECT id FROM memories WHERE id = ?").get(id);
  }
  return false;
}

function cmdLink(db: Database, args: string[]): object {
  const [srcType, srcId, relation, dstType, dstId] = args;
  if (!srcType || !srcId || !relation || !dstType || !dstId) {
    throw new Error(
      "Usage: link <src_type> <src_id> <relation> <dst_type> <dst_id> [--weight <n>] [--meta <json>]"
    );
  }
  const weight = parseFloat(getFlag(args, "--weight") || "1.0");
  const metaRaw = getFlag(args, "--meta") || "{}";
  let metadata_json = "{}";
  try { metadata_json = JSON.stringify(JSON.parse(metaRaw)); } catch {
    throw new Error(`--meta must be valid JSON. Got: ${metaRaw}`);
  }

  if (!resolveEntityType(db, srcType, srcId)) {
    throw new Error(`Source entity not found: ${srcType} ${srcId}`);
  }
  if (!resolveEntityType(db, dstType, dstId)) {
    throw new Error(`Destination entity not found: ${dstType} ${dstId}`);
  }

  const now = utcNow();
  // Upsert — idempotent on the natural key
  const existing = db.query<{ id: string }, [string, string, string, string, string]>(
    "SELECT id FROM relationships WHERE src_type=? AND src_id=? AND relation=? AND dst_type=? AND dst_id=?"
  ).get(srcType, srcId, relation, dstType, dstId);

  if (existing) {
    db.run(
      "UPDATE relationships SET weight=?, metadata_json=?, updated_at=? WHERE id=?",
      [weight, metadata_json, now, existing.id]
    );
    return { linked: existing.id, updated: true };
  }

  const id = newId("rel");
  db.run(
    "INSERT INTO relationships (id,src_type,src_id,dst_type,dst_id,relation,weight,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [id, srcType, srcId, dstType, dstId, relation, weight, metadata_json, now, now]
  );
  return { linked: id, updated: false };
}

function cmdLinks(db: Database, args: string[]): object {
  const [type, id] = args;
  if (!type || !id) throw new Error("Usage: links <type> <id> [--direction out|in|both] [--relation <name>] [--limit <n>]");

  const direction = (getFlag(args, "--direction") || "both") as "out" | "in" | "both";
  const relation = getFlag(args, "--relation");
  const limit = parseInt(getFlag(args, "--limit") || "20", 10);

  type RelRow = { id: string; src_type: string; src_id: string; dst_type: string; dst_id: string; relation: string; weight: number; metadata_json: string };

  const rows: RelRow[] = [];
  const relFilter = relation ? " AND relation = ?" : "";

  if (direction === "out" || direction === "both") {
    const q = `SELECT * FROM relationships WHERE src_type=? AND src_id=?${relFilter} LIMIT ?`;
    const params: (string | number)[] = relation ? [type, id, relation, limit] : [type, id, limit];
    rows.push(...db.query<RelRow, (string | number)[]>(q).all(...params));
  }
  if (direction === "in" || direction === "both") {
    const q = `SELECT * FROM relationships WHERE dst_type=? AND dst_id=?${relFilter} LIMIT ?`;
    const params: (string | number)[] = relation ? [type, id, relation, limit] : [type, id, limit];
    rows.push(...db.query<RelRow, (string | number)[]>(q).all(...params));
  }

  // Deduplicate by id
  const seen = new Set<string>();
  const unique = rows.filter((r) => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });

  return {
    type, id, direction, count: unique.length,
    links: unique.map((r) => ({
      id: r.id,
      src: { type: r.src_type, id: r.src_id },
      dst: { type: r.dst_type, id: r.dst_id },
      relation: r.relation,
      weight: r.weight,
      metadata: JSON.parse(r.metadata_json),
    })),
  };
}

function cmdUnlink(db: Database, args: string[]): object {
  const [relId] = args;
  if (!relId) throw new Error("Usage: unlink <relationship_id>");

  const existing = db.query<{ id: string }, [string]>("SELECT id FROM relationships WHERE id = ?").get(relId);
  if (!existing) throw new Error(`Relationship not found: ${relId}`);

  db.run("DELETE FROM relationships WHERE id = ?", [relId]);
  return { unlinked: relId };
}

// ─── Link Expansion Scoring ────────────────────────────────────────

const HOP_DECAY = 0.30;

const RELATION_FACTORS: Record<string, number> = {
  derived_from: 1.00,
  continues:    1.00,
  depends_on:   1.00,
  blocks:       1.00,
  describes:    1.00,
  belongs_to:   0.85,
  supersedes:   0.85,
  relates_to:   0.60,
  mentions:     0.35,
};

export function getRelationFactor(relation: string): number {
  return RELATION_FACTORS[relation.toLowerCase()] ?? 0.60;
}

export function computeExpandedScore(
  sourceScore: number,
  relation: string,
  edgeWeight: number
): number {
  const weight = edgeWeight > 0 && isFinite(edgeWeight) ? edgeWeight : 1.0;
  const raw = sourceScore * HOP_DECAY * getRelationFactor(relation) * weight;
  const cap = sourceScore * 0.95;
  return Math.min(raw, cap);
}

/** Load one-hop linked neighbours for a set of primary search hits, scored relative to their source. */
function expandLinks(
  db: Database,
  hits: SearchResult[],
  linkRelations: string[] | null,
  linkLimit: number
): SearchResult[] {
  // Direct-hit keys — never re-surface a direct result as a linked neighbour
  const directKeys = new Set(hits.map((h) => `${h.type}:${h.id}`));
  const relFilter = linkRelations ? ` AND relation IN (${linkRelations.map(() => "?").join(",")})` : "";

  // Collect all candidate neighbours into a Map keyed by (type:id).
  // If the same entity is reachable from multiple source hits, keep the highest score.
  type Candidate = { id: string; type: string; relation: string; score: number };
  const best = new Map<string, Candidate>();

  function consider(entityType: string, entityId: string, relation: string, weight: number, sourceScore: number): void {
    const key = `${entityType}:${entityId}`;
    if (directKeys.has(key)) return;
    const score = computeExpandedScore(sourceScore, relation, weight);
    const existing = best.get(key);
    if (!existing || score > existing.score) {
      best.set(key, { id: entityId, type: entityType, relation, score });
    }
  }

  type NRow = { dst_type: string; dst_id: string; relation: string; weight: number };
  type NRowIn = { src_type: string; src_id: string; relation: string; weight: number };

  for (const hit of hits) {
    const params: (string | number)[] = linkRelations
      ? [hit.type, hit.id, ...linkRelations, linkLimit]
      : [hit.type, hit.id, linkLimit];

    // Outgoing edges
    const outRows = db.query<NRow, (string | number)[]>(
      `SELECT dst_type, dst_id, relation, weight FROM relationships WHERE src_type=? AND src_id=?${relFilter} LIMIT ?`
    ).all(...params);
    for (const row of outRows) {
      consider(row.dst_type, row.dst_id, row.relation, row.weight, hit.score);
    }

    // Incoming edges
    const inRows = db.query<NRowIn, (string | number)[]>(
      `SELECT src_type, src_id, relation, weight FROM relationships WHERE dst_type=? AND dst_id=?${relFilter} LIMIT ?`
    ).all(...params);
    for (const row of inRows) {
      consider(row.src_type, row.src_id, row.relation, row.weight, hit.score);
    }
  }

  // Deduplicated by (type:id), sorted by score descending, capped at linkLimit
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, linkLimit)
    .map((c) => ({
      id: c.id,
      type: c.type,
      tier: "linked" as const,
      snippet: `linked via ${c.relation}`,
      score: c.score,
    }));
}

// ─── Argument Parsing ──────────────────────────────────────────────

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ─── Main ──────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  const commandArgs = args.slice(1);

  if (!command) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "no command provided",
        usage: "bun run scripts/memory.ts <save|recall|status|remember|context|link|links|unlink> [args]",
      })
    );
    process.exit(2);
  }

  const dbPath = getFlag(args, "--db") || DB_PATH;
  const db = openDb(dbPath);

  try {
    let result: object;
    // Strip --db flag from commandArgs
    const cleanArgs = commandArgs.filter(
      (a, i) => a !== "--db" && (i === 0 || commandArgs[i - 1] !== "--db")
    );

    switch (command) {
      case "save":
        result = cmdSave(db, cleanArgs);
        break;
      case "recall":
        result = cmdRecall(db, cleanArgs);
        break;
      case "status":
        result = cmdStatus(db);
        break;
      case "remember":
        result = cmdRemember(db, cleanArgs);
        break;
      case "context":
        result = cmdContext(db, cleanArgs);
        break;
      case "link":
        result = cmdLink(db, cleanArgs);
        break;
      case "links":
        result = cmdLinks(db, cleanArgs);
        break;
      case "unlink":
        result = cmdUnlink(db, cleanArgs);
        break;
      default:
        console.log(
          JSON.stringify({
            ok: false,
            error: `unknown command '${command}'`,
            commands: ["save", "recall", "status", "remember", "context", "link", "links", "unlink"],
          })
        );
        process.exit(2);
    }

    console.log(JSON.stringify({ ok: true, result }, null, 2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      JSON.stringify({ ok: false, error: message, command }, null, 2)
    );
    process.exit(1);
  } finally {
    db.close();
  }
}

if (import.meta.main) main();
