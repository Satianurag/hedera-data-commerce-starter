# Mumbai testnet pilot deployment

This layout colocates the **testnet-only** Next standalone server and Go legacy gateway on one Linux x64 host. nginx terminates HTTPS/WSS using [`nginx.conf.template`](nginx.conf.template), then forwards the app to `127.0.0.1:3000` and `/stream` to `127.0.0.1:9080`. Only QUIC UDP (normally port 4001), HTTPS and certificate renewal HTTP need public ingress. On 26 September 2026 this layout was deployed to the Mumbai E2 Micro at [`https://130-210-17-107.sslip.io`](https://130-210-17-107.sslip.io). The host has **1 GB RAM**; neither sustained multi-customer capacity nor a production release has been established. Customer HCS request and commerce write switches remain off in the hosted app.

## Read-only host preflight — 26 September 2026

SSH inspection found Linux x86_64, **954 MiB total RAM**, approximately **542 MiB available**, **no swap**, and **45 GiB free disk**. Available memory is a snapshot, not a runtime capacity guarantee. Node, npm and nginx were absent from PATH; install the selected Node runtime and nginx before cutover. The proposed release/state directories were absent. The existing `neuron-testnet-gateway.service` was active under the login user, owning TCP 443 and UDP 4001; HTTPS health reported live seller bytes and no connected browser. Its app Origin still targeted local development.

The repository is private. An unauthenticated checkout from the VM failed. Prefer building from an authorized private checkout on a compatible Linux builder and transferring the complete artifact over authenticated SSH, with its revision and checksum. Keep repository credentials on the authorized builder; do not make the repository public or copy credentials into the artifact or services.

The original gateway used `GOMEMLIMIT=450MiB` and `MemoryMax=600M`. The deployed pilot templates set a smaller combined budget: Next `NODE_OPTIONS=--max-old-space-size=256` and `MemoryMax=450M`; Go `GOMEMLIMIT=150MiB` and `MemoryMax=220M`. These are process ceilings, not a capacity guarantee; a Go or Node heap limit is not total RSS. Build off-host, keep public request switches disabled, and measure both services and the operating system after each release.

The certificate was valid until 25 December 2026 and the renewal timer was active. Before cutover, renewal used Certbot's **standalone** HTTP authenticator, with a deploy hook that copied certificates and restarted Go. The completed migration below changed the authenticator and hook together. Persisted IPv4 rules admitted SSH, HTTP, HTTPS and UDP 4001, then rejected other ingress; SSH was not source-restricted. IPv6 had accepting rules but no global address. Recheck these facts before any later deployment and preserve access to the shared VCN and unrelated VM.

## Files and ownership

- Create a dedicated, non-login `neuron-testnet` user and group. Keep a release checkout at `/opt/neuron-customer-testnet/current`, readable by that user but not writable by it. Use an authorized private-repository checkout or a release artifact; do not put a GitHub token in either service environment.
- Create `/var/lib/neuron-customer-testnet` and its `bin` child owned by `neuron-testnet:neuron-testnet`, both mode `0700`. Both service units use this state directory. Put `app.env`, `gateway.env`, `buyer.der`, `operator.der`, and a shared `session-token` there with mode `0600`. The token is **32 random bytes encoded as 64 hex characters**. These files and the SQLite database and gateway journal stay outside the repository. Do not reuse a chat-disclosed or historical buyer key.
- The Go `legacy-request` and `hcs-submit` executables **must** be owned by `neuron-testnet` in that `0700` `bin` directory and be executable only by its owner (`0700`). The app rejects a binary whose immediate parent is shared, symlinked or owned by another user. Install `legacy-gateway` there as well. No service needs root or privileged-port capabilities.
- Keep nginx TLS private keys under its normal root-controlled certificate path. The gateway is plain HTTP **only on loopback**; nginx supplies public TLS. Do not set the Go `NEURON_TLS_CERT_FILE` or `NEURON_TLS_KEY_FILE` for this layout.

## Build and stage

Use a Linux x64 builder compatible with the VM's libc. A macOS `node_modules` or standalone bundle is invalid because `better-sqlite3` is native. On that Linux build host, with a compatible pinned Node runtime (20.18.3 or 22.23.3), npm and Go 1.26.8, work in a **writable private build checkout**:

```sh
npm ci --engine-strict
npm run build -w @neuron/hedera
npm run build -w @neuron/nextjs
node deploy/testnet/stage-app.mjs
cd packages/neuron-go
go build -o /tmp/neuron-legacy-gateway ./cmd/legacy-gateway
go build -o /tmp/neuron-legacy-request ./cmd/legacy-request
go build -o /tmp/neuron-hcs-submit ./cmd/hcs-submit
```

Copy the staged standalone tree to the VM's root-owned release path, preserving its relative layout, and install the three Linux binaries under `/var/lib/neuron-customer-testnet/bin` with owner `neuron-testnet` and mode `0700`. The 1 GB VM may lack memory for npm/Go compilation; use a matching Linux builder if it does. Keep build cache and temporary binaries out of the release and secret directories. `stage-app.mjs` prints the relative `server.js` layout; resolve its final absolute path **after** copying to the VM and use that in the app unit.

## Environment files

Write both environment files as root or the dedicated service user with a restrictive umask. Each assignment is one `KEY=value` line; quote values according to systemd `EnvironmentFile` syntax. Use **real testnet IDs, a current seller, your host and owner-only paths**. Keep write switches disabled until the final test and operational gates.

`gateway.env` needs:

| Variable | Value or constraint |
| --- | --- |
| `HEDERA_NETWORK` | `testnet` |
| `NEURON_SELLER_ACCOUNT_ID` | Selected current testnet seller account, verified against Mirror |
| `HEDERA_BUYER_KEY_FILE` | `/var/lib/neuron-customer-testnet/buyer.der` (ECDSA secp256k1 DER, mode `0600`) |
| `NEURON_UDP_PORT` | Publicly reachable UDP port, normally `4001` |
| `NEURON_GATEWAY_LISTEN` | `127.0.0.1:9080` |
| `NEURON_APP_ORIGIN` | Exact `https://<public-host>` origin, with no trailing slash |
| `NEURON_SESSION_TOKEN_FILE` | `/var/lib/neuron-customer-testnet/session-token` |
| `NEURON_SESSION_JOURNAL_FILE` | `/var/lib/neuron-customer-testnet/gateway-sessions.jsonl` |
| `NEURON_GATEWAY_SESSION_CHECK_URL` | `http://127.0.0.1:3000/api/gateway-session` for customer v2 tickets; the gateway fails closed without a live app check |

The current Go gateway refuses to start for a public listener or HTTPS app origin unless this private check URL is configured. In that mode it accepts only customer-bound v2 tickets; identity-free v1 tickets and the loopback static token are local test facilities. Stage the new app and route together before restarting the gateway, and retain the previous release for rollback.

`app.env` needs the same `HEDERA_NETWORK`, seller account, app origin and session-token path, plus:

| Variable | Value or constraint |
| --- | --- |
| `NEURON_ENABLE_CUSTOMER_AUTH` | `true` for the allowlisted HTTPS pilot |
| `NEURON_ALLOWED_CUSTOMER_ADDRESSES` | One to twenty comma-separated **checksummed** EVM addresses, without spaces |
| `NEURON_CUSTOMER_DB_FILE` | `/var/lib/neuron-customer-testnet/customers.sqlite` |
| `NEURON_ENABLE_REMOTE_STREAM` | `true` for the public WSS session route |
| `NEURON_GATEWAY_WS_URL` | `wss://<public-host>/stream` |
| `NEURON_GATEWAY_PUBLIC_HOST` | Exact `<public-host>` name from that URL |
| `NEURON_GATEWAY_INTERNAL_ORIGIN` | `http://127.0.0.1:9080` for server-only checks |
| `NEURON_ENABLE_CUSTOMER_REQUEST` | `false` until the final gated HCS request test; then `true` |
| `NEURON_ENABLE_PUBLIC_CUSTOMER_REQUEST` | `false` until the same gate; then `true` |
| `NEURON_PUBLIC_REQUEST_LIMIT` | Lifetime budget from `1` to `100` when public requests are enabled |
| `NEURON_SELLER_STDIN_TOPIC_ID` | Selected seller's verified testnet stdin HCS topic |
| `HEDERA_BUYER_ACCOUNT_ID`, `HEDERA_BUYER_STDIN_TOPIC_ID`, `HEDERA_SHARED_ACCOUNT_ID` | Dedicated, mutually consistent testnet buyer/reply/shared IDs |
| `HEDERA_OPERATOR_ACCOUNT_ID`, `HEDERA_OPERATOR_KEY_FILE` | Dedicated HCS operator ID and `/var/lib/neuron-customer-testnet/operator.der` |
| `HEDERA_BUYER_KEY_FILE` | Same owner-only buyer key used by the gateway |
| `NEURON_PUBLIC_UDP_MULTIADDR` | `/ip4/<public-ip>/udp/4001/quic-v1`, with the actual UDP port |
| `NEURON_LEGACY_REQUEST_BIN`, `NEURON_HCS_SUBMIT_BIN` | Absolute paths under `/var/lib/neuron-customer-testnet/bin` |
| `HEDERA_MAX_FEE_TINYBAR` | Positive per-request cap, at most 100,000,000 tinybar |

Leave `NEURON_ENABLE_CUSTOMER_COMMERCE_REVIEW`, `NEURON_ENABLE_CUSTOMER_FUNDING`, `NEURON_ENABLE_CUSTOMER_APPROVAL` and mainnet-write settings unset for the initial host cutover. After a new deployment of the current contract source, a real signed seller quote and the final test gate, commerce review also needs the selected seller and quote topic, service ID, buyer spend cap and contract ID/address described in the root README. Funding additionally needs an explicit testnet `HEDERA_RPC_URL`, exact `NEURON_ESCROW_RUNTIME_SHA256` and `NEURON_COMMERCE_MAX_TX_FEE_TINYBAR`; approval additionally needs the same owner-only session token and private `NEURON_GATEWAY_INTERNAL_ORIGIN` already listed above. These paths require separate buyer wallet confirmations and are currently unverified. The initial host cutover does **not** enable seller payment or contract checkout.

## Services and public proxy

Render [`neuron-testnet-gateway.service.template`](neuron-testnet-gateway.service.template): replace `__DEPLOY_ROOT__` with the absolute release path. Render [`neuron-testnet-app.service.template`](neuron-testnet-app.service.template): replace `__NEXT_SERVER_DIRECTORY__`, `__NEXT_SERVER_JS__` (from `stage-app.mjs`) and `__NODE_BINARY__` with absolute paths. The app unit sets `HOSTNAME=127.0.0.1`, `PORT=3000` and production mode; the gateway unit sets `NEURON_GATEWAY_LISTEN=127.0.0.1:9080`. The environment files must agree with these values. Install the rendered units in `/etc/systemd/system` without secrets in the unit text.

Set `NEURON_PUBLIC_HOST` in your shell to the **current** DNS name on the certificate, then render the public proxy from the repository root. Use the real absolute certificate paths if Certbot's layout differs:

```sh
node deploy/testnet/render-nginx.mjs \
  "$NEURON_PUBLIC_HOST" \
  "/etc/letsencrypt/live/$NEURON_PUBLIC_HOST/fullchain.pem" \
  "/etc/letsencrypt/live/$NEURON_PUBLIC_HOST/privkey.pem" \
  > /tmp/neuron-testnet.nginx.conf
```

[`render-nginx.mjs`](render-nginx.mjs) accepts exactly those three arguments and rejects malformed DNS names and certificate paths with spaces or parent traversal. Install its output in nginx's `http` context (for example a `conf.d` include), where `limit_req_zone` is valid. The config keeps `/health`, `/session-check` and `/transport-evidence` off the public proxy, forwards `/stream` with WebSocket upgrade, and limits challenge requests. It is not a substitute for the app allowlist or the host firewall. On the shared OCI VCN, do not broaden the already shared security list or disrupt the other VM; retain a host firewall that permits only required public TCP 80/443, the selected UDP port, and owner SSH access. Outbound Hedera, Mirror, Neuron directory and seller access must work.

## Coordinated listener and certificate renewal cutover

The existing gateway and proposed gateway share the unit name `neuron-testnet-gateway.service`: this is a replacement, not an additional service. The existing Go process owns public port 443, so nginx cannot bind it concurrently. Preserve the old unit, release, configuration and journal, plus Certbot's renewal configuration and deploy hook, in an owner-only rollback backup. Preserve the existing buyer identity and token deliberately when moving state; do not run two gateways against the same UDP port, identity or journal.

1. Stage the app, loopback gateway, runtime, nginx configuration and environment with customer requests and commerce disabled. Create `/var/www/letsencrypt/.well-known/acme-challenge` with permissions allowing nginx to read challenge files. Validate nginx configuration before taking over listeners. Record the current certificate name and whether the renewal timer is enabled. Coordinate with any active renewal before briefly stopping its timer for the cutover.
2. Stop the old gateway, install the replacement unit, reload systemd, then start the loopback gateway and app. Start nginx only after these listeners are ready. New gateway tickets invalidate old browser connections. Verify that ports 3000 and 9080 are loopback-only and nginx owns public 80/443.
3. Place a harmless temporary challenge file under the webroot and fetch it through public HTTP at `/.well-known/acme-challenge/`; remove it afterward. That location must serve the file without authentication or redirect. Leave all other HTTP requests redirected to HTTPS.
4. **Migrate Certbot from standalone to webroot.** Check the installed Certbot version/help; when `reconfigure` is supported, run `sudo certbot reconfigure --cert-name "$NEURON_PUBLIC_HOST" --webroot --webroot-path /var/www/letsencrypt`. This assumes the certificate name equals the hostname; use the actual name from `certbot certificates` otherwise. If `reconfigure` is unavailable, upgrade through the supported package path or follow that version's documented migration procedure before completing cutover. Do not leave standalone renewal active behind nginx or manually improvise renewal-file edits.
5. After nginx owns TLS, replace the old certificate-copy/Go-restart deploy hook with an executable root-owned hook that runs `nginx -t` and then `systemctl reload nginx`, failing on either error. Inspect the saved renewal configuration to confirm webroot authentication and the intended directory. Run `sudo certbot renew --cert-name "$NEURON_PUBLIC_HOST" --dry-run --run-deploy-hooks --no-random-sleep-on-renew` using the actual certificate name. This final deployment check must validate both challenge handling and the reload hook; then restore the renewal timer to its prior enabled/running state.
6. If any cutover check fails, stop nginx and the replacement app/gateway, restore the old gateway unit/configuration and complete release, and restore the **old renewal authenticator and deploy hook together**. Reload systemd and restart the old gateway. Ensure nginx has released both 80 and 443 so standalone HTTP renewal can bind port 80. Preserve new journal records for investigation; do not overwrite them with a stale backup. Confirm old HTTPS health and certificate renewal configuration, then restore the renewal timer.

Changing only the deploy hook is insufficient: standalone renewal would fail while nginx owns port 80. Keep renewal configuration, listener ownership and rollback as one coordinated change. These steps were executed for the pilot on 26 September 2026; the root-only rollback copies remain on the VM under `/root/neuron-pilot-rollback-20260926` and the former gateway directory was preserved.

Start order is gateway, app, then nginx. A release update should replace one complete artifact and restart the services; keep the prior artifact for rollback. Mainnet uses a separate release decision and is outside this testnet layout.

## Deployed pilot verification — 26 September 2026

- The authorized builder produced a Linux amd64 Next standalone archive, SHA-256 `41e0a60722f4a0d69ff626f0fb865fab8e71bad8d5384d707af8a482d3f1a653`. The official Node **22.23.3** Linux x64 tarball matched its published `SHASUMS256.txt` entry (`df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`). The Go 1.26.8 gateway binary SHA-256 was `992eb51c56885828b5b26fa992e5f360131ec4506f2692be9a9d6f608b80933e`. The repository was private; no anonymous clone or GitHub credential was put on the VM. These artifacts came from the current working tree before its next commit, so use their checksums when attributing this proof.
- The release lives at `/opt/neuron-customer-testnet/releases/20260926-candidate`; Node is under `/opt/neuron-node`. The app and Go gateway run as the dedicated `neuron-testnet` user. Its state, gateway transport key, HMAC token and SQLite database are in an owner-only `/var/lib/neuron-customer-testnet` directory; no HCS signing key or customer payment key is in the Next app environment. All customer request and commerce write flags are **false**. A single fresh controlled testnet buyer EVM address is allowlisted for sign-in.
- `neuron-testnet-gateway.service`, `neuron-testnet-app.service`, `nginx.service` and `certbot.timer` were enabled and active. Go owns `127.0.0.1:9080` and public UDP 4001, Next owns `127.0.0.1:3000`, and nginx owns public TCP 80/443. Public `/`, `/services`, `/sessions`, `/evidence` and `/commerce` returned **200** over valid HTTPS; public `/health`, `/session-check` and `/transport-evidence` returned **404**. Unauthenticated `/stream` and ticket requests returned **401**. `/api/customer-request` and `/api/customer-commerce` returned **404** with their write/review switches off.
- The public HTTP ACME challenge path served a probe file exactly. Certbot **2.9.0** `reconfigure` changed the renewal authenticator from standalone to webroot `/var/www/letsencrypt`; the deploy hook now validates and reloads nginx. `certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew` succeeded, then the timer was active again. The certificate still expires 25 December 2026; this is a simulated renewal, not an actual renewed certificate.
- A controlled fresh testnet buyer wallet completed the public sign-in challenge on EVM chain **296**, received a ticket and opened public WSS with HTTP **101**. One capped, **manual** testnet HCS seller request was submitted while the hosted app's request switch stayed off: [transaction `0.0.10725146@1790434525.482551989`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10725146-1790434525-482551989) and [seller stdin sequence `128011`](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.4318412/messages/128011) independently matched `SUCCESS`, payer `0.0.10725146`, **277** exact bytes and SHA-256 `f60952d2d9d06c14bfa759781564c729f7debc7d48df251f8c458c7d05093e50`. The authenticated public WSS client received **865,438 binary bytes in 2,598 messages** during a 50-second connection. The VM's fsynced gateway journal recorded one matching `opened → closed` customer session and exactly **865,438** sent bytes. No seller payment schedule was signed.
- After the live run, measured cgroup memory was approximately **145 MB Next**, **26 MB Go** and **4 MB nginx**, with approximately **480 MiB available** and no swap. This is a short single-client observation, not a load or long-term stability test. The authenticated client was a Node script, not a browser wallet UI. The host's ephemeral DNS/IP, unchanged broad shared VCN list, and 1 GB capacity remain testnet limitations. External seller-signed commerce and mainnet were not exercised.
