import { customerAuthOrigin, customerToken, getCustomerSession,
  InvalidCustomerRequest, readObject, sameOrigin } from "../../../lib/customer-auth";
import { CommerceIssue } from "../../../lib/customer-commerce";
import { attachCustomerRefundHash, customerRefundForFunding, latestCustomerRefund, openCustomerRefundWallet,
  prepareCustomerRefund,
  reconcileCustomerRefund, retryCustomerRefundWallet } from "../../../lib/customer-funding";

export const runtime = "nodejs";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authenticate(request: Request, write: boolean) {
  const origin = customerAuthOrigin();
  if (!origin) return { error: json({ error: "Testnet buyer recovery is disabled" }, 404) };
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
    const url = new URL(request.url);
    const fundingId = url.searchParams.get("fundingId");
    if ([...url.searchParams.keys()].some(key => key !== "fundingId") ||
        url.searchParams.getAll("fundingId").length > 1) {
      return json({ error: "Invalid refund history request" }, 400);
    }
    const existing = fundingId ? customerRefundForFunding(auth.session!, auth.origin!, fundingId) :
      latestCustomerRefund(auth.session!, auth.origin!);
    if (!existing) return json({ refund: null });
    try {
      return json({ refund: await reconcileCustomerRefund(auth.session!, auth.origin!, existing.id),
        reconciliation: "current" });
    } catch {
      return json({ refund: existing, reconciliation: "unavailable" });
    }
  } catch (error) {
    if (error instanceof InvalidCustomerRequest || error instanceof CommerceIssue) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Buyer refund journal is unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = authenticate(request, true);
    if ("error" in auth) return auth.error!;
    const body = await readObject(request);
    if (body.action === "prepare" && Object.keys(body).sort().join(",") === "action,fundingId" &&
        typeof body.fundingId === "string") {
      return json(await prepareCustomerRefund(auth.session!, auth.origin!, body.fundingId));
    }
    if (body.action === "openWallet" && Object.keys(body).sort().join(",") === "action,refundId" &&
        typeof body.refundId === "string") {
      return json(await openCustomerRefundWallet(auth.session!, auth.origin!, body.refundId));
    }
    if (body.action === "retryWallet" && Object.keys(body).sort().join(",") === "action,refundId" &&
        typeof body.refundId === "string") {
      return json(await retryCustomerRefundWallet(auth.session!, auth.origin!, body.refundId));
    }
    if (body.action === "attach" && Object.keys(body).sort().join(",") === "action,refundId,transactionHash" &&
        typeof body.refundId === "string" && typeof body.transactionHash === "string") {
      return json({ refund: attachCustomerRefundHash(auth.session!, auth.origin!, body.refundId, body.transactionHash) });
    }
    if (body.action === "reconcile" && Object.keys(body).sort().join(",") === "action,refundId" &&
        typeof body.refundId === "string") {
      return json({ refund: await reconcileCustomerRefund(auth.session!, auth.origin!, body.refundId) });
    }
    return json({ error: "Invalid buyer refund request" }, 400);
  } catch (error) {
    if (error instanceof InvalidCustomerRequest || error instanceof CommerceIssue) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Buyer refund preflight or reconciliation is unavailable" }, 503);
  }
}
