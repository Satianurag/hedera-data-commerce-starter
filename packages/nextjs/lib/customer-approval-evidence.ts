export type Transport = {
  network?: unknown;
  sellerAccount?: unknown;
  ownerAddress?: unknown;
  customerSessionId?: unknown;
  transportEvidenceOnly?: unknown;
  closedConnections?: unknown;
  interruptedConnections?: unknown;
  openConnections?: unknown;
  totalWrittenBytes?: unknown;
  truncated?: unknown;
  connections?: unknown;
  sellerPublicKey?: unknown;
};

export type CompletedTransport = Readonly<{ bytes: number; openedAt: string; closedAt: string }>;

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// A byte count is gateway transport evidence only. It cannot prove browser
// consumption or seller data quality. No interrupted or pre-request interval qualifies.
export function selectCompletedTransport(
  record: Transport,
  buyerAddress: string,
  purchaseSessionId: string,
  seller: string,
  sellerPublicKey: string,
  afterMs: number,
  beforeMs: number,
  minimumDurationMs: number,
  preferred?: CompletedTransport,
): CompletedTransport | null {
  if (
    record.network !== "testnet" ||
    record.sellerAccount !== seller ||
    record.sellerPublicKey !== sellerPublicKey ||
    record.ownerAddress !== buyerAddress.toLowerCase() ||
    record.customerSessionId !== purchaseSessionId ||
    record.transportEvidenceOnly !== true ||
    record.truncated !== false ||
    !safeCount(record.closedConnections) ||
    !safeCount(record.interruptedConnections) ||
    !safeCount(record.openConnections) ||
    !safeCount(record.totalWrittenBytes) ||
    !Array.isArray(record.connections) ||
    record.connections.length > 32 ||
    record.connections.length !== record.closedConnections
  ) {
    throw new Error("Gateway transport evidence is incomplete or mismatched");
  }
  let sum = 0;
  let chosen: CompletedTransport | null = null;
  for (const raw of record.connections) {
    if (!raw || typeof raw !== "object")
      throw new Error("Gateway connection evidence is malformed");
    const item = raw as { openedAt?: unknown; closedAt?: unknown; writtenBytes?: unknown };
    if (
      typeof item.openedAt !== "string" ||
      typeof item.closedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(item.openedAt) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(item.closedAt) ||
      !safeCount(item.writtenBytes)
    )
      throw new Error("Gateway connection evidence is malformed");
    const opened = Date.parse(item.openedAt);
    const closed = Date.parse(item.closedAt);
    if (
      !Number.isSafeInteger(opened) ||
      !Number.isSafeInteger(closed) ||
      opened >= closed ||
      closed > Date.now() + 10_000
    )
      throw new Error("Gateway connection timestamps are invalid");
    sum += item.writtenBytes;
    if (!Number.isSafeInteger(sum)) throw new Error("Gateway byte count exceeds safe precision");
    if (
      item.writtenBytes > 0 &&
      opened >= afterMs &&
      closed <= beforeMs &&
      closed - opened >= minimumDurationMs &&
      (preferred
        ? item.openedAt === preferred.openedAt &&
          item.closedAt === preferred.closedAt &&
          item.writtenBytes === preferred.bytes
        : !chosen || closed > Date.parse(chosen.closedAt))
    ) {
      chosen = { bytes: item.writtenBytes, openedAt: item.openedAt, closedAt: item.closedAt };
    }
  }
  if (sum !== record.totalWrittenBytes)
    throw new Error("Gateway byte total does not match completed connections");
  return chosen;
}
