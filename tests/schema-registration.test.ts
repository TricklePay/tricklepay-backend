import type { FastifyInstance, RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";

import * as schemaModule from "../src/schema.js";
import { registerSharedSchemas, SHARED_SCHEMAS } from "../src/schema-registration.js";

// Shared schema registration (#713). Every `*_SCHEMA_ID` exported from
// `schema.ts` must be registered exactly once by `registerSharedSchemas`, and
// every $ref a route (or a shared schema) uses must point at a registered id.
// Nothing here touches the database: the route modules are only registered,
// never called.

const exportedIds = Object.entries(schemaModule)
  .filter(([name]) => name.endsWith("_SCHEMA_ID"))
  .map(([name, value]) => ({ name, id: value as string }));

/** Calls `registerSharedSchemas` on a stub and returns each $id it added, in order. */
function registeredIds(): string[] {
  const added: string[] = [];
  const stub = {
    addSchema(schema: { $id?: string }) {
      added.push(String(schema.$id));
      return stub;
    },
  };
  registerSharedSchemas(stub as unknown as FastifyInstance);
  return added;
}

/** Collects every `$ref` value nested anywhere inside `value`. */
function collectRefs(value: unknown, refs: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") refs.add(child);
      else collectRefs(child, refs);
    }
  }
  return refs;
}

/** Strips any JSON pointer fragment, so "StreamView#/properties/id" → "StreamView". */
function refTarget(ref: string): string {
  return ref.split("#")[0];
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

describe("shared schema ids", () => {
  it("finds the exported *_SCHEMA_ID constants", () => {
    // Guards the enumeration itself: if the naming convention changes and this
    // finds nothing, the checks below would pass vacuously.
    expect(exportedIds.length).toBeGreaterThan(0);
    for (const { name, id } of exportedIds) {
      expect(typeof id, name).toBe("string");
      expect(id, name).not.toBe("");
    }
  });

  it("uses a distinct value for every exported id", () => {
    const duplicates = [...countBy(exportedIds.map(({ id }) => id))]
      .filter(([, count]) => count > 1)
      .map(([id]) => `${id} (${exportedIds.filter((e) => e.id === id).map((e) => e.name).join(", ")})`);

    expect(duplicates, `duplicate schema id values: ${duplicates.join("; ")}`).toEqual([]);
  });

  it("registers every exported id", () => {
    const registered = new Set(registeredIds());
    const missing = exportedIds
      .filter(({ id }) => !registered.has(id))
      .map(({ name, id }) => `${name} = "${id}"`);

    expect(missing, `not registered by registerSharedSchemas: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers each id exactly once", () => {
    const duplicates = [...countBy(registeredIds())]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => `${id} ×${count}`);

    expect(duplicates, `registered more than once: ${duplicates.join(", ")}`).toEqual([]);
  });

  it("registers only ids that schema.ts exports", () => {
    const exported = new Set(exportedIds.map(({ id }) => id));
    const unexpected = registeredIds().filter((id) => !exported.has(id));

    expect(unexpected, `registered without an exported *_SCHEMA_ID: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("only references registered ids from inside the shared schemas", () => {
    const registered = new Set(registeredIds());
    const dangling = SHARED_SCHEMAS.flatMap((schema) =>
      [...collectRefs(schema)]
        .filter((ref) => !registered.has(refTarget(ref)))
        .map((ref) => `${schema.$id} → ${ref}`),
    );

    expect(dangling, `unregistered $ref: ${dangling.join(", ")}`).toEqual([]);
  });
});

describe("route $refs", () => {
  it("only references registered ids", async () => {
    const { default: Fastify } = await import("fastify");
    const { rootRoutes } = await import("../src/routes/root.js");
    const { statusRoutes } = await import("../src/routes/status.js");
    const { streamRoutes } = await import("../src/routes/streams.js");

    const app = Fastify({ logger: false });
    const routes: RouteOptions[] = [];
    app.addHook("onRoute", (route) => {
      routes.push(route);
    });

    registerSharedSchemas(app);
    // The route modules guard their own addSchema calls with getSchema, so
    // after central registration they must not add anything new. Snapshot
    // the store to check that.
    const before = Object.keys(app.getSchemas()).sort();

    await app.register(rootRoutes({ network: "testnet", contractId: "C123" } as never));
    await app.register(streamRoutes);
    await app.register(statusRoutes);
    await app.ready();

    expect(routes.length).toBeGreaterThan(0);

    const registered = new Set(registeredIds());
    const dangling = routes.flatMap((route) =>
      [...collectRefs(route.schema)]
        .filter((ref) => !registered.has(refTarget(ref)))
        .map((ref) => `${String(route.method)} ${route.url} → ${ref}`),
    );
    const after = Object.keys(app.getSchemas()).sort();
    await app.close();

    expect(dangling, `routes reference unregistered ids: ${dangling.join(", ")}`).toEqual([]);
    expect(after, "route modules registered schemas missing from registerSharedSchemas").toEqual(before);
  });
});
