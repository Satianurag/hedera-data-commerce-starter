import { customerAuthOrigin, customerCookie, InvalidCustomerChallenge, InvalidCustomerRequest, readObject, sameOrigin, verifyCustomerChallenge } from "../../../../lib/customer-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const origin = customerAuthOrigin();
    if (!origin) return Response.json({ error: "Customer sign-in is disabled" }, { status: 404 });
    if (!sameOrigin(request, origin)) return Response.json({ error: "Origin rejected" }, { status: 403 });
    const body = await readObject(request);
    if (typeof body.challengeId !== "string" || typeof body.signature !== "string" ||
        Object.keys(body).sort().join(",") !== "challengeId,signature") {
      return Response.json({ error: "Invalid sign-in request" }, { status: 400 });
    }
    const { session, token } = verifyCustomerChallenge(origin, body.challengeId, body.signature);
    return Response.json(session, { headers: { "Cache-Control": "no-store", "Set-Cookie": customerCookie(origin, token) } });
  } catch (error) {
    const status = error instanceof InvalidCustomerRequest ? error.status :
      error instanceof InvalidCustomerChallenge ? 401 : 503;
    return Response.json({ error: status === 400 ? "Invalid sign-in request" :
      status === 401 ? "Challenge expired, invalid or already used" : "Customer sign-in is unavailable" },
      { status, headers: { "Cache-Control": "no-store" } });
  }
}
