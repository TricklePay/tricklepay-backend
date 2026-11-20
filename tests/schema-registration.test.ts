import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";

import { metricsRoutes } from "../src/routes/metrics.js";
import { rootRoutes } from "../src/routes/root.js";
import { statusRoutes } from "../src/routes/status.js";
import { streamRoutes } from "../src/routes/streams.js";
import * as schemaModule from "../src/schema.js";
import { registerSharedSchemas } from "../src/schema-registration.js";

// Shared schema registration (#713): every `*_SCHEMA_ID` exported from
// `schema.ts` is registered exactly once by `registerSharedSchemas`, and no
// route or shared schema references an id that is not registered. Routes are
// only registered, never called, so no database is needed.

const EXPORTED_IDS = Object.entries(schemaModule)
  .filter(([name]) => name.endsWith("_SCHEMA_ID"))
  .map(([name, value]) => ({ name, id: value as string }));

/** Runs `registerSharedSchemas` on a bare instance and records each `$id`. */
function registeredIds(): string[] {
  const app = Fastify({ logger: false });
  const ids: string[] = [];
  const addSchema = app.addSchema.bind(app);
  app.addSchema = (schema: { $id?: string }) => {
    ids.push(String(schema.$id));
    return addSchema(schema);
  };
  registerSharedSchemas(app);
  return ids;
}

/** Collects every string `$ref` anywhere inside `value`. */
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

/** `$ref` may point inside a schema (`Id#/properties/x`); compare the id part. */
function refId(ref: string): string {
  return ref.split("#")[0];
}

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
}

describe("shared schema registration", () => {
  it("enumerates the exported schema ids", () => {
    // Guards against the filter silently matching nothing.
    expect(EXPORTED_IDS.length).toBeGreaterThan(0);
    for (const { name, id } of EXPORTED_IDS) {
      expect(typeof id, `${name} should be a string`).toBe("string");
    }
    expect(duplicates(EXPORTED_IDS.map(({ id }) => id)), "exported ids must be unique").toEqual([]);
  });

  it.each(EXPORTED_IDS)("registers $name ($id) exactly once", ({ id }) => {
    const ids = registeredIds();
    const count = ids.filter((registered) => registered === id).length;
    expect(count, `schema id "${id}" registered ${count} times`).toBe(1);
  });

  it("registers only exported ids, with no duplicates", () => {
    const ids = registeredIds();
    const exported = new Set(EXPORTED_IDS.map(({ id }) => id));
    expect(duplicates(ids), "duplicate schema ids").toEqual([]);
    expect(ids.filter((id) => !exported.has(id)), "registered ids not exported from schema.ts").toEqual([]);
  });

  it("shared schemas reference only registered ids", () => {
    const registered = new Set(registeredIds());
    const app = Fastify({ logger: false });
    registerSharedSchemas(app);
    const missing = [...collectRefs(Object.values(app.getSchemas()))]
      .map(refId)
      .filter((id) => id !== "" && !registered.has(id));
    expect(missing, "unregistered ids referenced by shared schemas").toEqual([]);
  });

  it("routes reference only registered ids", async () => {
    const registered = new Set(registeredIds());
    const app: FastifyInstance = Fastify({ logger: false });
    registerSharedSchemas(app);

    const refsByRoute = new Map<string, Set<string>>();
    app.addHook("onRoute", (route: RouteOptions) => {
      refsByRoute.set(`${String(route.method)} ${route.url}`, collectRefs(route.schema));
    });

    await app.register(rootRoutes({ network: "testnet", contractId: "C123" } as never));
    await app.register(streamRoutes);
    await app.register(statusRoutes);
    await app.register(metricsRoutes, {});
    await app.ready();
    await app.close();

    expect(refsByRoute.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [route, refs] of refsByRoute) {
      for (const ref of refs) {
        const id = refId(ref);
        if (id !== "" && !registered.has(id)) missing.push(`${route} → ${id}`);
      }
    }
    expect(missing, "routes referencing unregistered schema ids").toEqual([]);
  });
});
