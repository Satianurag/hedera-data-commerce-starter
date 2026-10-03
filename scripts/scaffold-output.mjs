// The published CLI can exit successfully after its format subprocess fails.
// Treat these diagnostics as failures even if the process status is zero.
export function assertScaffoldOutput(output) {
  // oxlint-disable-next-line no-control-regex -- Strip the CLI's ANSI escape codes before checking its diagnostics.
  const plain = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  if (
    /Format step failed|Missing script:\s*["']?format\b|Dependency installation failed/i.test(plain)
  ) {
    throw new Error(
      "Scaffold installation or formatting reported a failure despite its exit status",
    );
  }
}
