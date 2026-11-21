import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("docker-compose and Dockerfile configuration", () => {
  const composePath = path.resolve("docker-compose.yml");
  const dockerfilePath = path.resolve("Dockerfile");
  const composeContent = readFileSync(composePath, "utf8");
  const dockerfileContent = readFileSync(dockerfilePath, "utf8");

  it("fails fast in docker-compose when STREAM_CONTRACT_ID is not set", () => {
    expect(composeContent).toContain(
      "STREAM_CONTRACT_ID: ${STREAM_CONTRACT_ID:?STREAM_CONTRACT_ID must be set to the deployed Soroban stream contract address}",
    );
  });

  it("defines a dedicated migrate service in docker-compose", () => {
    expect(composeContent).toContain("migrate:");
    expect(composeContent).toContain("target: migrate");
    expect(composeContent).toContain("condition: service_completed_successfully");
  });

  it("defines dedicated build stages in Dockerfile for migration and runtime", () => {
    expect(dockerfileContent).toContain("FROM node:22-alpine AS migrate");
    expect(dockerfileContent).toContain("ENTRYPOINT [\"npx\", \"prisma\", \"migrate\", \"deploy\"]");
    expect(dockerfileContent).toContain("FROM node:22-alpine AS prod-deps");
    expect(dockerfileContent).toContain("FROM node:22-alpine AS runtime");
  });
});
