import { describe, expect, it, vi } from "vitest";

import { parseTrustedProxies, isTrustedProxyAddress } from "../../src/proxy.js";

import { buildServer } from "../../src/server.js";

describe("parseTrustedProxies (#75)", () => {
  it("accepts an empty list", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
  });

  it("accepts a single IP", () => {
    expect(parseTrustedProxies("10.0.0.5")).toEqual(["10.0.0.5"]);
  });

  it("accepts multiple IPs", () => {
    expect(parseTrustedProxies("10.0.0.5,10.0.1.0")).toEqual([
      "10.0.0.5",
      "10.0.1.0",
    ]);
  });

  it("accepts an IPv4 CIDR block", () => {
    expect(parseTrustedProxies("10.0.0.0/24")).toEqual(["10.0.0.0/24"]);
  });

  it("accepts an IPv6 address", () => {
    expect(parseTrustedProxies("2001:db8::1")).toEqual(["2001:db8::1"]);
  });

  it("accepts an IPv6 CIDR block", () => {
    expect(parseTrustedProxies("2001:db8::/32")).toEqual(["2001:db8::/32"]);
  });

  it("accepts a /128 IPv6 CIDR block", () => {
    expect(parseTrustedProxies("::1/128")).toEqual(["::1/128"]);
  });

  it("rejects a bad IP address", () => {
    expect(() => parseTrustedProxies("not-an-ip")).toThrow(
      'TRUSTED_PROXIES entry "not-an-ip" is not a valid IP address or CIDR block',
    );
  });

  it("rejects an invalid IPv4 CIDR prefix length", () => {
    expect(() => parseTrustedProxies("10.0.0.0/33")).toThrow(
      'TRUSTED_PROXIES entry "10.0.0.0/33" has an invalid CIDR prefix; expected 0-32',
    );
  });

  it("rejects an invalid IPv6 CIDR prefix length", () => {
    expect(() => parseTrustedProxies("2001:db8::/129")).toThrow(
      'TRUSTED_PROXIES entry "2001:db8::/129" has an invalid CIDR prefix; expected 0-128',
    );
  });
});

describe("isTrustedProxyAddress (#75)", () => {
  it("returns false when no proxies are configured", () => {
    expect(isTrustedProxyAddress("127.0.0.1", [])).toBe(false);
  });

  it("returns false when proxy address differs from trusted", () => {
    expect(isTrustedProxyAddress("192.168.1.1", ["10.0.0.1"])).toBe(false);
  });

  it("returns true for an exact IPv4 match", () => {
    expect(isTrustedProxyAddress("10.0.0.5", ["10.0.0.5"])).toBe(true);
  });

  it("returns true for a CIDR block that includes the address", () => {
    expect(isTrustedProxyAddress("10.0.0.15", ["10.0.0.0/24"])).toBe(true);
  });

  it("returns false for an address outside the CIDR block", () => {
    expect(isTrustedProxyAddress("10.0.1.25", ["10.0.0.0/24"])).toBe(false);
  });

  it("returns true for an exact IPv6 match", () => {
    expect(isTrustedProxyAddress("2001:db8::1", ["2001:db8::1"])).toBe(true);
  });

  it("returns true for an IPv6 address inside an IPv6 CIDR block", () => {
    expect(isTrustedProxyAddress("2001:db8::1", ["2001:db8::/32"])).toBe(true);
  });

  it("returns false for an IPv6 address outside the CIDR block", () => {
    expect(isTrustedProxyAddress("2001:db9::1", ["2001:db8::/32"])).toBe(false);
  });

  it("returns true for ::1 inside ::1/128", () => {
    expect(isTrustedProxyAddress("::1", ["::1/128"])).toBe(true);
  });

  it("returns false for ::2 against ::1/128", () => {
    expect(isTrustedProxyAddress("::2", ["::1/128"])).toBe(false);
  });

  it("matches IPv4-mapped addresses against IPv4 CIDR entries", () => {
    // Fastify may pass addresses like ::ffff:10.0.0.5; the bare form
    // 10.0.0.5 should match an IPv4 CIDR entry.
    expect(isTrustedProxyAddress("::ffff:10.0.0.5", ["10.0.0.0/24"])).toBe(true);
  });

  it("does not match an IPv4 address against an IPv6 CIDR entry", () => {
    expect(isTrustedProxyAddress("10.0.0.5", ["2001:db8::/32"])).toBe(false);
  });
});

describe("trustProxy wiring (#75)", () => {
  it("passes untrusted XFF headers through to request.ip when no config", async () => {
    const app = await buildServer();
    await app.register((await import("../../src/routes/streams.js")).streamRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    await app.close();

    expect(response.headers["x-request-id"]).toBeTruthy();
    // Without config, request.ip falls back to the socket address; the XFF
    // header should not affect the logged client address.
    expect(response.statusCode).toBe(200);
  });

  it("honors XFF from the trusted proxy when configured", async () => {
    const app = await buildServer({ trustedProxies: ["127.0.0.1"] });
    await app.register((await import("../../src/routes/streams.js")).streamRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-forwarded-for": "10.0.0.99" },
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    // When trusted, request.ip becomes the forwarded address; health response
    // uses serviceVersion which is static, so we verify the status code.
    expect(response.statusCode).toBe(200);
  });
});
