import { createHmac, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { customerAuthOrigin, customerToken, getCustomerSession } from "../../../lib/customer-auth";
import type { CustomerSession } from "../../../lib/customer-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const localEnabled = process.env.NEURON_ENABLE_LOCAL_STREAM === "true";
  const remoteEnabled = process.env.NEURON_ENABLE_REMOTE_STREAM === "true";
  if (process.env.HEDERA_NETWORK !== "testnet" || (!localEnabled && !remoteEnabled)) {
    return Response.json({ error: "Testnet stream is disabled" }, { status: 404 });
  }
  const origin = process.env.NEURON_APP_ORIGIN;
  let appOrigin: URL;
  try {
    if (!origin) throw new Error("Missing app origin");
    appOrigin = new URL(origin);
    const localOrigin = appOrigin.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(appOrigin.hostname) && Boolean(appOrigin.port);
    if (!localOrigin || appOrigin.origin !== origin ||
        appOrigin.pathname !== "/" || appOrigin.search || appOrigin.hash ||
        appOrigin.username || appOrigin.password) throw new Error("Invalid app origin");
  } catch {
    return Response.json({ error: "App origin is invalid" }, { status: 503 });
  }
  if (request.headers.get("origin") !== origin) {
    return Response.json({ error: "Origin rejected" }, { status: 403 });
  }
  // This route is a loopback-only test control. A copied Host header is not
  // authentication, but rejecting mismatched hosts catches public proxy errors.
  if (request.headers.get("host") !== appOrigin.host) {
    return Response.json({ error: "App host rejected" }, { status: 403 });
  }
  let customerSession: CustomerSession | null = null;
  if (process.env.NEURON_ENABLE_CUSTOMER_AUTH === "true") {
    try {
      const authOrigin = customerAuthOrigin();
      if (!authOrigin || authOrigin.origin !== appOrigin.origin) throw new Error("Customer auth origin mismatch");
      customerSession = getCustomerSession(authOrigin, customerToken(request, authOrigin));
      if (!customerSession) {
        return Response.json({ error: "Customer sign-in required" }, { status: 401 });
      }
    } catch {
      return Response.json({ error: "Customer sign-in is unavailable" }, { status: 503 });
    }
  }
  const sellerAccount = process.env.NEURON_SELLER_ACCOUNT_ID;
  const gatewayUrl = process.env.NEURON_GATEWAY_WS_URL;
  const tokenPath = process.env.NEURON_SESSION_TOKEN_FILE;
  if (!/^0\.0\.[1-9]\d*$/.test(sellerAccount ?? "") || !gatewayUrl || !tokenPath) {
    return Response.json({ error: "Local stream configuration is incomplete" }, { status: 503 });
  }
  let url: URL;
  try {
    url = new URL(gatewayUrl);
    const localUrl = localEnabled && url.protocol === "ws:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) && Boolean(url.port);
    const remoteUrl = remoteEnabled && url.protocol === "wss:" && !url.port &&
      Boolean(process.env.NEURON_GATEWAY_PUBLIC_HOST) &&
      url.hostname === process.env.NEURON_GATEWAY_PUBLIC_HOST;
    if ((!localUrl && !remoteUrl) || url.pathname !== "/stream" ||
        url.search || url.hash || url.username || url.password) {
      throw new Error("Invalid gateway URL");
    }
  } catch {
    return Response.json({ error: "Gateway URL is invalid" }, { status: 503 });
  }
  try {
    const info = await stat(tokenPath);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Session secret must be owner-only");
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(token)) throw new Error("Session secret is invalid");
    const healthUrl = new URL(url);
    healthUrl.protocol = url.protocol === "wss:" ? "https:" : "http:";
    healthUrl.pathname = "/health";
    const healthResponse = await fetch(healthUrl, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3_000) });
    if (!healthResponse.ok) throw new Error("Gateway is unavailable");
    const health: unknown = await healthResponse.json();
    if (!health || typeof health !== "object" ||
        (health as Record<string, unknown>).network !== "testnet" ||
        (health as Record<string, unknown>).sellerAccount !== sellerAccount ||
        typeof (health as Record<string, unknown>).instanceId !== "string" ||
        !/^[0-9a-f]{32}$/.test((health as Record<string, string>).instanceId)) {
      throw new Error("Gateway seller or network mismatch");
    }
    const expiry = Math.floor(Date.now() / 1000) + 45;
    const nonce = randomBytes(16).toString("hex");
    const ownerHex = customerSession?.ownerAddress.slice(2).toLowerCase();
    const payload = customerSession ?
      `v2:${expiry}:${nonce}:${customerSession.sessionId}:${ownerHex}:${sellerAccount}:${(health as Record<string, string>).instanceId}` :
      `v1:${expiry}:${nonce}:${sellerAccount}:${(health as Record<string, string>).instanceId}`;
    const signature = createHmac("sha256", Buffer.from(token, "hex")).update(payload).digest("hex");
    const ticket = customerSession ?
      `auth.v2.${expiry}.${nonce}.${customerSession.sessionId}.${ownerHex}.${signature}` :
      `auth.v1.${expiry}.${nonce}.${signature}`;
    return Response.json({ url: url.href, sellerAccount, ticket }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Gateway is unavailable or misconfigured" }, { status: 503 });
  }
}
