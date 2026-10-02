// Test process only. Never imported by application code or the live browser run.
// A browser route cannot intercept a Server Component's fetch. Preloading this
// into the Next.js child process exercises the real server rendering/parser path.
const fixture = require("./hcs.json");
const multichunk = require("./hcs-multichunk.json");
const originalFetch = globalThis.fetch;
const json = body => Response.json(body);

globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin === "https://explorer.neuron.world") return json([]);
  if (url.origin === "https://testnet.mirrornode.hedera.com") {
    if (process.env.E2E_FORCE_MIRROR_OUTAGE === "1") throw new Error("Forced test Mirror outage");
    if (url.pathname === `/api/v1/accounts/${fixture.payer}`) {
      return json({ account: fixture.payer, deleted: false,
        key: { _type: "ECDSA_SECP256K1", key: fixture.publicKey } });
    }
    const match = url.pathname.match(/^\/api\/v1\/topics\/(0\.0\.\d+)(\/messages)?$/);
    if (!match) throw new Error(`Unconfigured Mirror fixture: ${url.pathname}`);
    const topic = match[1];
    if (topic === fixture.outageTopic) return Response.json({ error: "Fixture outage" }, { status: 503 });
    if (![fixture.topic, fixture.emptyTopic, fixture.incompleteTopic, fixture.tamperedTopic, multichunk.topic].includes(topic)) {
      throw new Error(`Unconfigured topic fixture: ${topic}`);
    }
    if (!match[2]) return json({ topic_id: topic, deleted: false, submit_key: null });
    if (topic === fixture.emptyTopic) return json({ messages: [], links: { next: null } });
    if (topic === multichunk.topic) {
      const bytes = Buffer.from(JSON.stringify(multichunk.envelope));
      const rows = [1, 2, 3].map(number => ({ topic_id: topic, payer_account_id: fixture.payer,
        sequence_number: 9 + number + (number > 1 ? 1 : 0), consensus_timestamp: `1700000001.00000000${number}`,
        message: bytes.subarray((number - 1) * 1024, number * 1024).toString("base64"),
        chunk_info: { number, total: 3, initial_transaction_id: { account_id: fixture.payer,
          transaction_valid_start: "1700000000.000000000", nonce: 0, scheduled: false } } }));
      // The newest chunk arrives on the first page. Another submission was
      // interleaved; the remaining chunks arrive on a subsequent Mirror page.
      if (!url.searchParams.has("sequencenumber")) return json({ messages: [rows[2]],
        links: { next: `/api/v1/topics/${topic}/messages?limit=25&order=desc&sequencenumber=lt:13` } });
      return json({ messages: [rows[1], { ...rows[0], sequence_number: 11, chunk_info: null,
        message: Buffer.from("interleaved unrelated message").toString("base64") }, rows[0]], links: { next: null } });
    }
    const envelope = topic === fixture.tamperedTopic ? { ...fixture.envelope, payload: "SGVsbG8h" } : fixture.envelope;
    const row = { topic_id: topic, payer_account_id: fixture.payer, sequence_number: fixture.sequence,
      consensus_timestamp: "1700000001.000000007", message: Buffer.from(JSON.stringify(envelope)).toString("base64"),
      chunk_info: topic === fixture.incompleteTopic ? { number: 2, total: 2, initial_transaction_id: {
        account_id: fixture.payer, transaction_valid_start: "1700000000.000000000", nonce: 0, scheduled: false,
      } } : null };
    return json({ messages: [row], links: { next: null } });
  }
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return originalFetch(input, init);
  throw new Error(`External network disabled in deterministic browser tests: ${url.origin}`);
};
