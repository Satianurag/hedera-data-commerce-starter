import { createServer } from "node:net";

export async function assertPortAvailable(port, host = "127.0.0.1") {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Scaffold gate port must be an integer from 1 to 65535");
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", (error) =>
      reject(new Error(`Scaffold gate port ${port} is unavailable: ${error.code}`)),
    );
    probe.listen({ port, host, exclusive: true }, () =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

export function watchServer(server) {
  let failure;
  server.once("error", (error) => {
    failure = error;
  });
  server.once("exit", (code, signal) => {
    failure = new Error(`Generated server exited (${signal ?? code})`);
  });
  return function assertAlive() {
    if (failure) throw failure;
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error("Generated server has exited");
  };
}
