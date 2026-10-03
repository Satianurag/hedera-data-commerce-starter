# Self-hosted testnet deployment

Deploy the Next.js standalone app on a Linux x64 host with persistent storage. Add the **reference file service**, the **legacy UDP gateway**, or both only when configured. You supply the host, persistent storage, DNS name and TLS certificate.

| Process                   | Listener                                  | Public ingress                               |
| ------------------------- | ----------------------------------------- | -------------------------------------------- |
| Next.js app               | `127.0.0.1:3000`                          | HTTPS through nginx                          |
| Optional reference bridge | `127.0.0.1:8098`                          | None; authenticated app proxy only           |
| Optional legacy gateway   | `127.0.0.1:9080` plus configured UDP port | `/stream` over WSS and the selected UDP port |

The reference service runs both P2P peers on the same host. It does not require public UDP. The legacy gateway needs inbound UDP from its selected seller. Cloud and host firewalls must both permit that traffic when the legacy adapter is used. The services require outbound access to their configured Hedera and Neuron endpoints.

## Build an artifact

Use Node **22.23.3** (`.nvmrc`) and a Linux x64 builder compatible with the target host's libc. Install and run the app with the same Node major: `better-sqlite3` contains a native binary. Do not deploy macOS `node_modules` or a macOS standalone build to Linux. Build off-host if the target has limited memory.

From the repository root:

```sh
npm ci --engine-strict
npm run build -w @neuron/hedera
npm run build -w @neuron/nextjs
node deploy/testnet/stage-app.mjs
```

`stage-app.mjs` copies static/public assets into the standalone tree and prints the server path. Transfer the **whole** `packages/nextjs/.next/standalone` tree, preserving its relative layout, into a versioned release directory such as `/opt/neuron-customer-testnet/releases/<revision>`. Point `/opt/neuron-customer-testnet/current` to the chosen release. Keep releases readable by the service user and writable only by the deployer. Record revision and artifact checksum; retain the previous release for rollback.

For the optional legacy adapter, build its Linux binaries with Go **1.27.1**:

```sh
cd packages/neuron-go
go build -trimpath -o /tmp/neuron-legacy-gateway ./cmd/legacy-gateway
go build -trimpath -o /tmp/neuron-legacy-request ./cmd/legacy-request
go build -trimpath -o /tmp/neuron-hcs-submit ./cmd/hcs-submit
```

For the optional reference adapter, run `npm run reference:build` from the repository root on the compatible builder. It prints the absolute `neuron-reference` binary path and records provenance in its external cache. Keep the exact upstream revision and dependency patch set. See the [reference adapter instructions](../../packages/neuron-reference/README.md) for its upstream license boundary before distributing a built artifact.

## Files and service identity

Create a dedicated non-login `neuron-testnet` user/group. Use `/var/lib/neuron-customer-testnet` and its `bin` child, owned by that user with mode **0700**. Keep private configuration, keys and tokens outside the release checkout, mode **0600**. Never put a GitHub credential in an artifact or service environment.

Install only the needed binaries under this directory:

- `bin/legacy-gateway`, `bin/legacy-request`, `bin/hcs-submit` for the legacy adapter.
- `bin/neuron-reference` for the reference adapter.

Binaries must be owned by `neuron-testnet`, executable with mode **0700**, and have an owner-only immediate parent directory. Next validates these conditions for spawned HCS commands. Do not use symlinked binary/key files where the app requires regular files.

Keep SQLite, its WAL/SHM files, bridge journals and received documents in the state directory. Preserve them through restarts and releases. A backup must capture a consistent SQLite database and matching adapter journals; stop writes or use SQLite's backup facilities. Never clear uncertain payment records to make a retry possible.

## Configure the app

Create `/var/lib/neuron-customer-testnet/app.env` using systemd `EnvironmentFile` syntax. Start read-only:

```text
HEDERA_NETWORK=testnet
NEURON_ENABLE_CUSTOMER_AUTH=false
NEURON_ENABLE_REFERENCE_COMMERCE=false
NEURON_ENABLE_REMOTE_STREAM=false
NEURON_ENABLE_CUSTOMER_REQUEST=false
NEURON_ENABLE_PUBLIC_CUSTOMER_REQUEST=false
NEURON_ENABLE_CUSTOMER_COMMERCE_REVIEW=false
NEURON_ENABLE_CUSTOMER_FUNDING=false
NEURON_ENABLE_CUSTOMER_APPROVAL=false
```

For customer sign-in, set `NEURON_ENABLE_CUSTOMER_AUTH=true`, an exact HTTPS `NEURON_APP_ORIGIN`, a one-to-twenty-address **checksummed** `NEURON_ALLOWED_CUSTOMER_ADDRESSES` list, and `NEURON_CUSTOMER_DB_FILE=/var/lib/neuron-customer-testnet/customers.sqlite`. Use no spaces in the allowlist. Follow [configuration](../../docs/configuration.md) for the selected adapter's complete account, topic, contract and fee requirements; do not combine native-HBAR and reference ERC20 terms.

### Optional reference service

