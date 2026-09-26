import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { customerAuthOrigin, isCustomerSessionActive } from "../../../lib/customer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hex32 = /^[0-9a-f]{32}$/;
const ownerPattern = /^0x[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const timestampPattern = /^(0|[1-9][0-9]{0,15})$/;

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function sharedToken(): Promise<Buffer> {
  const path = process.env.NEURON_SESSION_TOKEN_FILE;
  if (!path || !isAbsolute(path)) throw new Error("Gateway token path must be absolute");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 ||
      (process.getuid && parent.uid !== process.getuid())) {
    throw new Error("Gateway token directory must be owner-only");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 128 ||
        (process.getuid && info.uid !== process.getuid())) {
      throw new Error("Gateway token file must be owner-only");
    }
    const value = (await file.readFile("utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error("Gateway token must be 32 bytes of hex");
    return Buffer.from(value, "hex");
  } finally {
    await file.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  if (process.env.HEDERA_NETWORK !== "testnet" || process.env.NEURON_ENABLE_CUSTOMER_AUTH !== "true" ||
      (process.env.NEURON_ENABLE_LOCAL_STREAM !== "true" && process.env.NEURON_ENABLE_REMOTE_STREAM !== "true")) {
    return json({ error: "Gateway session verification is disabled" }, 404);
  }
  let origin: URL;
  try {
    const configured = customerAuthOrigin();
    if (!configured) throw new Error("Customer authentication is disabled");
    origin = configured;
  } catch {
    return json({ error: "Customer authentication is unavailable" }, 503);
  }

  if ((request.headers.get("content-length") ?? "0") !== "0" || request.headers.has("transfer-encoding")) {
    return json({ error: "Request body is not allowed" }, 400);
  }
  if (request.body) {
    const reader = request.body.getReader();
    const first = await reader.read();
    if (!first.done) {
      await reader.cancel();
      return json({ error: "Request body is not allowed" }, 400);
    }
  }

  const sessionId = request.headers.get("x-neuron-session-id") ?? "";
  const ownerLower = request.headers.get("x-neuron-owner") ?? "";
  const instanceId = request.headers.get("x-neuron-instance-id") ?? "";
  const timestamp = request.headers.get("x-neuron-timestamp") ?? "";
  const nonce = request.headers.get("x-neuron-nonce") ?? "";
  const auth = request.headers.get("x-neuron-auth") ?? "";
  if (!hex32.test(sessionId) || !ownerPattern.test(ownerLower) || !hex32.test(instanceId) ||
      !timestampPattern.test(timestamp) || !hex32.test(nonce) || !hex64.test(auth)) {
    return json({ error: "Gateway authentication failed" }, 401);
  }
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.now() / 1000) - seconds) > 15) {
    return json({ error: "Gateway authentication failed" }, 401);
  }
  try {
    const key = await sharedToken();
    const payload = `session-live:${instanceId}:${timestamp}:${nonce}:${sessionId}:${ownerLower}`;
    const expected = createHmac("sha256", key).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(auth, "hex"))) {
      return json({ error: "Gateway authentication failed" }, 401);
    }
    const active = isCustomerSessionActive(origin, sessionId, ownerLower);
    const proofPayload = `session-live-response:${instanceId}:${timestamp}:${nonce}:${sessionId}:${ownerLower}:${active ? "1" : "0"}`;
    const proof = createHmac("sha256", key).update(proofPayload).digest("hex");
    return json({ active, instanceId, nonce, proof });
  } catch {
    return json({ error: "Gateway session verification is unavailable" }, 503);
  }
}
