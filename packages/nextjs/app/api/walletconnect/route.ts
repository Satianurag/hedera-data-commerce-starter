import { networkConfigFromEnv } from "@neuron/hedera";
import { customerAuthOrigin } from "../../../lib/customer-auth";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const origin = customerAuthOrigin();
    const network = networkConfigFromEnv(process.env);
    const projectId = process.env.NEURON_REOWN_PROJECT_ID;
    if (!origin || network.network !== "testnet" || network.chainId !== 296 || !projectId) {
      return Response.json({ error: "WalletConnect is disabled" }, { status: 404 });
    }
    if (!/^[0-9a-f]{32}$/i.test(projectId)) {
      throw new Error("Reown project ID must be 32 hexadecimal characters");
    }
    const requestOrigin = request.headers.get("origin");
    if (request.headers.get("host") !== origin.host ||
        (requestOrigin !== null && requestOrigin !== origin.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site") {
      return Response.json({ error: "App origin or host rejected" }, { status: 403 });
    }
    return Response.json({ projectId, origin: origin.origin, chainId: 296,
      rpcUrl: "https://testnet.hashio.io/api" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "WalletConnect configuration is unavailable" }, { status: 503 });
  }
}
