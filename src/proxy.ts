import { isIP } from "node:net";

// Trusted proxy handling (#75).
//
// Forwarded headers (X-Forwarded-For and friends) are only honored when the
// direct peer is an explicitly trusted proxy. Without configuration, the
// socket address of the caller is used as-is, so a direct client cannot spoof
// the recorded client address.

/**
 * Parses the TRUSTED_PROXIES setting: a comma-separated list of IP addresses
 * or IPv4 CIDR blocks. Invalid entries throw at config load time so a typo
 * never silently disables or broadens trust.
 */
export function parseTrustedProxies(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  for (const entry of entries) {
    const [address] = entry.split("/");
    if (isIP(address) === 0) {
      throw new Error(
        `TRUSTED_PROXIES entry "${entry}" is not a valid IP address or CIDR block`,
      );
    }
    if (entry.includes("/")) {
      if (!entry.includes(".")) {
        throw new Error(
          `TRUSTED_PROXIES entry "${entry}" is not a valid IPv4 CIDR block`,
        );
      }
      const prefix = Number(entry.split("/")[1]);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(
          `TRUSTED_PROXIES entry "${entry}" has an invalid CIDR prefix; expected 0-32`,
        );
      }
    }
  }

  return entries;
}

function ipv4ToNumber(address: string): number {
  const parts = address.split(".");
  // Reduced to 24 bits by >>> so it stays a safe unsigned comparison.
  return (
    ((Number(parts[0]) << 24) |
      (Number(parts[1]) << 16) |
      (Number(parts[2]) << 8) |
      Number(parts[3])) >>>
    0
  );
}

/** True when `address` falls inside the IPv4 CIDR block `cidr`. */
function matchesIpv4Cidr(address: string, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

/**
 * True when `address` (the direct connection peer) is covered by the
 * configured trusted proxy list.
 */
export function isTrustedProxyAddress(
  address: string,
  trustedProxies: readonly string[],
): boolean {
  if (trustedProxies.length === 0) return false;

  // Fastify hands over addresses like "127.0.0.1"; strip any IPv6-mapped or
  // bracketed forms down to the bare address before matching.
  const bare = address.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "");

  for (const entry of trustedProxies) {
    if (entry.includes("/")) {
      if (bare.includes(".") && matchesIpv4Cidr(bare, entry)) return true;
      continue;
    }
    if (isIP(entry) !== isIP(bare)) continue;
    if (entry === bare) return true;
  }
  return false;
}
