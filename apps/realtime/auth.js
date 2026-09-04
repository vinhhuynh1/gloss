/**
 * WebSocket connection authentication.
 *
 * The vendored y-websocket server has a comment reading "You may check auth
 * of request here" and then does not. Without a check, anyone who can reach
 * this service can join any room name they can guess or invent, and rooms are
 * document uuids — so this is the whole access-control story for document
 * content.
 *
 * Two gates, both required:
 *   1. the Supabase JWT is valid
 *   2. that user is a member of the study space owning the document
 */
const { createRemoteJWKSet, jwtVerify } = require("jose");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";

let jwks = null;
function getJwks() {
  if (!jwks) {
    if (!SUPABASE_URL) {
      throw new Error(
        "SUPABASE_URL must be set (or SUPABASE_JWT_SECRET for legacy projects)"
      );
    }
    jwks = createRemoteJWKSet(
      new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
    );
  }
  return jwks;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => UUID_RE.test(value);

/**
 * @returns {Promise<string|null>} the user's uuid, or null if the token is
 * missing, malformed, expired, or signed by someone else.
 */
async function verifySupabaseJwt(token) {
  if (!token) return null;

  const options = { audience: "authenticated" };
  if (SUPABASE_URL) options.issuer = `${SUPABASE_URL}/auth/v1`;

  try {
    const { payload } = SUPABASE_JWT_SECRET
      ? await jwtVerify(
          token,
          new TextEncoder().encode(SUPABASE_JWT_SECRET),
          options
        )
      : await jwtVerify(token, getJwks(), options);

    return typeof payload.sub === "string" && isUuid(payload.sub)
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}

/**
 * Document access is derived from study-space membership — documents carry no
 * ACL of their own, matching apps/api/authz.py.
 */
async function userCanAccessDocument(pool, userId, documentId) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM documents d
       JOIN study_space_members m ON m.study_space_id = d.study_space_id
      WHERE d.id = $1 AND m.user_id = $2
      LIMIT 1`,
    [documentId, userId]
  );
  return rows.length > 0;
}

module.exports = { verifySupabaseJwt, userCanAccessDocument, isUuid };
