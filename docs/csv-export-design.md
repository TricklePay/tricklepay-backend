# CSV Export Design

## Overview

This design adds CSV export capability to the `GET /streams` endpoint for finance users who need to export stream data to spreadsheets. The endpoint responds with RFC 4180-compliant CSV when the client sends `Accept: text/csv`, mirroring the JSON structure while preserving exact decimal precision.

## Goals

1. Support CSV export via standard HTTP content negotiation (`Accept` header)
2. Preserve exact numeric precision (amounts as strings, never floats)
3. Follow RFC 4180 CSV specification for maximum compatibility
4. Maintain feature parity with JSON response (filtering, pagination, sorting)
5. Document the CSV format in the OpenAPI specification

## Content Negotiation

### Accept Header Handling

The endpoint responds based on the `Accept` header:

| Accept Header | Response Format | Content-Type |
|--------------|----------------|--------------|
| `application/json` (default) | JSON | `application/json; charset=utf-8` |
| `text/csv` | CSV | `text/csv; charset=utf-8` |
| `*/*` | JSON (default) | `application/json; charset=utf-8` |
| `text/csv, application/json` | CSV (first match) | `text/csv; charset=utf-8` |

### Error Responses

Error responses are **always JSON**, regardless of `Accept` header:
- `400 Bad Request`: Validation errors, invalid parameters
- `404 Not Found`: Stream not found
- `500 Internal Server Error`: Server failures

**Rationale:** CSV format cannot represent structured error objects with `code`, `error`, and `requestId` fields. Clients must handle JSON errors even when requesting CSV.

## CSV Format Specification

### Column Headers

The first row contains column names matching JSON field names:

```csv
id,sender,recipient,token,totalAmount,withdrawn,vested,withdrawable,locked,startTime,endTime,cliffTime,cancelled,cancelledAt,progress,status
```

### Field Mapping

| JSON Field | CSV Column | Type | Format | Example |
|-----------|-----------|------|--------|---------|
| `id` | `id` | string | Decimal string | `"12345"` |
| `sender` | `sender` | string | Stellar address | `"GABC..."` |
| `recipient` | `recipient` | string | Stellar address | `"GDEF..."` |
| `token` | `token` | string | Stellar address | `"CTOKEN..."` |
| `totalAmount` | `totalAmount` | string | Integer base units | `"1000000000"` |
| `withdrawn` | `withdrawn` | string | Integer base units | `"500000000"` |
| `vested` | `vested` | string | Integer base units | `"750000000"` |
| `withdrawable` | `withdrawable` | string | Integer base units | `"250000000"` |
| `locked` | `locked` | string | Integer base units | `"250000000"` |
| `startTime` | `startTime` | string | Unix seconds | `"1700000000"` |
| `endTime` | `endTime` | string | Unix seconds | `"1731536000"` |
| `cliffTime` | `cliffTime` | string | Unix seconds | `"1705000000"` |
| `cancelled` | `cancelled` | boolean | `true`/`false` | `false` |
| `cancelledAt` | `cancelledAt` | string or empty | Unix seconds or empty | `"1715000000"` or empty |
| `progress` | `progress` | number | Basis points (0-10000) | `7500` |
| `status` | `status` | string | Enum value | `"streaming"` |

### RFC 4180 Compliance

The CSV output follows [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180.html) strictly:

1. **Line endings:** CRLF (`\r\n`) between records
2. **Field separator:** Comma (`,`)
3. **Quoting:** Fields containing comma, quote, or newline are quoted with double quotes (`"`)
4. **Quote escaping:** Quotes within quoted fields are escaped as double-quotes (`""`)
5. **Header row:** First line contains column names
6. **Character encoding:** UTF-8 with BOM (optional, see below)

### Null/Empty Values

| Scenario | JSON Representation | CSV Representation |
|----------|--------------------|--------------------|
| Non-cancelled stream | `"cancelledAt": null` | Empty field: `...false,,7500,...` |
| Boolean false | `"cancelled": false` | Literal `false` |
| Zero amount | `"withdrawn": "0"` | Literal `"0"` |

**Rule:** Null values become empty CSV fields. All other values are stringified.

### UTF-8 BOM

**Decision:** Do NOT include UTF-8 BOM by default.

**Rationale:**
- Modern tools (Google Sheets, LibreOffice Calc, Excel 2016+) auto-detect UTF-8 without BOM
- BOM causes issues with command-line tools (`cat`, `head`, `grep`)
- BOM is not part of RFC 4180 specification

**Future:** Add `?bom=true` query parameter if Excel compatibility issues arise.

## Example Output

### Request

```http
GET /streams?limit=3&sender=GABC123&cancelled=false HTTP/1.1
Host: api.tricklepay.example
Accept: text/csv
```

