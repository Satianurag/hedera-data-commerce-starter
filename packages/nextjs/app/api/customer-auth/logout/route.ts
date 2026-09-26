import { customerAuthOrigin, customerCookie, customerToken, revokeCustomerSession, sameOrigin } from "../../../../lib/customer-auth";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const origin = customerAuthOrigin();
    if (!origin) return Response.json({ error: "Customer sign-in is disabled" },
      { status: 404, headers: { "Cache-Control": "no-store" } });
    if (!sameOrigin(request, origin)) return Response.json({ error: "Origin rejected" },
      { status: 403, headers: { "Cache-Control": "no-store" } });
    const revoked = revokeCustomerSession(origin, customerToken(request, origin));
    return Response.json(revoked ? { signedOut: true } : { error: "No active customer session" },
      { status: revoked ? 200 : 401,
        headers: { "Cache-Control": "no-store", "Set-Cookie": customerCookie(origin, "", 0) } });
  } catch {
    return Response.json({ error: "Sign-out is unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
