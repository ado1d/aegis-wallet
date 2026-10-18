// Append-only JSONL audit journal — every decision, its full trace, and every
// on-chain event the poller sees. This is the CP3 dashboard's data seed.
//
// Judge mode uses one global journal (data/journal.jsonl). Product mode gives
// every account its own journal file (data/users/<id>/journal.jsonl) with the
// exact same shape, so the policy mirror / anomaly detection / dashboard
// readers work unchanged.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config } from "./config.js";

/** Build a journal bound to one file path. */
export function makeJournal(file) {
  return {
    file,
    append(entry) {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(entry) + "\n");
      return entry;
    },
    read(limit = 500) {
      if (!existsSync(file)) return [];
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      return lines.slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
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
