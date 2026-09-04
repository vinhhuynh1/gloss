/**
 * Document persistence, backed by documents.crdt_snapshot.
 *
 * Deliberately not y-leveldb (the YPERSISTENCE path y-websocket ships with):
 * LevelDB needs a persistent volume, which pins this service to one machine
 * and one region and makes the container stateful. The Postgres column
 * already exists, apps/api/models.py already describes it as the document's
 * stored state, and the agent worker already expects to read it there.
 *
 * Flush strategy matters more than it looks. y-websocket only calls
 * writeState when the LAST connection to a document closes (bin/utils.cjs:223),
 * so a SIGTERM during an active editing session — which is every deploy —
 * would lose everything since the session began. Hence the debounce plus the
 * shutdown flush in server.js.
 */
const Y = require("yjs");

const FLUSH_DEBOUNCE_MS = Number(process.env.FLUSH_DEBOUNCE_MS || 5000);

const pending = new Map(); // docName -> timeout

async function flush(pool, docName, ydoc) {
  const update = Buffer.from(Y.encodeStateAsUpdate(ydoc));
  await pool.query(
    "UPDATE documents SET crdt_snapshot = $1, updated_at = now() WHERE id = $2",
    [update, docName]
  );
}

function cancelPending(docName) {
  const timer = pending.get(docName);
  if (timer) {
    clearTimeout(timer);
    pending.delete(docName);
  }
}

function scheduleFlush(pool, docName, ydoc) {
  cancelPending(docName);
  const timer = setTimeout(() => {
    pending.delete(docName);
    flush(pool, docName, ydoc).catch((err) =>
      console.error(`[persistence] flush failed for ${docName}:`, err.message)
    );
  }, FLUSH_DEBOUNCE_MS);
  // Do not hold the event loop open on an idle server.
  if (timer.unref) timer.unref();
  pending.set(docName, timer);
}

function makePersistence(pool) {
  return {
    bindState: async (docName, ydoc) => {
      const { rows } = await pool.query(
        "SELECT crdt_snapshot FROM documents WHERE id = $1",
        [docName]
      );
      const stored = rows[0]?.crdt_snapshot;
      if (stored) {
        Y.applyUpdate(ydoc, new Uint8Array(stored));
      }
      ydoc.on("update", () => scheduleFlush(pool, docName, ydoc));
    },

    writeState: async (docName, ydoc) => {
      cancelPending(docName);
      await flush(pool, docName, ydoc);
    },
  };
}

/** Flush every open document. Called on SIGTERM/SIGINT before exit. */
async function flushAll(pool, docs) {
  const results = await Promise.allSettled(
    [...docs.entries()].map(([docName, ydoc]) => {
      cancelPending(docName);
      return flush(pool, docName, ydoc);
    })
  );
  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length) {
    console.error(`[persistence] ${failed.length} document(s) failed to flush`);
  }
  return results.length - failed.length;
}

module.exports = { makePersistence, flushAll };
