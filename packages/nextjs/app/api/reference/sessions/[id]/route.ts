import { readObject } from "../../../../../lib/customer-auth";
import { getReferenceSession, referenceAction, referenceAuth, referenceFailure, referenceJSON } from "../../../../../lib/reference-bridge";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context): Promise<Response> {
  try { return referenceJSON(await getReferenceSession(referenceAuth(request, false), (await context.params).id)); }
  catch (error) { return referenceFailure(error); }
}
export async function POST(request: Request, context: Context): Promise<Response> {
  try {
    const auth = referenceAuth(request, true), { id } = await context.params;
    return referenceJSON(await referenceAction(auth, id, await readObject(request)));
  } catch (error) { return referenceFailure(error); }
}
