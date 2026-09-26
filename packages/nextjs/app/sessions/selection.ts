/** Navigation intent only. Server ticket authorization remains authoritative. */
export function selectedSeller(search: string): string | null {
  const values = new URLSearchParams(search).getAll("seller");
  if (values.length === 0) return null;
  if (values.length !== 1 || !/^0\.0\.[1-9]\d{0,18}$/.test(values[0])) {
    throw new Error("Invalid seller selection. Open a seller from the service directory.");
  }
  return values[0];
}

export function assertSelectedSeller(selected: string | null, ticketSeller: string): void {
  if (!/^0\.0\.[1-9]\d{0,18}$/.test(ticketSeller)) throw new Error("Gateway seller was malformed");
  if (selected !== null && selected !== ticketSeller) {
    throw new Error("This gateway is configured for another seller.");
  }
}
