import { assertHederaId, assertNetworkConfig, type NetworkConfig } from "./network.js";

type MirrorAccount = {
  account: string;
  deleted: boolean;
  key: { _type: string; key: string } | null;
  evm_address?: string | null;
};

type MirrorTopic = {
  topic_id: string;
  deleted: boolean;
  submit_key: unknown;
  custom_fees?: { fixed_fees?: unknown[] };
};

type MirrorContract = {
  contract_id: string;
  deleted: boolean;
  evm_address: string;
};

export async function readJsonLimited(response: Response, maxBytes = 1_048_576): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("JSON response has no body");
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`JSON response exceeds ${maxBytes} bytes`);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

// Only GET reads use this policy. Share one deadline across headers, bodies and
// backoff; a large Retry-After is a refusal to retry, never permission to retry early.
export async function readOnlyJson(url: string | URL, label: string): Promise<unknown> {
  const signal = AbortSignal.timeout(10_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
      cache: "no-store",
      redirect: "error",
    });
    if (response.ok) return readJsonLimited(response);
    const error = new Error(`${label} returned HTTP ${response.status}`);
    const after = response.headers.get("retry-after");
    const delay =
      after === null
        ? 250 * 2 ** attempt + Math.floor(Math.random() * 100)
        : /^\d+$/.test(after)
          ? Number(after) * 1000
          : Date.parse(after) - Date.now();
    await response.body?.cancel();
    if (
      attempt === 2 ||
      ![429, 503].includes(response.status) ||
      !Number.isFinite(delay) ||
      delay < 0 ||
      delay > 2_000
    )
      throw error;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delay);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  throw new Error(`${label} exhausted its read attempts`);
}

export async function mirrorJson(config: NetworkConfig, path: string): Promise<unknown> {
  assertNetworkConfig(config);
  const url = new URL(path, `${config.mirrorBaseUrl}/`);
  if (url.origin !== config.mirrorBaseUrl || !url.pathname.startsWith("/api/v1/")) {
    throw new Error("Mirror path escaped the approved provider");
  }
  return readOnlyJson(url, `Mirror ${path} on ${config.network}`);
}

export async function getMirrorAccount(
  config: NetworkConfig,
  accountId: string,
): Promise<MirrorAccount> {
  assertHederaId(accountId, "accountId");
  const data = (await mirrorJson(
    config,
    `/api/v1/accounts/${accountId}`,
  )) as Partial<MirrorAccount>;
  if (
    data.account !== accountId ||
    data.deleted !== false ||
    !data.key ||
    typeof data.key._type !== "string" ||
    typeof data.key.key !== "string"
  ) {
    throw new Error(
      `Mirror account ${accountId} is missing, deleted or malformed on ${config.network}`,
    );
  }
  return data as MirrorAccount;
}

export async function getMirrorTopic(config: NetworkConfig, topicId: string): Promise<MirrorTopic> {
  assertHederaId(topicId, "topicId");
  const data = (await mirrorJson(config, `/api/v1/topics/${topicId}`)) as Partial<MirrorTopic>;
  if (data.topic_id !== topicId || data.deleted !== false || !Object.hasOwn(data, "submit_key")) {
    throw new Error(
      `Mirror topic ${topicId} is missing, deleted or malformed on ${config.network}`,
    );
  }
  return data as MirrorTopic;
}

export async function getMirrorContract(
  config: NetworkConfig,
  contractId: string,
): Promise<MirrorContract> {
  assertHederaId(contractId, "contractId");
  const data = (await mirrorJson(
    config,
    `/api/v1/contracts/${contractId}`,
  )) as Partial<MirrorContract>;
  if (
    data.contract_id !== contractId ||
    data.deleted !== false ||
    typeof data.evm_address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(data.evm_address)
  ) {
    throw new Error(
      `Mirror contract ${contractId} is missing, deleted or malformed on ${config.network}`,
    );
  }
  return data as MirrorContract;
}
