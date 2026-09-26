import { customerAuthOrigin, customerToken, getCustomerSession,
  InvalidCustomerRequest, readObject, sameOrigin } from "../../../lib/customer-auth";
import { acceptCustomerQuote, CommerceIssue, customerCommerceDescriptor,
  customerCommerceEnabled, inspectCustomerQuote, latestCommerceIntent } from "../../../lib/customer-commerce";

export const runtime = "nodejs";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authenticate(request: Request, write: boolean) {
  const origin = customerAuthOrigin();
  if (!origin || !customerCommerceEnabled(origin)) {
    return { error: json({ error: "Signed quote review is disabled" }, 404) };
  }
  if (request.headers.get("host") !== origin.host || (write && !sameOrigin(request, origin))) {
    return { error: json({ error: "Origin rejected" }, 403) };
  }
  const session = getCustomerSession(origin, customerToken(request, origin));
  if (!session) return { error: json({ error: "Customer sign-in required" }, 401) };
  return { origin, session };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = authenticate(request, false);
    if ("error" in auth) return auth.error!;
    return json({ seller: customerCommerceDescriptor(auth.session!),
      intent: latestCommerceIntent(auth.session!, auth.origin!) });
  } catch (error) {
    if (error instanceof CommerceIssue) return json({ error: error.message }, error.status);
    return json({ error: "Signed quote review is unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = authenticate(request, true);
    if ("error" in auth) return auth.error!;
    const body = await readObject(request);
    if (body.action === "inspect" && Object.keys(body).sort().join(",") === "action,sequenceNumber" &&
        Number.isSafeInteger(body.sequenceNumber) && (body.sequenceNumber as number) > 0) {
      return json({ intent: await inspectCustomerQuote(auth.session!, auth.origin!, body.sequenceNumber as number) });
    }
    if (body.action === "review" && Object.keys(body).sort().join(",") === "action,intentId,signature" &&
        typeof body.intentId === "string" && typeof body.signature === "string") {
      return json({ intent: await acceptCustomerQuote(auth.session!, auth.origin!, body.intentId, body.signature) });
    }
    return json({ error: "Invalid quote review request" }, 400);
  } catch (error) {
    if (error instanceof InvalidCustomerRequest || error instanceof CommerceIssue) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "No usable seller-signed quote was verified; review is unavailable" }, 503);
  }
}
