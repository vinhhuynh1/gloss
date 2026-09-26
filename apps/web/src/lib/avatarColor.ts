/** A stable colour per user id.
 *
 * The same value backs the collaborator's cursor, their presence chip and
 * their row in the share sheet, so a person is one colour everywhere. Hashed
 * rather than assigned, so it needs no storage and is identical in every
 * client without anyone agreeing on it first. */
export function colorFromUserId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 70%, 55%)`;
}