Copy [config.example.json](../../packages/neuron-reference/config.example.json) to `/var/lib/neuron-customer-testnet/reference-config.json`, fill in the operator's real testnet resources, and set all key/source paths to stable files accessible to `neuron-testnet`. Keep the permitted source file outside the replaceable release directory. Create a random bearer token of 32–128 URL-safe characters (letters, digits, `_` or `-`), such as 64 random hex characters at `/var/lib/neuron-customer-testnet/reference-api-token`. Both configuration and token require mode 0600.

The [reference unit](neuron-testnet-reference.service.template) uses those paths, keeps sessions in `/var/lib/neuron-customer-testnet/reference-sessions`, and listens only on `127.0.0.1:8098`. Install it as `neuron-testnet-reference.service`. Never expose port 8098 or proxy the bridge's `/v1` routes directly.

After its read-only preflight succeeds, add these app settings:

```text
NEURON_ENABLE_REFERENCE_COMMERCE=true
NEURON_REFERENCE_URL=http://127.0.0.1:8098
NEURON_REFERENCE_API_TOKEN_FILE=/var/lib/neuron-customer-testnet/reference-api-token
```

Run only one bridge process against a state directory. Retain its exact original configuration/source bytes for funded sessions: configuration changes require a separate reviewed migration, not replacement of existing state. The bridge has no customer payment key; every buyer transaction still requires wallet authorization.

### Optional legacy gateway

Create `/var/lib/neuron-customer-testnet/gateway.env` with the selected testnet seller, owner-only buyer key, reachable UDP address, exact HTTPS app origin, shared session-token file and journal path. For public WSS it must contain:

```text
HEDERA_NETWORK=testnet
NEURON_GATEWAY_LISTEN=127.0.0.1:9080
NEURON_GATEWAY_SESSION_CHECK_URL=http://127.0.0.1:3000/api/gateway-session
```

The shared session token is 32 random bytes encoded as 64 hex characters. Configure `NEURON_ENABLE_REMOTE_STREAM=true`, the exact public WSS URL/hostname, private `NEURON_GATEWAY_INTERNAL_ORIGIN=http://127.0.0.1:9080`, and the same origin/token on the app. The [configuration guide](../../docs/configuration.md) lists the remaining variables and optional bounded HCS request settings. Leave those request switches off until their prerequisites are configured.

The public gateway accepts customer-bound tickets and checks them against the app. Start the app before the gateway; the check fails closed while the app is unavailable. Do not configure gateway TLS in this layout: nginx terminates TLS and the gateway HTTP listener remains private.

## Install services and HTTPS

Render [neuron-testnet-app.service.template](neuron-testnet-app.service.template) by replacing `__NEXT_SERVER_DIRECTORY__`, `__NEXT_SERVER_JS__` and `__NODE_BINARY__` with the final absolute Linux paths. Install it as `neuron-testnet-app.service`. The app starts on loopback and does not force either optional adapter to run.

If using legacy streaming, render [neuron-testnet-gateway.service.template](neuron-testnet-gateway.service.template), replacing `__DEPLOY_ROOT__` with the release path, and install it as `neuron-testnet-gateway.service`. Install only the optional units you configured. All units run without root or privileged-port capabilities; root is needed only for installation.

Supply a DNS name you control and a valid certificate. Set `NEURON_PUBLIC_HOST` in your deployment shell, then render nginx configuration:

```sh
node deploy/testnet/render-nginx.mjs \
  "$NEURON_PUBLIC_HOST" \
  "/etc/letsencrypt/live/$NEURON_PUBLIC_HOST/fullchain.pem" \
  "/etc/letsencrypt/live/$NEURON_PUBLIC_HOST/privkey.pem" \
  > /tmp/neuron-testnet.nginx.conf
```

Install the result in nginx's `http` context (for example `conf.d`), validate with `nginx -t`, then reload nginx. Preserve the browser Host/Origin; auth requires an exact match. The proxy hides gateway control endpoints, supports WSS, rate-limits challenges, and allows 250 seconds for the app's bounded reference negotiation/delivery operations. Browser-facing reference routes still pass through app authentication and owner checks.

Permit public TCP 443, HTTP 80 if used for certificate renewal, the selected legacy UDP port only when needed, and restricted administrative access. Keep TCP 3000/8098/9080 private. Do not change a shared cloud firewall without considering its other hosts. Configure automatic certificate renewal, validate the renewal command, and reload nginx after renewal. Retain working listener/certificate configuration before any cutover.

The example process ceilings are Next 450 MB, legacy 220 MB and reference 300 MB, plus nginx and the operating system. Size the host for the adapters enabled and measure memory/disk under the intended load; build elsewhere if necessary.

## Release and recovery

Run the [verification checks](../../docs/verification.md) before release. After installation, confirm public HTTPS, private listener bindings and the selected adapter's read-only readiness. Test a paid checkout and deadline refund separately with explicit wallet approval. This deployment targets testnet; see [mainnet requirements](../../docs/mainnet.md) before planning a different network.

For rollback, stop affected writes, keep the current database/journals, switch only to a compatible prior release and restart the configured services. Restore saved hashes for reconciliation before creating another transaction. Rolling back code does not roll back a Hedera transaction.
