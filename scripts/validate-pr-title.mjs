#!/usr/bin/env node

// Single source of truth for allowed Conventional Commit types in PR titles
export const ALLOWED_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

// Matches:
// - type: description
// - type(scope): description
// - type(scope): description (#123)
// - type!: breaking change description (#123)
const PR_TITLE_REGEX = new RegExp(
  `^(${ALLOWED_TYPES.join("|")})(?:\\([a-z0-9-]+(?:\\/[a-z0-9-]+)*\\))?!?:\\s+\\S.*$`
);

export function validatePrTitle(title) {
  const trimmed = (title ?? "").trim();
  if (!trimmed) {
    return {
      valid: false,
      error: "Pull request title cannot be empty.",
    };
  }

  if (!PR_TITLE_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: [
        `Invalid pull request title: "${trimmed}"`,
        "",
        "Expected Conventional Commit format:",
        "  <type>(<scope>): <description> (#<issue>)",
        "",
        "Allowed types:",
        `  ${ALLOWED_TYPES.join(", ")}`,
        "",
        "Examples:",
        "  feat(payments): add webhook signature verification (#123)",
        "  fix(auth): handle expired refresh tokens (#456)",
        "  ci: validate pull request titles (#784)",
      ].join("\n"),
    };
  }

  return { valid: true };
}

// CLI execution when invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const title = process.env.PR_TITLE ?? process.argv.slice(2).join(" ");
  const result = validatePrTitle(title);

  if (!result.valid) {
    console.error(result.error);
    process.exit(1);
  }

  console.log(`Valid PR title: "${title.trim()}"`);
}