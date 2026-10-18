// Append-only JSONL audit journal — every decision, its full trace, and every
// on-chain event the poller sees. This is the CP3 dashboard's data seed.
//
// Judge mode uses one global journal (data/journal.jsonl). Product mode gives
// every account its own journal file (data/users/<id>/journal.jsonl) with the
// exact same shape, so the policy mirror / anomaly detection / dashboard
// readers work unchanged.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, accessSync, constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "./config.js";

// Read-only-filesystem fallback (v3.9): serverless hosts (Vercel functions)
// mount the app dir read-only, so per-user journal files cannot be created.
// The journal then lives in RAM for the lifetime of the instance: decisions
// NEVER fail because of the audit layer, and the velocity window keeps
// working while the instance is warm. Long-running hosts keep real files.
const RAM = new Map(); // file path -> [entry]

/** Is the nearest EXISTING ancestor of `file`'s dir writable? Pure stat/access
 *  syscalls — never calls mkdir, so it cannot hang on exotic filesystems
 *  (procfs) and returns fast on read-only mounts (/var/task on Vercel). */
function fsUsable(file) {
  let dir = dirname(file);
  for (;;) {
    try {
      if (!statSync(dir).isDirectory()) return false;
      accessSync(dir, constants.W_OK);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") {
        const parent = dirname(dir);
        if (parent === dir) return false;
        dir = parent;
        continue;
      }
      return false; // EACCES / EPERM / anything else — treat as unusable
    }
  }
}

/** Build a journal bound to one file path. */
export function makeJournal(file) {
  // decide ONCE per journal: real files when the filesystem allows it,
  // RAM otherwise (belt: fsUsable; braces: the try/catch on every op)
  const useFiles = fsUsable(file);
  const ram = () => {
    if (!RAM.has(file)) RAM.set(file, []);
    return RAM.get(file);
  };
  return {
    file,
    append(entry) {
      if (useFiles) {
        try {
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, JSON.stringify(entry) + "\n");
          return entry;
        } catch { /* fall through to RAM */ }
      }
      ram().push(entry);
      return entry;
    },
    read(limit = 500) {
      if (useFiles) {
        try {
          if (!existsSync(file)) return [];
          const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
          return lines.slice(-limit).map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          }).filter(Boolean);
        } catch { /* fall through to RAM */ }
      }
      return ram().slice(-limit);
    },
    decisions(limit = 100) {
      return this.read(5000).filter((e) => e.type === "decision").slice(-limit).reverse();
    },
  };
}

/** Per-user audit journal (product mode). Same interface as the global one. */
export function journalFor(userId) {
  return makeJournal(resolve(config.agentRoot, "data", "users", userId, "journal.jsonl"));
}

// ── the global (judge mode) journal ─────────────────────────────────────────
const globalJournal = makeJournal(config.journalFile);

export function appendJournal(entry) {
  return globalJournal.append(entry);
}
export function readJournal(limit = 500) {
  return globalJournal.read(limit);
}
export function decisions(limit = 100) {
  return globalJournal.decisions(limit);
}
