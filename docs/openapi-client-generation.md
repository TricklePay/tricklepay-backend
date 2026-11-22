# Generating a Typed Client from the OpenAPI Document

The service publishes its OpenAPI 3.0 document at `/docs/json` (see
[the API section of the README](../README.md#api)). This guide generates a
typed TypeScript client from it, for frontends and third-party integrations
that would otherwise hand-write request code and response types.

## Generate types with `openapi-typescript`

[`openapi-typescript`](https://www.npmjs.com/package/openapi-typescript) reads
an OpenAPI document and emits matching TypeScript types — no Java runtime, no
code generation templates, just `npx`. Run this from the consuming project
(a frontend, a script, anywhere with Node and network access to the running
service):

```bash
npx openapi-typescript http://localhost:3000/docs/json -o src/trickle-pay-api.d.ts
```

Point it at a deployed instance instead of `localhost:3000` for a staging or
production spec. The output is a single `.d.ts` file with a `paths` type
covering every route and a `components["schemas"]` type for every named
schema (`StreamView`, `StreamListResponse`, `IndexerStatus`, `ApiError`, …).

## Use it as a client with `openapi-fetch`

`openapi-typescript` only generates types; pair it with
[`openapi-fetch`](https://www.npmjs.com/package/openapi-fetch) for a thin,
fully-typed `fetch` wrapper built on those types — request paths, query
parameters, and response shapes are all checked at compile time:

```bash
npm install openapi-fetch
```

```ts
import createClient from "openapi-fetch";
import type { paths } from "./trickle-pay-api.js";

const client = createClient<paths>({ baseUrl: "http://localhost:3000" });

const { data, error } = await client.GET("/streams", {
  params: { query: { sender: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" } },
});

if (error) throw error;
for (const stream of data.streams) {
  console.log(stream.id, stream.vested);
}
```

Misspelling a query parameter, requesting a path that doesn't exist, or
reading a field the response doesn't have is a type error here, not a runtime
surprise.

## Amounts and times are decimal strings, not numbers

The generated types will show `totalAmount`, `withdrawn`, `vested`,
`withdrawable`, `locked`, `startTime`, `endTime`, and `cliffTime` as
`string`, not `number`. This is not a generator quirk — the API serialises
them that way deliberately:

- Token amounts are 128-bit integers (`uint128`), and ledger times and stream
  ids are 64-bit (`uint64`). Both exceed the 2^53 safe-integer range of a
  JavaScript `number` and of a JSON number parsed by `JSON.parse`, so encoding
  them as JSON numbers would silently lose precision for large values.
- Encoding them as decimal strings instead means the exact on-chain value
  always round-trips, at the cost of the client having to convert explicitly.

Convert on the way in, with `BigInt(...)` for arithmetic or comparisons, and
back to a string (not a `number`) wherever the value is displayed or sent
onward:

```ts
const vested = BigInt(data.vested); // not Number(data.vested) — may overflow
const total = BigInt(data.totalAmount);
const remaining = total - vested;
```

See [docs/database-schema.md](database-schema.md) and
[docs/derived-figures.md](derived-figures.md) for what each of these fields
means and how it's computed.

## Keeping the client in sync

The OpenAPI document is generated automatically from the route schemas in
`src/routes/` and `src/schema.ts` — there is no separate spec file to edit by
hand. When those schemas change, re-run the `openapi-typescript` command
above to regenerate the `.d.ts` file; a diff in the generated types is the
signal that a consumer needs to update its code.
