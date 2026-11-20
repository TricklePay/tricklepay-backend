# Configuration & Environment Variable Precedence

The TricklePay backend is a **Fastify** service, and it has no configuration framework. Every setting comes from the process environment; the only configuration file the service ever reads is a local `.env`, and that file is optional.

This guide covers where a value comes from and which value wins when two sources disagree. The list of variables, their defaults and whether they are required lives in the [README configuration table](../README.md#configuration); the annotated template to copy from is [`.env.example`](../.env.example).

---

## How configuration is loaded

Two steps, both in [`src/config.ts`](../src/config.ts):

**1. The `.env` file is read once, when the module is loaded.**

```ts
try {
  process.loadEnvFile();
} catch {
  // No .env file found; rely on the ambient environment.
}
```

`process.loadEnvFile()` is Node's built-in `.env` loader, available from Node 20.12 — the floor declared in `package.json`'s `engines.node`. There is **no `dotenv` dependency** and **no `ConfigModule`** in this repository: neither `dotenv` nor NestJS is imported anywhere in the source tree, and Fastify does not bring a configuration module of its own.

Three consequences of that call:

- **A missing `.env` is not an error.** The call throws when the file does not exist and the `try`/`catch` swallows it, so a deployment that passes everything through its platform's environment never needs a `.env` file.
- **The file is looked up in the current working directory.** With no path argument, Node reads `.env` from `process.cwd()`, so it is found when the service is started from the repository root (`npm start`, `npm run dev`) and not found when it is started from somewhere else.
- **Containers never carry one.** `.env` is listed in `.gitignore` and in `.dockerignore`, so the Docker image ships without it and a containerised deployment is configured entirely by the environment its platform injects.

**2. `loadConfig()` resolves each value from `process.env`.**

It reads one variable at a time, applies the documented default when the variable is unset or blank, and validates the result. The resolved object is what the server, the indexer and the RPC client run on; see [Values read outside `loadConfig()`](#values-read-outside-loadconfig) for the two exceptions.

---

## Precedence

Values are resolved in this order, **highest precedence first**:

| Rank | Source | Where it comes from |
| --- | --- | --- |
| 1 | **Process environment** | Exported in the shell, injected by the container or Kubernetes runtime, or passed inline at startup (`PORT=8080 npm start`). |
| 2 | **`.env` file** | A line in the `.env` in the working directory, read by `process.loadEnvFile()`. |
| 3 | **Built-in defaults** | The fallback passed to `loadConfig()` — for example `PORT` falls back to `3000` and `HOST` to `0.0.0.0`. |

> **Rule: the process environment wins.** `process.loadEnvFile()` only fills in variables that are *not already present* in `process.env`; it never overwrites one that is. A variable exported in the shell, injected by the container runtime, or passed inline therefore takes precedence over the same variable in `.env`, and the `.env` value is ignored entirely.

Note the direction of that rule: a `.env` file cannot clobber an already-exported variable, which is the failure mode some `dotenv` setups do have.

A **blank** value (`PORT=`) is not the same as an absent one. `loadConfig()` treats a blank value as "not set" and falls back to the built-in default, so `PORT=` in `.env` leaves the port at `3000` rather than listening on an empty port. `CORS_ORIGIN` is the one exception, where a blank value means "disabled" rather than "use the default" — see below.

---

## Practical example

Suppose the `.env` in the working directory holds the local development defaults:

```env
# .env
DATABASE_URL=postgresql://tricklepay:tricklepay@localhost:5432/tricklepay
STREAM_CONTRACT_ID=CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW
PORT=3000
```

Starting the service with one variable overridden in the environment:

```bash
PORT=8080 npm start
```

The server listens on **8080**, not 3000. `PORT=8080` is placed in the process environment before the process starts, so when `process.loadEnvFile()` runs it finds `PORT` already present and leaves it alone; the `PORT=3000` line in `.env` is never applied. Every other variable — `DATABASE_URL` and `STREAM_CONTRACT_ID` above — still comes from `.env`.

The same holds in the other direction: a variable that only the process environment defines is used, a variable that only `.env` defines is used, and a variable that neither defines falls back to the built-in default.

### Confirming which value won

The service logs the configuration it actually resolved as its first log line, with the database credentials redacted (excerpt):

```text
{"level":30,"time":1760000000000,"config":{"port":8080,"host":"0.0.0.0","publicBaseUrl":"http://localhost:8080", …},"msg":"effective configuration"}
```

The same resolution is available without starting the server:

```bash
npm run print-config
```

Both go through `describeConfig()` in [`src/config.ts`](../src/config.ts), so what is printed is exactly what the server would run with.

---

## Values read outside `loadConfig()`

`loadConfig()` is not the only reader of `process.env`. Two groups of variables are read directly:

| Variable | Read in | Effect |
| --- | --- | --- |
| `CORS_ORIGIN` | [`src/server.ts`](../src/server.ts), in `buildServer` | The `@fastify/cors` origin policy: unset → any origin is reflected; blank → browser access is disabled; set → only that origin is allowed. |
| `LOG_LEVEL`, `LOG_PRETTY` | [`src/logger.ts`](../src/logger.ts) | The log level and human-readable output, resolved when the shared logger is created. |

`CORS_ORIGIN` is therefore **not** part of the `Config` object, which has two consequences:

- It does not appear in the "effective configuration" startup log line, nor in `npm run print-config` output. Its effective value has to be read from the environment itself (`printenv CORS_ORIGIN`, or the container's environment).
- It is not validated by `loadConfig()`. The unset / blank / set distinction is applied where the CORS plugin is registered, which is why a blank `CORS_ORIGIN` disables browser access rather than falling back to a default.

Every other variable in the README table is resolved and validated by `loadConfig()`.

---

## Startup validation

`loadConfig()` validates as it resolves, so a misconfiguration fails the boot with a named error instead of surfacing later as a runtime failure:

- `DATABASE_URL` and `STREAM_CONTRACT_ID` are required; a missing one aborts startup with `Missing required environment variable: <NAME>`.
- `STREAM_CONTRACT_ID` must parse as a Soroban contract address, and `SOROBAN_RPC_URL` may only use plain HTTP against a loopback host (see [local-network.md](local-network.md#plain-http-is-only-allowed-for-local-rpc-hosts)).
- Numeric variables must be non-negative integers; `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS` must be greater than zero, and `INDEXER_POLL_INTERVAL_MS` must be at least 1000.
- `ENABLE_DOCS_UI` accepts only explicit boolean spellings (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`); anything else fails startup.
