import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  customerAuthOrigin,
  customerToken,
  getCustomerSession,
  InvalidCustomerRequest,
  sameOrigin,
  withCustomerDatabase,
  type CustomerSession,
} from "./customer-auth";
import {
  parseReferenceConfig,
  parseReferenceSession,
  referenceId,
  referenceKind,
  type ReferenceConfig,
  type ReferenceSession,
} from "./reference-types";

type ReferenceAuth = { origin: URL; customer: CustomerSession };
export class ReferenceIssue extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function referenceJSON(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
export function referenceFailure(error: unknown): Response {
  if (error instanceof ReferenceIssue || error instanceof InvalidCustomerRequest)
    return referenceJSON({ error: error.message }, error.status);
  return referenceJSON(
    {
      error:
        "Reference service is unavailable. Refresh to reconcile any pending operation before retrying.",
    },
    503,
  );
}
export function referenceAuth(request: Request, write: boolean): ReferenceAuth {
  const origin = customerAuthOrigin();
  if (!origin || process.env.NEURON_ENABLE_REFERENCE_COMMERCE !== "true")
    throw new ReferenceIssue("Reference commerce is disabled", 404);
  if (request.headers.get("host") !== origin.host || (write && !sameOrigin(request, origin)))
    throw new ReferenceIssue("Origin rejected", 403);
  const customer = getCustomerSession(origin, customerToken(request, origin));
  if (!customer)
    throw new ReferenceIssue("Sign in with a Hedera testnet wallet to use this service", 401);
  return { origin, customer };
}
function connection(): { url: URL; token: string } {
  const value = process.env.NEURON_REFERENCE_URL;
  if (!value) throw new Error("Missing reference bridge URL");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Reference bridge must be an explicit loopback HTTP origin");
  const path = process.env.NEURON_REFERENCE_API_TOKEN_FILE;
  if (!path || !isAbsolute(path)) throw new Error("Reference token file must use an absolute path");
  const workspace = resolve(
    /* turbopackIgnore: true */ process.cwd(),
    process.cwd().endsWith("packages/nextjs") ? "../.." : ".",
  );
  const localPath = relative(workspace, resolve(path));
  if (localPath === "" || (!localPath.startsWith("..") && !isAbsolute(localPath)))
    throw new Error("Reference token must be outside the workspace");
  for (const entry of [dirname(path), path]) {
    const stat = lstatSync(entry);
    if (
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Reference token must be owner-only");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 256 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Invalid reference token file");
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error("Invalid reference token");
    return { url, token };
  } finally {
    closeSync(fd);
  }
}
async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty bridge response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maximum) {
      await reader.cancel();
      throw new Error("Oversized bridge response");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
async function bridge(
  path: string,
  auth: ReferenceAuth,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  const { url, token } = connection();
  const response = await fetch(new URL(path, url), {
    method,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(240_000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Customer-Wallet": auth.customer.ownerAddress,
      "X-Customer-Session": auth.customer.sessionId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) throw new ReferenceIssue("Reference session was not found", 404);
    if (response.status === 409)
      throw new ReferenceIssue(
        "This operation is not available in the current state. Refresh the session before retrying.",
        409,
      );
    throw new ReferenceIssue(
      "Reference service could not complete this operation. Refresh to check its outcome.",
      503,
    );
  }
  return response;
}
async function bridgeJSON(
  path: string,
  auth: ReferenceAuth,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await bridge(path, auth, method, body);
  return JSON.parse(
    new TextDecoder("utf8", { fatal: true }).decode(await boundedBytes(response, 256 * 1024)),
  ) as unknown;
}
export async function referenceConfig(auth: ReferenceAuth): Promise<ReferenceConfig> {
  return parseReferenceConfig(await bridgeJSON("/v1/config", auth));
}
type Journal = {
  id: string;
  config_json: string;
  owner_address: string;
  origin: string;
  created_at: number;
};
function journal<T>(work: Parameters<typeof withCustomerDatabase<T>>[0]): T {
  return withCustomerDatabase((db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS reference_customer_sessions (
      id TEXT PRIMARY KEY, owner_address TEXT NOT NULL, origin TEXT NOT NULL,
      config_json TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS reference_owner ON reference_customer_sessions(owner_address, origin, created_at);`);
    return work(db);
  });
}
function ownedSession(auth: ReferenceAuth, id: string): Journal {
  referenceId(id);
  const row = journal(
    (db) =>
      db
        .prepare(
          "SELECT * FROM reference_customer_sessions WHERE id = ? AND owner_address = ? AND origin = ?",
        )
        .get(id, auth.customer.ownerAddress, auth.origin.origin) as Journal | undefined,
  );
  if (!row) throw new ReferenceIssue("Reference session was not found", 404);
  return row;
}
function assertConfig(snapshot: string, current: ReferenceConfig): void {
  if (snapshot !== JSON.stringify(current))
    throw new ReferenceIssue(
      "Service configuration changed. Existing funds need recovery using the original escrow configuration.",
      409,
    );
}
export async function referenceOverview(
  auth: ReferenceAuth,
): Promise<{ config: ReferenceConfig; sessions: ReferenceSession[]; pendingSessionIds: string[] }> {
  const config = await referenceConfig(auth);
  const rows = journal(
    (db) =>
      db
        .prepare(
          "SELECT * FROM reference_customer_sessions WHERE owner_address = ? AND origin = ? ORDER BY created_at DESC LIMIT 20",
        )
        .all(auth.customer.ownerAddress, auth.origin.origin) as Journal[],
  );
  const sessions: ReferenceSession[] = [],
    pendingSessionIds: string[] = [];
  for (const row of rows) {
    try {
      assertConfig(row.config_json, config);
      sessions.push(
        parseReferenceSession(
          await bridgeJSON(`/v1/sessions/${row.id}`, auth),
          config,
          auth.customer.ownerAddress,
          row.id,
        ),
      );
    } catch {
      pendingSessionIds.push(row.id);
    }
  }
  return { config, sessions, pendingSessionIds };
}
export async function createReferenceSession(
  auth: ReferenceAuth,
): Promise<{ config: ReferenceConfig; session: ReferenceSession }> {
  const config = await referenceConfig(auth);
  const id = randomUUID();
  journal((db) =>
    db.transaction(() => {
      const recent = db
        .prepare(
          "SELECT COUNT(*) AS n FROM reference_customer_sessions WHERE owner_address = ? AND origin = ? AND created_at > ?",
        )
        .get(
          auth.customer.ownerAddress,
          auth.origin.origin,
          Math.floor(Date.now() / 1000) - 3600,
        ) as { n: number };
      if (recent.n >= 5)
        throw new ReferenceIssue(
          "The testnet pilot allows five service requests per wallet per hour",
          429,
        );
      db.prepare(
        "INSERT INTO reference_customer_sessions (id, owner_address, origin, config_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        id,
        auth.customer.ownerAddress,
        auth.origin.origin,
        JSON.stringify(config),
        Math.floor(Date.now() / 1000),
      );
    })(),
  );
  const session = parseReferenceSession(
    await bridgeJSON("/v1/sessions", auth, "POST", {
      buyerAddress: auth.customer.ownerAddress,
      customerSessionId: auth.customer.sessionId,
      requestId: id,
    }),
    config,
    auth.customer.ownerAddress,
    id,
  );
  return { config, session };
}
export async function getReferenceSession(
  auth: ReferenceAuth,
  id: string,
): Promise<{ config: ReferenceConfig; session: ReferenceSession }> {
  const row = ownedSession(auth, id),
    config = await referenceConfig(auth);
  assertConfig(row.config_json, config);
  return {
    config,
    session: parseReferenceSession(
      await bridgeJSON(`/v1/sessions/${id}`, auth),
      config,
      auth.customer.ownerAddress,
      id,
    ),
  };
}
export async function referenceAction(
  auth: ReferenceAuth,
  id: string,
  body: Record<string, unknown>,
): Promise<{ config: ReferenceConfig; session: ReferenceSession }> {
  const row = ownedSession(auth, id),
    config = await referenceConfig(auth);
  assertConfig(row.config_json, config);
  const keys = Object.keys(body).sort().join(",");
  if (body.action === "prepare" && keys === "action,kind") referenceKind(body.kind);
  else if (body.action === "submitted" && keys === "action,intentId,transactionHash") {
    referenceId(body.intentId);
    if (
      typeof body.transactionHash !== "string" ||
      !/^0x[a-fA-F0-9]{64}$/.test(body.transactionHash)
    )
      throw new ReferenceIssue("Invalid transaction hash");
  } else if (
    ["cancel", "open-wallet", "wallet-rejected"].includes(body.action as string) &&
    keys === "action,intentId"
  )
    referenceId(body.intentId);
  else if (!["refresh", "deliver", "settle"].includes(body.action as string) || keys !== "action")
    throw new ReferenceIssue("Invalid reference action");
  return {
    config,
    session: parseReferenceSession(
      await bridgeJSON(`/v1/sessions/${id}/actions`, auth, "POST", body),
      config,
      auth.customer.ownerAddress,
      id,
    ),
  };
}
export async function referenceFile(auth: ReferenceAuth, id: string): Promise<Response> {
  const { session } = await getReferenceSession(auth, id);
  if (!session.delivery)
    throw new ReferenceIssue("No verified file has been delivered for this session", 409);
  const response = await bridge(`/v1/sessions/${id}/file`, auth);
  const bytes = await boundedBytes(response, session.delivery.bytes);
  if (
    bytes.length !== session.delivery.bytes ||
    createHash("sha256").update(bytes).digest("hex") !==
      session.delivery.sha256.replace(/^0x/, "").toLowerCase()
  )
    throw new Error("Delivered file digest mismatch");
  const filename =
    session.delivery.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "delivery.bin";
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
