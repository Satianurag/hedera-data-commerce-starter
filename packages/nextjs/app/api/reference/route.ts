import { readObject } from "../../../lib/customer-auth";
import { createReferenceSession, referenceAuth, referenceFailure, referenceJSON, referenceOverview, ReferenceIssue } from "../../../lib/reference-bridge";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try { return referenceJSON(await referenceOverview(referenceAuth(request, false))); }
  catch (error) { return referenceFailure(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const auth = referenceAuth(request, true), body = await readObject(request);
    if (body.action !== "start" || Object.keys(body).join(",") !== "action") throw new ReferenceIssue("Invalid reference request");
    return referenceJSON(await createReferenceSession(auth));
  } catch (error) { return referenceFailure(error); }
}
