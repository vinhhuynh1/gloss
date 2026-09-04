/**
 * Manual smoke test for the realtime server's auth + persistence.
 * Not part of any suite — run it by hand against a local server:
 *
 *   node ws-smoke-test.js <ws-url> <doc-id> <valid-token> <outsider-token>
 */
const WebSocket = require("ws");

const [, , WS_URL, DOC_ID, TOKEN, OUTSIDER] = process.argv;

/** Resolve with the HTTP status the server answered the upgrade with. */
function tryConnect(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const done = (result) => {
      try {
        ws.close();
      } catch {}
      resolve(result);
    };
    ws.on("open", () => done("connected"));
    ws.on("unexpected-response", (_req, res) => done(String(res.statusCode)));
    ws.on("error", (err) => done(`error: ${err.message}`));
    setTimeout(() => done("timeout"), 5000);
  });
}

(async () => {
  console.log("no token      ->", await tryConnect(`${WS_URL}/${DOC_ID}`));
  console.log(
    "bad token     ->",
    await tryConnect(`${WS_URL}/${DOC_ID}?token=garbage`)
  );
  console.log(
    "non-uuid room ->",
    await tryConnect(`${WS_URL}/demo-document?token=${TOKEN}`)
  );
  console.log(
    "non-member    ->",
    await tryConnect(`${WS_URL}/${DOC_ID}?token=${OUTSIDER}`)
  );
  console.log(
    "member        ->",
    await tryConnect(`${WS_URL}/${DOC_ID}?token=${TOKEN}`)
  );
  process.exit(0);
})();
