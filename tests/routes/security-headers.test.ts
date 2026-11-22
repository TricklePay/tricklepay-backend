import { describe, expect, it } from "vitest";

// Security headers (#520): every response carries hardening headers so browsers
// and clients cannot misinterpret JSON bodies as HTML, and the interactive docs
// keep working under a policy strict enough for an API.

const { buildServer } = await import("../../src/server.js");

async function request(url: string) {
  const app = await buildServer();
  await app.ready();
  const response = await app.inject({ method: "GET", url });
  await app.close();
  return response;
}

function csp(response: { headers: Record<string, unknown> }): string {
  return String(response.headers["content-security-policy"] ?? "");
}

describe("Security headers (#520)", () => {
  it("prevents MIME sniffing of API responses", async () => {
    const response = await request("/health");
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets a restrictive Content-Security-Policy", async () => {
    const policy = csp(await request("/health"));
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // Inline styles are required by Swagger UI, which styles the page with
    // style attributes; scripts stay restricted to same-origin files.
    expect(policy).toContain("'unsafe-inline'");
  });

  it("does not force HTTPS upgrades, so the docs work over plain HTTP", async () => {
    expect(csp(await request("/health"))).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("sets Referrer-Policy: no-referrer", async () => {
    const response = await request("/health");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("keeps responses readable by cross-origin browser callers", async () => {
    const response = await request("/health");
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("applies the headers to error responses too", async () => {
    const response = await request("/does-not-exist");
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(csp(response)).toContain("default-src 'self'");
  });
});

describe("Swagger UI under the security policy (#520)", () => {
  it("still serves the interactive docs page", async () => {
    const response = await request("/docs");
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    // The page only references same-origin assets, which the policy allows.
    expect(response.body).toContain("/docs/static/swagger-ui-bundle.js");
    expect(csp(response)).toContain("script-src 'self'");
    expect(csp(response)).not.toContain("upgrade-insecure-requests");
  });

  it("serves the same-origin scripts the page loads", async () => {
    const response = await request("/docs/static/swagger-ui-bundle.js");
    expect(response.statusCode).toBe(200);
    expect(response.body.length).toBeGreaterThan(1000);
  });
});
