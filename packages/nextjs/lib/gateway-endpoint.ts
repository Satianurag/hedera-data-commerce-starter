// The browser uses the public WSS address. On a colocated HTTPS deployment,
// server-only checks can reach the gateway's loopback listener directly.
export function gatewayServerEndpoint(publicWebSocket: URL, path: "/health" | "/session-check" | "/transport-evidence"): URL {
  const internal = process.env.NEURON_GATEWAY_INTERNAL_ORIGIN;
  if (internal) {
    const origin = new URL(internal);
    if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname) ||
        !origin.port || origin.origin !== internal || origin.pathname !== "/" || origin.search ||
        origin.hash || origin.username || origin.password) {
      throw new Error("Internal gateway origin must be exact loopback HTTP");
    }
    return new URL(path, origin);
  }
  const endpoint = new URL(publicWebSocket);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = path;
  return endpoint;
}
