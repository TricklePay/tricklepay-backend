import { StrKey } from "@stellar/stellar-sdk";

// Stellar addresses are canonical uppercase base32 strkeys, but callers
// sometimes send lowercase or whitespace-padded spellings. Normalize those
// before matching so every rendering of one address filters identically, and
// reject values that are neither a valid account nor a valid contract
// address — including muxed (`M...`) addresses, which the stream contract
// never accepts as a sender, recipient, or token issuer.
// Returns null when the input cannot be normalized safely.
export function normalizeAddress(raw: string): string | null {
  const candidate = raw.trim().toUpperCase();
  if (StrKey.isValidEd25519PublicKey(candidate) || StrKey.isValidContract(candidate)) {
    return candidate;
  }
  return null;
}
