import { networkConfigFromEnv } from "@neuron/hedera";
import CommerceClient from "./review";

export const dynamic = "force-dynamic";

export default function CommercePage() {
  const network = networkConfigFromEnv(process.env);
  return <CommerceClient network={network.network} />;
}
