// Tests IPv6 address handling in trusted proxy and rate-limit allowlist configurations.
// Covers IPv4-mapped IPv6 addresses, bracketed forms, compressed and expanded spellings,
// and rejection of unsupported syntax (IPv6 CIDR blocks in allowlist).

import { describe, expect, it } from "vitest";

import {
  parseTrustedProxies,
  isTrustedProxyAddress,
  parseAllowlist,
  isAllowlistedAddress,
} from "../../src/proxy.js";

describe("IPv6 address spellings in TRUSTED_PROXIES (#721)", () => {
  // Table-driven tests for different IPv6 address formats
  const testCases = [
    {
      description: "IPv4-mapped IPv6 address (compressed form)",
      input: "::ffff:10.0.0.5",
      expected: ["::ffff:10.0.0.5"],
    },
    {
      description: "IPv4-mapped IPv6 address (full form)",
      input: "::ffff:192.168.1.1",
      expected: ["::ffff:192.168.1.1"],
    },
    {
      description: "Compressed IPv6 address",
      input: "2001:db8::1",
      expected: ["2001:db8::1"],
    },
    {
      description: "Fully expanded IPv6 address",
      input: "2001:0db8:0000:0000:0000:0000:0000:0001",
      expected: ["2001:0db8:0000:0000:0000:0000:0000:0001"],
    },
    {
      description: "Loopback IPv6 address (compressed)",
      input: "::1",
      expected: ["::1"],
    },
    {
      description: "Loopback IPv6 address (full)",
      input: "0000:0000:0000:0000:0000:0000:0000:0001",
      expected: ["0000:0000:0000:0000:0000:0000:0000:0001"],
    },
    {
      description: "Multiple IPv6 addresses with different spellings",
      input: "::1,2001:db8::1,::ffff:192.168.1.1",
      expected: ["::1", "2001:db8::1", "::ffff:192.168.1.1"],
    },
    {
      description: "IPv6 CIDR block (compressed)",
      input: "2001:db8::/32",
      expected: ["2001:db8::/32"],
    },
    {
      description: "IPv6 CIDR block (full)",
      input: "2001:0db8:0000:0000:0000:0000:0000:0000/32",
      expected: ["2001:0db8:0000:0000:0000:0000:0000:0000/32"],
    },
  ];

  testCases.forEach(({ description, input, expected }) => {
    it(`accepts ${description}`, () => {
      expect(parseTrustedProxies(input)).toEqual(expected);
    });
  });

  // Bracketed forms should be rejected during parsing (not valid for config)
  it("rejects bracketed IPv6 address", () => {
    expect(() => parseTrustedProxies("[2001:db8::1]")).toThrow(
      'TRUSTED_PROXIES entry "[2001:db8::1]" is not a valid IP address or CIDR block',
    );
  });

  it("rejects bracketed IPv4-mapped IPv6 address", () => {
    expect(() => parseTrustedProxies("[::ffff:10.0.0.5]")).toThrow(
      'TRUSTED_PROXIES entry "[::ffff:10.0.0.5]" is not a valid IP address or CIDR block',
    );
  });
});

