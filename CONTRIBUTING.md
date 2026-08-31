# Contributing to TricklePay Backend

Thank you for contributing to `tricklepay-backend`! This guide covers local environment setup, mandatory quality checks, coding conventions, and instructions for submitting a pull request.

For overarching architecture, security models, and cross-repository contribution standards, please refer to the shared [TricklePay Documentation Guide](https://github.com/TricklePay/tricklepay-docs).

---

## Local Setup

### Requirements

- **Node.js**: `^20.12.0` (see `.nvmrc` and `engines.node` in `package.json`).
- **Docker & Docker Compose**: For local PostgreSQL database or full stack containerization.
- **Soroban Contract ID**: A deployed stream contract address (`STREAM_CONTRACT_ID`).

### Development Steps

1. **Clone the repository and set up Node:**

   ```bash
   git clone https://github.com/TricklePay/tricklepay-backend.git
   cd tricklepay-backend
   nvm use
   ```

2. **Configure Environment Variables:**

   ```bash
   cp .env.example .env
   ```

   Open `.env` and set `STREAM_CONTRACT_ID` to your target Soroban contract address.

3. **Install Dependencies:**

   ```bash
   npm install
   ```

4. **Start Development Stack:**

   ```bash
   ./scripts/dev.sh
   ```

   Alternatively, run the full stack via Docker Compose:

   ```bash
   docker compose up --build
   ```

---

## Code Quality Checks

Before submitting a pull request, run all required quality checks to ensure type safety, test validity, and build success:

```bash
# 1. Type checking
npm run typecheck

# 2. Run unit test suite
npm test

# 3. Build production output
npm run build
```

---

## Code Conventions

### Import Ordering

Keep import statements structured cleanly in the following canonical order:

1. **Node built-ins** (`node:*`, e.g., `node:path`, `node:fs`).
2. **Third-party packages** (alphabetized, e.g., `fastify`, `prisma`).
3. **Relative imports** (alphabetized by path, e.g., `./config`, `../repositories/streams`).

Separate each group with a single blank line.

---

## Submitting Pull Requests

1. **Create a Feature Branch:**

   ```bash
   git checkout -b feat/short-description
   # or for documentation updates:
   git checkout -b docs/short-description
   ```

2. **Commit Your Changes:**
   Write concise, descriptive commit messages matching conventional commit format:
   `feat(<scope>): description (#issue)` or `docs(<scope>): description (#issue)`.

3. **Open a Pull Request:**
   - Push your branch to `origin`.
   - Open a PR against the `main` branch.
   - Include `Closes #<ISSUE_NUMBER>` in the PR description to link and automatically close relevant issues.

---

## Shared Guidelines

For broader guidelines on contract interaction, network configurations, and security practices across all TricklePay repositories, visit the [TricklePay Shared Docs](https://github.com/TricklePay/tricklepay-docs).
