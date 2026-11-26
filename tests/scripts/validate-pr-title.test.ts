import { describe, expect, it } from "vitest";

// @ts-expect-error the script is plain ESM JavaScript with no type declarations
import { ALLOWED_TYPES, validatePrTitle } from "../../scripts/validate-pr-title.mjs";

describe("validatePrTitle", () => {
  it.each([
    "feat: add webhook signature verification",
    "fix(auth): handle expired refresh tokens (#456)",
    "ci: validate pull request titles (#784)",
    "refactor(routes/streams)!: drop the legacy cursor",
  ])("accepts %s", (title) => {
    expect(validatePrTitle(title)).toEqual({ valid: true });
  });

  it.each([
    "",
    "   ",
    "Ci/issue 773",
    "update stuff",
    "feature: add a thing",
    "feat add a thing",
    "feat(Auth): uppercase scope",
    "feat:",
  ])("rejects %j", (title) => {
    expect(validatePrTitle(title).valid).toBe(false);
  });

  it("shows the allowed types and an example when a title is invalid", () => {
    const result = validatePrTitle("nope");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Examples:");
    for (const type of ALLOWED_TYPES) expect(result.error).toContain(type);
  });

  it("treats a missing title as empty", () => {
    expect(validatePrTitle(undefined).valid).toBe(false);
  });
});
