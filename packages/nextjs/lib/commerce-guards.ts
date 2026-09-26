import type Database from "better-sqlite3";
import type { CustomerSession } from "./customer-auth";

/** Recheck inside the transaction after awaited network preflight. */
export function currentCommerceSession(db: Database.Database, session: CustomerSession,
    origin: URL, now: number): boolean {
  if (session.expiresAt <= now) return false;
  return Boolean(db.prepare(`SELECT session_id FROM customer_sessions WHERE session_id = ?
    AND owner_address = ? AND origin = ? AND revoked_at IS NULL AND expires_at > ?`)
    .get(session.sessionId, session.ownerAddress, origin.origin, now));
}

export function assertRefundReceiptHashes(expected: string, receiptHash: unknown, mirrorHash: unknown): void {
  const matches = (value: unknown): boolean => typeof value === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() === expected.toLowerCase();
  if (!matches(receiptHash) || !matches(mirrorHash)) {
    throw new Error("Refund receipt or Mirror transaction hash mismatch");
  }
}
