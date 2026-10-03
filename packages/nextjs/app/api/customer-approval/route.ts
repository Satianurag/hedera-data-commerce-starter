import {
  customerAuthOrigin,
  customerToken,
  getCustomerSession,
  InvalidCustomerRequest,
  readObject,
  sameOrigin,
} from "../../../lib/customer-auth";
import { CommerceIssue } from "../../../lib/customer-commerce";
import {
  approvalEnabled,
  approvalForFunding,
  attachCustomerApprovalHash,
  markCustomerApprovalWalletOpened,
  prepareCustomerApproval,
  reconcileCustomerApproval,
} from "../../../lib/customer-approval";

export const runtime = "nodejs";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
function authenticate(request: Request, write: boolean) {
  const origin = customerAuthOrigin();
  if (!origin) return { error: json({ error: "Testnet buyer approval is disabled" }, 404) };
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
    if (
      !fundingId ||
      [...url.searchParams.keys()].some((key) => key !== "fundingId") ||
      url.searchParams.getAll("fundingId").length !== 1
    ) {
      return json({ error: "Invalid approval history request" }, 400);
    }
    const existing = approvalForFunding(auth.session!, auth.origin!, fundingId);
    if (!existing) return json({ approval: null, approvalEnabled: approvalEnabled() });
    try {
      return json({
        approval: await reconcileCustomerApproval(auth.session!, auth.origin!, existing.id),
        approvalEnabled: approvalEnabled(),
        reconciliation: "current",
      });
    } catch {
      return json({
        approval: existing,
        approvalEnabled: approvalEnabled(),
        reconciliation: "unavailable",
      });
    }
  } catch (error) {
    if (error instanceof InvalidCustomerRequest || error instanceof CommerceIssue) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Buyer approval journal is unavailable" }, 503);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = authenticate(request, true);
    if ("error" in auth) return auth.error!;
    const body = await readObject(request);
    if (
      body.action === "prepare" &&
      Object.keys(body).sort().join(",") === "action,fundingId" &&
      typeof body.fundingId === "string"
    ) {
      return json(await prepareCustomerApproval(auth.session!, auth.origin!, body.fundingId));
    }
    if (
      body.action === "wallet-opened" &&
      Object.keys(body).sort().join(",") === "acknowledged,action,approvalId" &&
      typeof body.approvalId === "string" &&
      body.acknowledged === true
    ) {
      if (!approvalEnabled()) return json({ error: "Buyer approval is disabled" }, 404);
      return json(
        await markCustomerApprovalWalletOpened(auth.session!, auth.origin!, body.approvalId, true),
      );
    }
    if (
      body.action === "retryWallet" &&
      Object.keys(body).sort().join(",") === "acknowledged,action,approvalId" &&
      typeof body.approvalId === "string" &&
      body.acknowledged === true
    ) {
      return json(
        await markCustomerApprovalWalletOpened(
          auth.session!,
          auth.origin!,
          body.approvalId,
          true,
          true,
        ),
      );
    }
    if (
      body.action === "attach" &&
      [
        "action,approvalId,transactionHash",
        "action,approvalId,transactionHash,walletAttemptId",
      ].includes(Object.keys(body).sort().join(",")) &&
      typeof body.approvalId === "string" &&
      typeof body.transactionHash === "string" &&
      (body.walletAttemptId === undefined || typeof body.walletAttemptId === "string")
    ) {
      return json({
        approval: attachCustomerApprovalHash(
          auth.session!,
          auth.origin!,
          body.approvalId,
          body.transactionHash,
          body.walletAttemptId as string | undefined,
        ),
      });
    }
    if (
      body.action === "reconcile" &&
      Object.keys(body).sort().join(",") === "action,approvalId" &&
      typeof body.approvalId === "string"
    ) {
      return json({
        approval: await reconcileCustomerApproval(auth.session!, auth.origin!, body.approvalId),
      });
    }
    return json({ error: "Invalid buyer approval request" }, 400);
  } catch (error) {
    if (error instanceof InvalidCustomerRequest || error instanceof CommerceIssue) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Buyer approval preflight or reconciliation is unavailable" }, 503);
  }
}
