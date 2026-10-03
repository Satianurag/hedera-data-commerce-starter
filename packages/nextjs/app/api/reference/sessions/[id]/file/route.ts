import {
  referenceAuth,
  referenceFailure,
  referenceFile,
} from "../../../../../../lib/reference-bridge";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    return await referenceFile(referenceAuth(request, false), (await context.params).id);
  } catch (error) {
    return referenceFailure(error);
  }
}
