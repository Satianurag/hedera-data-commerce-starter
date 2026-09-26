import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const config = {
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};

export default config;
