import { networkConfigFromEnv } from "@neuron/hedera";
import ReferenceClient from "./reference-client";

export const dynamic = "force-dynamic";
export default function ReferencePage() {
  return <ReferenceClient network={networkConfigFromEnv(process.env).network} />;
}
