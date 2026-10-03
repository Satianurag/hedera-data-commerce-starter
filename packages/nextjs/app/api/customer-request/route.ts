import {
  customerAuthOrigin,
  customerToken,
  getCustomerSession,
  sameOrigin,
} from "../../../lib/customer-auth";
import {
  CustomerRequestConflict,
  customerRequestEnabled,
  latestCustomerRequest,
  preflightCustomerRequestDescriptor,
  startCustomerRequest,
} from "../../../lib/customer-request";

export const runtime = "nodejs";

function disabled(): Response {
  return Response.json({ error: "Testnet seller requests are disabled" }, { status: 404 });
}

function authenticate(request: Request, write: boolean) {
  const origin = customerAuthOrigin();
  if (!customerRequestEnabled(origin) || !origin) return { error: disabled() };
  if (request.headers.get("host") !== origin.host || (write && !sameOrigin(request, origin))) {
    return { error: Response.json({ error: "Origin rejected" }, { status: 403 }) };
  }
  const token = customerToken(request, origin);
  const session = getCustomerSession(origin, token);
  if (!session)
    return { error: Response.json({ error: "Customer sign-in required" }, { status: 401 }) };
  return { origin, token, session };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = authenticate(request, false);
    if ("error" in auth) return auth.error!;
    const current = latestCustomerRequest(auth.session!, auth.origin!);
    if (!current) await preflightCustomerRequestDescriptor();
    return Response.json({ request: current }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Seller request status is unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = authenticate(request, true);
    if ("error" in auth) return auth.error!;
    const reader = request.body?.getReader();
    if (reader) {
      const first = await reader.read();
      if (!first.done) {
        await reader.cancel();
        return Response.json({ error: "Request body is not accepted" }, { status: 400 });
      }
    }
    const result = await startCustomerRequest(auth.session!, auth.origin!, auth.token);
    return Response.json({ request: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof CustomerRequestConflict) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json(
      { error: "Seller request is unavailable or needs operator reconciliation" },
      { status: 503 },
    );
  }
}