describe("IPv6 address matching in isTrustedProxyAddress (#721)", () => {
  // Table-driven tests for address matching with different spellings
  const matchingCases = [
    {
      description: "IPv4-mapped IPv6 peer matches IPv4 CIDR",
      peerAddress: "::ffff:10.0.0.5",
      trustedList: ["10.0.0.0/24"],
      expected: true,
    },
    {
      description: "IPv4-mapped IPv6 peer matches exact IPv4",
      peerAddress: "::ffff:192.168.1.100",
      trustedList: ["192.168.1.100"],
      expected: true,
    },
    {
      description: "IPv4-mapped IPv6 peer does not match different IPv4",
      peerAddress: "::ffff:10.0.0.5",
      trustedList: ["192.168.1.0/24"],
      expected: false,
    },
    {
      description: "Compressed IPv6 matches exact compressed",
      peerAddress: "2001:db8::1",
      trustedList: ["2001:db8::1"],
      expected: true,
    },
    {
      description: "Compressed IPv6 matches expanded spelling of same address",
      peerAddress: "2001:db8::1",
      trustedList: ["2001:0db8:0000:0000:0000:0000:0000:0001"],
      expected: false, // Different string representation, no normalization
    },
    {
      description: "Expanded IPv6 matches compressed spelling of same address",
      peerAddress: "2001:0db8:0000:0000:0000:0000:0000:0001",
      trustedList: ["2001:db8::1"],
      expected: false, // Different string representation, no normalization
    },
    {
      description: "Compressed IPv6 matches IPv6 CIDR block",
      peerAddress: "2001:db8::1",
      trustedList: ["2001:db8::/32"],
      expected: true,
    },
    {
      description: "Compressed IPv6 does not match different CIDR block",
      peerAddress: "2001:db9::1",
      trustedList: ["2001:db8::/32"],
      expected: false,
    },
    {
      description: "Loopback ::1 matches ::1/128",
      peerAddress: "::1",
      trustedList: ["::1/128"],
      expected: true,
    },
    {
      description: "::2 does not match ::1/128",
      peerAddress: "::2",
      trustedList: ["::1/128"],
      expected: false,
    },
    {
      description: "Bracketed peer address is stripped before matching",
      peerAddress: "[2001:db8::1]",
      trustedList: ["2001:db8::1"],
      expected: true,
    },
    {
      description: "Bracketed IPv4-mapped peer is stripped and matches IPv4 CIDR",
      peerAddress: "[::ffff:10.0.0.5]",
      trustedList: ["10.0.0.0/24"],
      expected: true,
    },
  ];

  matchingCases.forEach(({ description, peerAddress, trustedList, expected }) => {
    it(description, () => {
      expect(isTrustedProxyAddress(peerAddress, trustedList)).toBe(expected);
    });
  });
});

describe("IPv6 in RATE_LIMIT_ALLOWLIST (#721)", () => {
  // Allowlist accepts exact IPv6 addresses and IPv4 CIDR blocks, but not IPv6 CIDR blocks
  const allowlistCases = [
    {
      description: "IPv4-mapped IPv6 address (compressed)",
      input: "::ffff:10.0.0.5",
      expected: ["::ffff:10.0.0.5"],
    },
    {
      description: "Compressed IPv6 address",
      input: "2001:db8::1",
      expected: ["2001:db8::1"],
    },
    {
      description: "Fully expanded IPv6 address",
      input: "2001:0db8:0000:0000:0000:0000:0000:0001",
      expected: ["2001:0db8:0000:0000:0000:0000:0000:0001"],
    },
    {
      description: "Loopback ::1",
      input: "::1",
      expected: ["::1"],
    },
    {
      description: "Multiple IPv6 addresses",
      input: "::1,2001:db8::1",
      expected: ["::1", "2001:db8::1"],
    },
    {
      description: "IPv4 CIDR block",
      input: "10.0.0.0/24",
      expected: ["10.0.0.0/24"],
    },
  ];

  allowlistCases.forEach(({ description, input, expected }) => {
    it(`accepts ${description}`, () => {
      expect(parseAllowlist(input)).toEqual(expected);
    });
  });

  // IPv6 CIDR blocks should be rejected with a clear error
  it("rejects IPv6 CIDR block with clear error message", () => {
    expect(() => parseAllowlist("2001:db8::/32")).toThrow(
      'RATE_LIMIT_ALLOWLIST entry "2001:db8::/32" is not a valid IPv4 CIDR block',
    );
  });

  it("rejects loopback IPv6 CIDR block", () => {
    expect(() => parseAllowlist("::1/128")).toThrow(
      'RATE_LIMIT_ALLOWLIST entry "::1/128" is not a valid IPv4 CIDR block',
    );
  });

  it("rejects bracketed IPv6 address", () => {
    expect(() => parseAllowlist("[2001:db8::1]")).toThrow(
      'RATE_LIMIT_ALLOWLIST entry "[2001:db8::1]" is not a valid IP address or CIDR block',
    );
  });
});