### Response

```http
HTTP/1.1 200 OK
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="streams-2026-11-23.csv"
X-Request-Id: a1b2c3d4

id,sender,recipient,token,totalAmount,withdrawn,vested,withdrawable,locked,startTime,endTime,cliffTime,cancelled,cancelledAt,progress,status
"12345","GABC123...","GDEF456...","CTOKEN789...","1000000000","500000000","750000000","250000000","250000000","1700000000","1731536000","1705000000",false,,"7500","streaming"
"12346","GABC123...","GXYZ999...","CTOKEN789...","2000000000","0","0","0","2000000000","1735689600","1767225600","1740000000",false,,"0","pending"
"12347","GABC123...","GHIJ111...","CTOKEN789...","500000000","500000000","500000000","0","0","1690000000","1700000000","1690000000",false,,"10000","completed"
```

### Response Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Type` | `text/csv; charset=utf-8` | Media type and encoding |
| `Content-Disposition` | `attachment; filename="streams-YYYY-MM-DD.csv"` | Suggest download filename |
| `X-Request-Id` | (request ID) | Traceability (same as JSON) |

**Filename pattern:** `streams-{ISO-date}.csv` where date is current UTC date (e.g., `streams-2026-11-23.csv`)

## Query Parameter Support

All existing query parameters work identically for CSV and JSON:

| Parameter | Support | Notes |
|-----------|---------|-------|
| `sender` | ✅ | Filter by sender address |
| `recipient` | ✅ | Filter by recipient address |
| `token` | ✅ | Filter by token address |
| `cancelled` | ✅ | Filter by cancellation status |
| `limit` | ✅ | Page size (max 100) |
| `offset` | ✅ | Pagination offset |
| `cursor` | ✅ | Cursor-based pagination |
| `includeTotal` | ⚠️ | Ignored for CSV (see below) |
| `contract` | ✅ | Filter by contract (multi-contract deployments) |

### includeTotal Behavior

The `includeTotal` parameter is **ignored** for CSV responses:
- CSV is a flat tabular format with no place for metadata like `total`
- Clients needing both total count and CSV data must make two requests:
  1. `GET /streams?includeTotal=true` (JSON) to get total
  2. `GET /streams` with `Accept: text/csv` to get CSV

**Alternative considered:** Add total as a comment line (`# Total: 1234`). Rejected because:
- Breaks RFC 4180 (no comment syntax defined)
- Some CSV parsers fail on non-data rows
- Clients can query total separately if needed

## Pagination Behavior

CSV responses are paginated identically to JSON:

### Example: Exporting All Streams

```bash
# Page 1
curl -H "Accept: text/csv" "https://api.tricklepay.example/streams?limit=100" > streams-1.csv

# Page 2
curl -H "Accept: text/csv" "https://api.tricklepay.example/streams?limit=100&offset=100" > streams-2.csv

# Combine (skip header rows except first)
cat streams-1.csv > all-streams.csv
tail -n +2 streams-2.csv >> all-streams.csv
```

### Cursor-Based Pagination

Cursor pagination works with CSV:

```bash
# First page (returns X-Next-Cursor header)
curl -i -H "Accept: text/csv" "https://api.tricklepay.example/streams?limit=100" > page1.csv

# Extract cursor from headers and fetch next page
curl -H "Accept: text/csv" "https://api.tricklepay.example/streams?cursor=abc123" > page2.csv
```

**Future enhancement:** Add `Link` header with `rel="next"` for RFC 8288 web linking.

## Implementation Details

### Fastify Route Handler

Extend the existing `/streams` handler to check `Accept` header:

```typescript
app.get('/streams', {
  schema: {
    // ... existing JSON schema
    produces: ['application/json', 'text/csv'],
  }
}, async (request, reply) => {
  const accept = request.headers.accept ?? 'application/json';
  
  // Fetch streams (same query logic for both formats)
  const streams = await fetchStreams(filters);
  
  if (accept.includes('text/csv')) {
    const csv = formatCSV(streams);
    reply
      .type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="streams-${getCurrentDate()}.csv"`)
      .send(csv);
  } else {
    reply.send({ streams, pagination });
  }
});
```

### CSV Formatting Function

```typescript
function formatCSV(streams: StreamView[]): string {
  const header = 'id,sender,recipient,token,totalAmount,withdrawn,vested,withdrawable,locked,startTime,endTime,cliffTime,cancelled,cancelledAt,progress,status\r\n';
  
  const rows = streams.map(stream => {
    return [
      stream.id,
      stream.sender,
      stream.recipient,
      stream.token,
      stream.totalAmount,
      stream.withdrawn,
      stream.vested,
      stream.withdrawable,
      stream.locked,
      stream.startTime,
      stream.endTime,
      stream.cliffTime,
      stream.cancelled,
      stream.cancelledAt ?? '', // null becomes empty field
      stream.progress,
      stream.status,
    ]
      .map(escapeCSVField)
      .join(',');
  }).join('\r\n');
  
  return header + rows + '\r\n';
}

