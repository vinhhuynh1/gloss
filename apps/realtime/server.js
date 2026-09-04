/**
 * Yjs WebSocket sync server.
 *
 * Kept a separate process from the FastAPI backend on purpose — the build-plan
 * doc's architecture table calls for it, and it is what lets the agent, the
 * API, and the realtime path be reasoned about (and rate-limited, and scaled)
 * independently.
 *
 * REPLICA COUNT MUST BE 1. y-websocket holds each document in this process's
 * memory with no cross-node coordination, so two replicas silently fork the
 * document into two divergent copies and the last writer wins at flush time.
 * The upgrade path when that becomes a real constraint is y-redis, Liveblocks,
 * or PartyKit.
 */
const http = require("http");

const { Pool } = require("pg");
const { WebSocketServer } = require("ws");
const { docs, setPersistence, setupWSConnection } = require("y-websocket/bin/utils");

const { isUuid, userCanAccessDocument, verifySupabaseJwt } = require("./auth");
const { flushAll, makePersistence } = require("./persistence");

const PORT = Number(process.env.PORT || 1234);
const HOST = process.env.HOST || "0.0.0.0"; // never "localhost": a container
                                            // binding loopback fails health checks

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set. Expected postgresql://user:pass@host:5432/db " +
      "(no +psycopg — this is node-postgres, not SQLAlchemy)."
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires TLS but serves a cert node does not have a root for.
  ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
});

setPersistence(makePersistence(pool));

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", documents: docs.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

function reject(socket, code, message) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://placeholder");
    const docName = url.pathname.slice(1);
    const token = url.searchParams.get("token");

    // Room names are document uuids. Reject anything else outright rather
    // than letting a client invent a room.
    if (!isUuid(docName)) return reject(socket, 400, "Bad Request");

    const userId = await verifySupabaseJwt(token);
    if (!userId) return reject(socket, 401, "Unauthorized");

    if (!(await userCanAccessDocument(pool, userId, docName))) {
      return reject(socket, 403, "Forbidden");
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // docName passed explicitly: setupWSConnection otherwise derives it
      // from req.url (bin/utils.cjs:257), which would sidestep the checks
      // above on any path shape we did not anticipate.
      setupWSConnection(ws, req, { docName });
    });
  } catch (err) {
    console.error("[upgrade] failed:", err.message);
    reject(socket, 500, "Internal Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`realtime listening on ${HOST}:${PORT}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] flushing ${docs.size} open document(s)...`);

  // Give the flush a hard ceiling — the platform will SIGKILL us regardless,
  // and a hung DB connection should not cost us the documents that can save.
  const timeout = new Promise((resolve) => setTimeout(resolve, 8000).unref?.());
  const flushed = await Promise.race([flushAll(pool, docs), timeout]);
  console.log(`[${signal}] flushed ${flushed ?? "?"} document(s), exiting`);

  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
