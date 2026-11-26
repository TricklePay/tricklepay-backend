# Code scanning

## CodeQL

The [CodeQL](../.github/workflows/codeql.yml) workflow analyzes JavaScript and TypeScript under `src/` and `tests/`. It runs on every pull request, on pushes to `main`, and weekly (Mondays 06:00 UTC).

## OpenSSF Scorecard

The [Scorecard](../.github/workflows/scorecard.yml) workflow assesses repository supply-chain practices (for example pinned dependencies and workflow token permissions). It runs on pushes to `main` and weekly (Saturdays 01:30 UTC). With `publish_results: true`, the latest score is also available from the [Scorecard viewer](https://scorecard.dev/viewer/) and the public Scorecard badge API.

## Where to see results

- **GitHub → Security → Code scanning alerts** for open and dismissed findings on the default branch (CodeQL and Scorecard SARIF).
- **Pull request checks** for the `CodeQL / Analyze` job; the Checks tab links to any alerts introduced in that change when GitHub attaches them.

Dependency advisories and container image vulnerabilities are handled separately by the Dependency Audit and Container image workflows (see [dependency-updates.md](dependency-updates.md) and [container-image.md](container-image.md)).