function escapeCSVField(value: string | number | boolean): string {
  if (value === null || value === undefined) return '';
  
  const str = String(value);
  
  // Quote if contains comma, quote, newline, or carriage return
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  
  return str;
}
```

### Library Consideration

**Option 1:** Manual formatting (shown above)
- **Pros:** No dependencies, full control, simple logic
- **Cons:** Must handle edge cases manually

**Option 2:** Use `csv-stringify` library
- **Pros:** RFC 4180 compliant, handles all edge cases, well-tested
- **Cons:** Additional dependency

**Recommendation:** Use `csv-stringify` from the `csv` package for correctness and maintainability.

```typescript
import { stringify } from 'csv-stringify/sync';

function formatCSV(streams: StreamView[]): string {
  const records = streams.map(stream => ({
    id: stream.id,
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    totalAmount: stream.totalAmount,
    withdrawn: stream.withdrawn,
    vested: stream.vested,
    withdrawable: stream.withdrawable,
    locked: stream.locked,
    startTime: stream.startTime,
    endTime: stream.endTime,
    cliffTime: stream.cliffTime,
    cancelled: stream.cancelled,
    cancelledAt: stream.cancelledAt ?? '',
    progress: stream.progress,
    status: stream.status,
  }));
  
  return stringify(records, {
    header: true,
    columns: ['id', 'sender', 'recipient', 'token', 'totalAmount', 'withdrawn', 'vested', 'withdrawable', 'locked', 'startTime', 'endTime', 'cliffTime', 'cancelled', 'cancelledAt', 'progress', 'status'],
    record_delimiter: '\r\n',
  });
}
```

## OpenAPI Documentation

Update the OpenAPI spec to document CSV support:

```yaml
/streams:
  get:
    summary: List streams
    description: Returns a paginated list of streams. Supports both JSON and CSV output via the Accept header.
    parameters:
      # ... existing parameters
    responses:
      '200':
        description: Successful response
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/StreamListResponse'
          text/csv:
            schema:
              type: string
              example: |
                id,sender,recipient,token,totalAmount,withdrawn,vested,withdrawable,locked,startTime,endTime,cliffTime,cancelled,cancelledAt,progress,status
                "12345","GABC...","GDEF...","CTOKEN...","1000000000","500000000","750000000","250000000","250000000","1700000000","1731536000","1705000000",false,,"7500","streaming"
            examples:
              streamsCsv:
                summary: CSV export of streams
                value: |
                  id,sender,recipient,token,totalAmount,withdrawn,vested,withdrawable,locked,startTime,endTime,cliffTime,cancelled,cancelledAt,progress,status
                  "12345","GABC...","GDEF...","CTOKEN...","1000000000","500000000","750000000","250000000","250000000","1700000000","1731536000","1705000000",false,,"7500","streaming"
```

## Testing Strategy

### Unit Tests

1. **CSV formatting:**
   - Test field quoting (commas, quotes, newlines)
   - Test quote escaping (`"` → `""`)
   - Test null/empty values
   - Test boolean and numeric values

2. **Edge cases:**
   - Empty result set (header only)
   - Single stream
   - Stream with all null optional fields
   - Addresses containing special characters

### Integration Tests

1. **Content negotiation:**
   - `Accept: application/json` returns JSON
   - `Accept: text/csv` returns CSV
   - No `Accept` header defaults to JSON
   - `Accept: */*` defaults to JSON
   - Multiple accept types honor priority

2. **Query parameter parity:**
   - Filters work identically for CSV and JSON
   - Pagination works identically for CSV and JSON
   - Results match between formats (same streams, same order)

3. **Response headers:**
   - `Content-Type: text/csv; charset=utf-8`
   - `Content-Disposition` header present with correct filename
   - `X-Request-Id` header present

4. **RFC 4180 compliance:**
   - Parse generated CSV with standard CSV parser
   - Verify round-trip (CSV → parse → CSV produces identical output)
   - Test with Excel, Google Sheets (manual verification)

### Example Test

