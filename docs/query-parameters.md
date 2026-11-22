# Repeated Query Parameters

Decision record for issue #519: what the API does when a query parameter appears
more than once, for example `?sender=A&sender=B`.

## Decision

Requests that repeat a query-parameter name are rejected with `400` and the
standard error body:

```json
{
  "code": "VALIDATION_ERROR",
  "error": "repeated query parameter: sender",
  "requestId": "8f0c2c1e-..."
}
```

The check applies to every route and is implemented as an `onRequest` hook in
[`src/server.ts`](../src/server.ts). It runs before the route handler, so no
database work happens for a rejected request.

## Context

The API parsed its query string with:

```ts
params.forEach((value, key) => { result[key] = value });
```

which silently keeps the **last** value of a repeated parameter. `?sender=A&sender=B`
therefore filtered by `B` and ignored `A`. Silent last-wins is a known source of
parameter-pollution bugs: the same URL can mean different things depending on
which layer (proxy, gateway, framework, application) reads it, and a client that
accidentally repeats a filter gets plausible-looking but wrong data.

## Alternatives considered

1. **Document last-wins and keep the behaviour.** Smallest change, no breaking
   risk. Rejected because the failure stays silent: a typo or duplicated
   parameter returns a valid-looking response for the wrong filter, and nothing
   in the response or logs tells the caller.
2. **Document first-wins.** Equally silent, and it changes existing behaviour
   without making mistakes any easier to notice.
3. **Accept arrays for repeated parameters.** The filters are semantically
   single-valued (a stream has one sender, one recipient, one token), so an array
   would either need per-field special cases or implicit "match any" semantics
   nobody asked for.
4. **Reject repeated parameters with `400`.** Chosen.

## Why reject

- Every supported filter is single-valued, so a repeat is always ambiguous or a
  mistake; there is no legitimate request to break.
- An explicit error makes the mistake visible at the call site instead of
  returning silently wrong data.
- It closes the parameter-pollution vector before any handler or database access,
  independent of how a proxy or client encoded the second occurrence.
- It is cheap: one pass over the already-parsed keys, with no I/O.

## Trade-offs

- **Breaking change** for any client that relied on last-wins. This is a
  read-only public API and the rule is now documented, so the risk is small and
  the alternative is worse. Clients needing multiple addresses must issue
  separate requests (or extend the API deliberately, later).
- **Identical repeats are rejected too** (`?sender=A&sender=A`). Allowing those
  would add a special case with no real benefit; a repeat is still a client bug.
- **Unmatched paths still return `404`.** The check runs after routing, so a
  request to an unknown path with a repeated parameter reports the missing route
  rather than the query error. This is intentional: the route error is the more
  useful one.

## Behaviour details

- Comparison happens after percent-decoding, so `?sender=A&%73ender=B` is also
  rejected as a repeat of `sender`.
- The error uses the same `{ code, error, requestId }` shape as every other API
  failure, with `code: "VALIDATION_ERROR"` for the `400` status.
- An oversized query string (`QUERY_STRING_LIMIT`) is rejected the same way,
  with `400` and `"query string too long"`, rather than throwing during parsing.

## Tests

Covered in [`tests/routes/query-parameters.test.ts`](../tests/routes/query-parameters.test.ts):
duplicate values, identical duplicates, percent-encoded duplicates, a single
parameter still working, and the oversized-query case.
