# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial entry capturing the current public API and operational baseline.
- CI builds the container image and waits for its `HEALTHCHECK` to report healthy against a PostgreSQL service (#702).
- CI scans the container image with Trivy, failing on critical findings outside `.trivyignore`, and uploads the report (#703).
- Version tags (`v*`) publish the image to `ghcr.io/tricklepay/tricklepay-backend` with OCI labels and record its digest in the release notes (#704).
- CycloneDX SBOMs for the npm dependencies and the container image are attached to CI runs and releases (#705).
