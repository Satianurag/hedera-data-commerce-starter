import { createHmac, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (process.env.HEDERA_NETWORK !== "testnet" || process.env.NEURON_ENABLE_LOCAL_STREAM !== "true") {
    return Response.json({ error: "Local testnet stream is disabled" }, { status: 404 });
  }
  const origin = process.env.NEURON_APP_ORIGIN;
  if (!origin || request.headers.get("origin") !== origin || !/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return Response.json({ error: "Origin rejected" }, { status: 403 });
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
    if (url.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
        !url.port || url.pathname !== "/stream" || url.search || url.hash || url.username || url.password) {
      throw new Error("Invalid local gateway URL");
    }
  } catch {
    return Response.json({ error: "Local gateway URL is invalid" }, { status: 503 });
  }
  try {
    const info = await stat(tokenPath);
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Session secret must be owner-only");
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(token)) throw new Error("Session secret is invalid");
    const healthUrl = new URL(url);
    healthUrl.protocol = "http:";
    healthUrl.pathname = "/health";
    const healthResponse = await fetch(healthUrl, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3_000) });
    if (!healthResponse.ok) throw new Error("Gateway is unavailable");
    const health: unknown = await healthResponse.json();
    if (!health || typeof health !== "object" ||
        (health as Record<string, unknown>).network !== "testnet" ||
        (health as Record<string, unknown>).sellerAccount !== sellerAccount) {
      throw new Error("Gateway seller or network mismatch");
    }
    const expiry = Math.floor(Date.now() / 1000) + 45;
    const nonce = randomBytes(16).toString("hex");
    const signature = createHmac("sha256", Buffer.from(token, "hex"))
      .update(`v1:${expiry}:${nonce}:${sellerAccount}`).digest("hex");
    return Response.json({ url: url.href, sellerAccount, ticket: `auth.v1.${expiry}.${nonce}.${signature}` }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Local gateway is unavailable or misconfigured" }, { status: 503 });
  }
}
