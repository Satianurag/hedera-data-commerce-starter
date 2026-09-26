import { assertHederaId, assertNetworkConfig, type NetworkConfig } from "./network.js";

type MirrorAccount = {
  account: string;
  deleted: boolean;
  key: { _type: string; key: string } | null;
};

type MirrorTopic = {
  topic_id: string;
  deleted: boolean;
  submit_key: unknown;
};

export async function mirrorJson(config: NetworkConfig, path: string): Promise<unknown> {
  assertNetworkConfig(config);
  const url = new URL(path, `${config.mirrorBaseUrl}/`);
  if (url.origin !== config.mirrorBaseUrl || !url.pathname.startsWith("/api/v1/")) {
    throw new Error("Mirror path escaped the approved provider");
  }
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Mirror ${response.status} for ${path} on ${config.network}`);
  }
  return response.json();
}

export async function getMirrorAccount(config: NetworkConfig, accountId: string): Promise<MirrorAccount> {
  assertHederaId(accountId, "accountId");
  const data = await mirrorJson(config, `/api/v1/accounts/${accountId}`) as Partial<MirrorAccount>;
  if (data.account !== accountId || data.deleted !== false || !data.key ||
      typeof data.key._type !== "string" || typeof data.key.key !== "string") {
    throw new Error(`Mirror account ${accountId} is missing, deleted or malformed on ${config.network}`);
  }
  return data as MirrorAccount;
}

export async function getMirrorTopic(config: NetworkConfig, topicId: string): Promise<MirrorTopic> {
  assertHederaId(topicId, "topicId");
  const data = await mirrorJson(config, `/api/v1/topics/${topicId}`) as Partial<MirrorTopic>;
  if (data.topic_id !== topicId || data.deleted !== false || !Object.hasOwn(data, "submit_key")) {
    throw new Error(`Mirror topic ${topicId} is missing, deleted or malformed on ${config.network}`);
  }
  return data as MirrorTopic;
}