describe("IPv6 address matching in isAllowlistedAddress (#721)", () => {
  // Allowlist matching uses the same logic as trusted proxy matching
  const allowlistMatchingCases = [
    {
      description: "IPv4-mapped IPv6 peer matches IPv4 CIDR in allowlist",
      peerAddress: "::ffff:10.0.0.5",
      allowlist: ["10.0.0.0/24"],
      expected: true,
    },
    {
      description: "IPv4-mapped IPv6 peer matches exact IPv4 in allowlist",
      peerAddress: "::ffff:192.168.1.100",
      allowlist: ["192.168.1.100"],
      expected: true,
    },
    {
      description: "Compressed IPv6 matches exact IPv6 in allowlist",
      peerAddress: "2001:db8::1",
      allowlist: ["2001:db8::1"],
      expected: true,
    },
    {
      description: "IPv6 does not match different IPv6 in allowlist",
      peerAddress: "2001:db8::1",
      allowlist: ["2001:db8::2"],
      expected: false,
    },
    {
      description: "Loopback ::1 matches exact ::1 in allowlist",
      peerAddress: "::1",
      allowlist: ["::1"],
      expected: true,
    },
    {
      description: "Bracketed peer address is stripped before matching",
      peerAddress: "[2001:db8::1]",
      allowlist: ["2001:db8::1"],
      expected: true,
    },
    {
      description: "Bracketed IPv4-mapped peer matches IPv4 CIDR in allowlist",
      peerAddress: "[::ffff:10.0.0.5]",
      allowlist: ["10.0.0.0/24"],
      expected: true,
    },
  ];

  allowlistMatchingCases.forEach(({ description, peerAddress, allowlist, expected }) => {
    it(description, () => {
      expect(isAllowlistedAddress(peerAddress, allowlist)).toBe(expected);
    });
  });
});

describe("Unsupported syntax error messages (#721)", () => {
  it("provides clear error for invalid IP in TRUSTED_PROXIES", () => {
    expect(() => parseTrustedProxies("not-a-valid-ip")).toThrow(
      'TRUSTED_PROXIES entry "not-a-valid-ip" is not a valid IP address or CIDR block',
    );
  });

  it("provides clear error for invalid IPv4 CIDR prefix in TRUSTED_PROXIES", () => {
    expect(() => parseTrustedProxies("10.0.0.0/33")).toThrow(
      'TRUSTED_PROXIES entry "10.0.0.0/33" has an invalid CIDR prefix; expected 0-32',
    );
  });

  it("provides clear error for invalid IPv6 CIDR prefix in TRUSTED_PROXIES", () => {
    expect(() => parseTrustedProxies("2001:db8::/200")).toThrow(
      'TRUSTED_PROXIES entry "2001:db8::/200" has an invalid CIDR prefix; expected 0-128',
    );
  });

  it("provides clear error for invalid IP in RATE_LIMIT_ALLOWLIST", () => {
    expect(() => parseAllowlist("invalid-ip")).toThrow(
      'RATE_LIMIT_ALLOWLIST entry "invalid-ip" is not a valid IP address or CIDR block',
    );
  });

  it("provides clear error for IPv6 CIDR in RATE_LIMIT_ALLOWLIST", () => {
    expect(() => parseAllowlist("fe80::/10")).toThrow(
      'RATE_LIMIT_ALLOWLIST entry "fe80::/10" is not a valid IPv4 CIDR block',
    );
  });

  it("provides clear error for invalid IPv4 CIDR prefix in RATE_LIMIT_ALLOWLIST", () => {
    expect(() => parseAllowlist("192.168.0.0/40")).toThrow(
      'RATE_LIMIT_ALLOWLIST entry "192.168.0.0/40" has an invalid CIDR prefix; expected 0-32',
    );
  });
});
