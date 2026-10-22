import { isIP } from "node:net";

// Trusted proxy handling (#75).
//
// Forwarded headers (X-Forwarded-For and friends) are only honored when the
// direct peer is an explicitly trusted proxy. Without configuration, the
// socket address of the caller is used as-is, so a direct client cannot spoof
// the recorded client address.

/**
 * Parses the TRUSTED_PROXIES setting: a comma-separated list of IP addresses
 * or IPv4/IPv6 CIDR blocks. Invalid entries throw at config load time so a
 * typo never silently disables or broadens trust.
 */
export function parseTrustedProxies(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  for (const entry of entries) {
    // IPv6 CIDR blocks contain a colon and a slash: e.g. 2001:db8::/32.
    // We need to split on the LAST "/" only; IPv6 addresses themselves
    // contain colons but no slashes, so the last "/" is the prefix boundary.
    const slashIdx = entry.lastIndexOf("/");
    const address = slashIdx === -1 ? entry : entry.slice(0, slashIdx);
    const family = isIP(address);

    if (family === 0) {
      throw new Error(
        `TRUSTED_PROXIES entry "${entry}" is not a valid IP address or CIDR block`,
      );
    }

    if (slashIdx !== -1) {
      const prefixRaw = entry.slice(slashIdx + 1);
      const prefix = Number(prefixRaw);
      const maxPrefix = family === 6 ? 128 : 32;

      if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
        throw new Error(
          `TRUSTED_PROXIES entry "${entry}" has an invalid CIDR prefix; expected 0-${maxPrefix}`,
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
  const slashIdx = cidr.lastIndexOf("/");
  const base = cidr.slice(0, slashIdx);
  const prefix = Number(cidr.slice(slashIdx + 1));
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

/**
 * Expands an IPv6 address into a 16-element array of bytes (0-255).
 * Handles compressed notation (::) and IPv4-mapped addresses
 * (::ffff:a.b.c.d).
 */
function ipv6ToBytes(address: string): Uint8Array {
  const bytes = new Uint8Array(16);

  // Handle IPv4-mapped addresses like ::ffff:192.168.1.1
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4mapped) {
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    const v4parts = v4mapped[1].split(".").map(Number);
    bytes[12] = v4parts[0];
    bytes[13] = v4parts[1];
    bytes[14] = v4parts[2];
    bytes[15] = v4parts[3];
    return bytes;
  }

  const halves = address.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let byteIdx = 0;
  for (const group of left) {
    const val = parseInt(group, 16);
    bytes[byteIdx++] = (val >> 8) & 0xff;
    bytes[byteIdx++] = val & 0xff;
  }

  // Fill the middle gap when :: was present.
  if (halves.length === 2) {
    const rightBytes: number[] = [];
    for (const group of right) {
      const val = parseInt(group, 16);
      rightBytes.push((val >> 8) & 0xff, val & 0xff);
    }
    byteIdx = 16 - rightBytes.length;
    for (const b of rightBytes) {
      bytes[byteIdx++] = b;
    }
  }

  return bytes;
}

/** True when `address` falls inside the IPv6 CIDR block `cidr`. */
function matchesIpv6Cidr(address: string, cidr: string): boolean {
  const slashIdx = cidr.lastIndexOf("/");
  const base = cidr.slice(0, slashIdx);
  const prefix = Number(cidr.slice(slashIdx + 1));

  const addrBytes = ipv6ToBytes(address);
  const baseBytes = ipv6ToBytes(base);

  let bitsLeft = prefix;
  for (let i = 0; i < 16; i++) {
    if (bitsLeft <= 0) break;
    const bits = Math.min(bitsLeft, 8);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((addrBytes[i] & mask) !== (baseBytes[i] & mask)) return false;
    bitsLeft -= 8;
  }
  return true;
}

/**
 * Parses the RATE_LIMIT_ALLOWLIST setting: a comma-separated list of IP
 * addresses or IPv4 CIDR blocks. Shares the same validation rules as
 * TRUSTED_PROXIES so operators only need to learn one syntax.
 */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw || raw.trim() === "") return [];
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  for (const entry of entries) {
    const [address] = entry.split("/");
    if (isIP(address) === 0) {
      throw new Error(
        `RATE_LIMIT_ALLOWLIST entry "${entry}" is not a valid IP address or CIDR block`,
      );
    }
    if (entry.includes("/")) {
      if (!entry.includes(".")) {
        throw new Error(
          `RATE_LIMIT_ALLOWLIST entry "${entry}" is not a valid IPv4 CIDR block`,
        );
      }
      const prefix = Number(entry.split("/")[1]);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(
          `RATE_LIMIT_ALLOWLIST entry "${entry}" has an invalid CIDR prefix; expected 0-32`,
        );
      }
    }
  }

  return entries;
}

/**
 * True when `address` is covered by the configured rate-limit allowlist and
 * should bypass rate limiting entirely.
 */
export function isAllowlistedAddress(
  address: string,
  allowlist: readonly string[],
): boolean {
  // Re-uses the same matching logic as isTrustedProxyAddress.
  return isTrustedProxyAddress(address, allowlist);
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
  const bare = address.replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  const bareFamily = isIP(bare);

  for (const entry of trustedProxies) {
    const slashIdx = entry.lastIndexOf("/");
    if (slashIdx !== -1) {
      const entryAddress = entry.slice(0, slashIdx);
      const entryFamily = isIP(entryAddress);
      if (entryFamily === 4 && bare.includes(".") && matchesIpv4Cidr(bare, entry)) return true;
      if (entryFamily === 6 && !bare.includes(".") && matchesIpv6Cidr(bare, entry)) return true;
      continue;
    }
    // Plain IP: family must match, then exact equality.
    if (isIP(entry) !== bareFamily) continue;
    if (entry === bare) return true;
  }
  return false;
}