```typescript
test('GET /streams with Accept: text/csv returns RFC 4180 CSV', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/streams?limit=2',
    headers: { accept: 'text/csv' },
  });
  
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
  expect(response.headers['content-disposition']).toMatch(/^attachment; filename="streams-\d{4}-\d{2}-\d{2}\.csv"$/);
  
  const lines = response.body.split('\r\n');
  expect(lines[0]).toBe('id,sender,recipient,token,totalAmount,withdrawn,vested,withdrawable,locked,startTime,endTime,cliffTime,cancelled,cancelledAt,progress,status');
  expect(lines.length).toBeGreaterThan(1); // Header + at least one data row
  
  // Verify CSV is parseable
  const parsed = parse(response.body, { columns: true });
  expect(parsed.length).toBeGreaterThan(0);
  expect(parsed[0]).toHaveProperty('id');
  expect(parsed[0]).toHaveProperty('totalAmount');
});

test('CSV preserves exact decimal precision', async () => {
  // Create stream with large amount
  const bigAmount = '999999999999999999999999999999'; // 30 digits
  
  const response = await app.inject({
    method: 'GET',
    url: `/streams?limit=1`,
    headers: { accept: 'text/csv' },
  });
  
  const lines = response.body.split('\r\n');
  const dataRow = lines[1];
  
  // Amount should be exact string, not scientific notation
  expect(dataRow).toContain(bigAmount);
  expect(dataRow).not.toContain('e+'); // No exponential notation
});
```

## Error Handling

### Invalid Accept Header

If the Accept header specifies only unsupported media types:

```http
GET /streams HTTP/1.1
Accept: application/xml
```

**Response:**
```http
HTTP/1.1 406 Not Acceptable
Content-Type: application/json

{
  "code": "REQUEST_ERROR",
  "error": "Unsupported media type. Supported types: application/json, text/csv",
  "requestId": "..."
}
```

**Implementation note:** Fastify does not enforce `406` by default. Add explicit handling if strict compliance is needed.

## Security Considerations

### No Additional Attack Surface

CSV export does not introduce new security risks:
- Same authentication/authorization as JSON endpoint (none currently)
- Same query validation and filtering
- No file upload or write operations
- Output is pure data serialization

### CSV Injection

**Risk:** Excel and other spreadsheet applications execute formulas starting with `=`, `+`, `-`, or `@`.

**Mitigation:** Escape leading special characters in fields:

```typescript
function sanitizeCSVField(value: string): string {
  // Prefix dangerous characters with single quote to prevent formula execution
  if (/^[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}
```

**Decision:** Do NOT implement CSV injection escaping initially.

**Rationale:**
- Stream data (addresses, amounts, timestamps) does not contain formulas
- User-generated content is not part of stream data
- Over-escaping breaks legitimate values (e.g., negative numbers as `-123`)

**Future:** Add `?sanitize=true` parameter if formula injection becomes a concern.

## Documentation Updates

### README.md

Add CSV export example to API section:

```markdown
### CSV Export

The `/streams` endpoint supports CSV export for spreadsheet integration:

\`\`\`bash
curl -H "Accept: text/csv" https://api.tricklepay.example/streams > streams.csv
\`\`\`

All query parameters (filters, pagination) work identically for CSV and JSON responses. Amounts are exported as exact decimal strings to preserve precision.
```

### API Documentation

Update the `/streams` endpoint documentation:
- List `text/csv` as a supported response media type
- Add CSV response example
- Note that `includeTotal` is ignored for CSV
- Document `Content-Disposition` header behavior

## Performance Considerations

CSV serialization is **more efficient** than JSON for large datasets:
- Smaller payload size (no key repetition, no object delimiters)
- Simpler formatting logic (no nested structures)
- Faster parsing in spreadsheet applications

**Benchmark expectation:** CSV response ~30% smaller and ~20% faster to generate than equivalent JSON.

## Future Enhancements

1. **Streaming CSV:** Use Fastify streaming response for large datasets (>10k rows)
2. **Column selection:** `?columns=id,sender,totalAmount` to export subset of fields
3. **Custom delimiter:** `?delimiter=;` for semicolon-separated values (European locale)
4. **Date formatting:** `?dateFormat=iso8601` for human-readable timestamps
5. **Amount formatting:** `?amountFormat=decimal` to convert stroops to XLM (e.g., `10.5000000`)
6. **Compressed download:** `Content-Encoding: gzip` for large exports

## Open Questions

1. **Should summary endpoint support CSV?**
   - **Proposal:** No, summary is inherently structured (nested by status). Keep JSON-only.

2. **Should single stream endpoint (`GET /streams/:id`) support CSV?**
   - **Proposal:** No, CSV is for tabular lists. Single-row CSV is awkward.

3. **Should we limit CSV export size?**
   - **Proposal:** Use same `limit` as JSON (max 100 per page). Clients paginate for full export.

4. **What if Excel doesn't auto-detect UTF-8?**
   - **Proposal:** Add `?bom=true` parameter to prepend UTF-8 BOM when needed.
