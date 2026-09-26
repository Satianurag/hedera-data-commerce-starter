import { customerAuthOrigin, customerToken, getCustomerSession,
  InvalidCustomerRequest, readObject, sameOrigin } from "../../../lib/customer-auth";
import { CommerceIssue, customerCommerceEnabled } from "../../../lib/customer-commerce";
import { attachCustomerFundingHash, customerFundingById, customerFundingHistory, openCustomerFundingWallet,
  prepareCustomerFunding,
  reconcileCustomerFunding, resolveExpiredCustomerFunding } from "../../../lib/customer-funding";

export const runtime = "nodejs";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function newFundingEnabled(origin: URL): boolean {
  return customerCommerceEnabled(origin) && process.env.NEURON_ENABLE_CUSTOMER_FUNDING === "true" &&
    process.env.NEURON_ENABLE_CUSTOMER_APPROVAL === "true";
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
    const pageText = url.searchParams.get("page") ?? "0";
    const selectedId = url.searchParams.get("id");
    if ([...url.searchParams.keys()].some(key => key !== "page" && key !== "id") ||
        url.searchParams.getAll("page").length > 1 || url.searchParams.getAll("id").length > 1 ||
        !/^(0|[1-9]\d{0,2})$/.test(pageText)) {
      return json({ error: "Invalid funding history request" }, 400);
    }
    const page = Number(pageText);
    const history = customerFundingHistory(auth.session!, auth.origin!, page);
    const existing = selectedId ? customerFundingById(auth.session!, auth.origin!, selectedId) : history.records[0] ?? null;
    const fundingEnabled = newFundingEnabled(auth.origin!);
    if (!existing) return json({ funding: null, history, page, fundingEnabled });
    try {
      return json({ funding: await reconcileCustomerFunding(auth.session!, auth.origin!, existing.id),
        history, page, reconciliation: "current", fundingEnabled });
    } catch {
      return json({ funding: existing, history, page, reconciliation: "unavailable", fundingEnabled });
    }
  } catch (error) {
    if (error instanceof InvalidCustomerRequest || error instanceof CommerceIssue) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Funding journal is unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = authenticate(request, true);
    if ("error" in auth) return auth.error!;
    const body = await readObject(request);
    if (body.action === "prepare" && Object.keys(body).sort().join(",") === "action,quoteIntentId" &&
        typeof body.quoteIntentId === "string") {
      if (!newFundingEnabled(auth.origin!)) {
        return json({ error: "New escrow funding requires quote review, buyer approval and funding to be enabled" }, 404);
      }
      return json(await prepareCustomerFunding(auth.session!, auth.origin!, body.quoteIntentId));
    }
    if (body.action === "openWallet" && Object.keys(body).sort().join(",") === "action,fundingId" &&
        typeof body.fundingId === "string") {
      if (!newFundingEnabled(auth.origin!)) {
        return json({ error: "New escrow funding requires quote review, buyer approval and funding to be enabled" }, 404);
      }
      return json(await openCustomerFundingWallet(auth.session!, auth.origin!, body.fundingId));
    }
    if (body.action === "attach" && Object.keys(body).sort().join(",") === "action,fundingId,transactionHash" &&
        typeof body.fundingId === "string" && typeof body.transactionHash === "string") {
      return json({ funding: attachCustomerFundingHash(auth.session!, auth.origin!, body.fundingId, body.transactionHash) });
    }
    if (body.action === "reconcile" && Object.keys(body).sort().join(",") === "action,fundingId" &&
        typeof body.fundingId === "string") {
      return json({ funding: await reconcileCustomerFunding(auth.session!, auth.origin!, body.fundingId) });
    }
    if (body.action === "resolveExpired" && Object.keys(body).sort().join(",") === "action,fundingId" &&
        typeof body.fundingId === "string") {
      return json(await resolveExpiredCustomerFunding(auth.session!, auth.origin!, body.fundingId));
    }
    return json({ error: "Invalid funding request" }, 400);
  } catch (error) {
    if (error instanceof InvalidCustomerRequest || error instanceof CommerceIssue) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Escrow funding preflight or reconciliation is unavailable" }, 503);
  }
}
