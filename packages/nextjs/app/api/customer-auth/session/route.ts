import {
  customerAuthOrigin,
  customerToken,
  getCustomerSession,
} from "../../../../lib/customer-auth";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const origin = customerAuthOrigin();
    if (!origin) return Response.json({ error: "Customer sign-in is disabled" }, { status: 404 });
    if (request.headers.get("host") !== origin.host) {
      return Response.json({ error: "App host rejected" }, { status: 403 });
    }
    const session = getCustomerSession(origin, customerToken(request, origin));
    return Response.json(session ?? { error: "Not signed in" }, {
      status: session ? 200 : 401,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "Customer session is unavailable" }, { status: 503 });
  }
}
