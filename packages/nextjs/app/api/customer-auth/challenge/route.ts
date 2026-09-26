import { customerAuthOrigin, InvalidCustomerRequest, issueCustomerChallenge, readObject, sameOrigin } from "../../../../lib/customer-auth";
import { getAddress } from "ethers";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const origin = customerAuthOrigin();
    if (!origin) return Response.json({ error: "Customer sign-in is disabled" }, { status: 404 });
    if (!sameOrigin(request, origin)) return Response.json({ error: "Origin rejected" }, { status: 403 });
    const body = await readObject(request);
    if (typeof body.address !== "string" || Object.keys(body).join(",") !== "address") {
      return Response.json({ error: "Wallet address is required" }, { status: 400 });
    }
    let address: string;
    try { address = getAddress(body.address); } catch {
      return Response.json({ error: "Wallet address is invalid" }, { status: 400 });
    }
    return Response.json(issueCustomerChallenge(origin, address), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidCustomerRequest) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Customer sign-in is unavailable" }, { status: 503 });
  }
}
