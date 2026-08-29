import { describe, expect, it } from "vitest";
import { Counter, renderMetrics } from "../src/metrics.js";

describe("Counter", () => {
  it("increments independently for different label sets", () => {
    const counter = new Counter("test_counter", "A test counter", ["label"]);
    counter.inc({ label: "a" }, 1);
    counter.inc({ label: "b" }, 2);
    counter.inc({ label: "a" }, 3);

    const output = renderMetrics();
    // One sample per label set
    expect(output).toContain('test_counter_total{label="a"} 4');
    expect(output).toContain('test_counter_total{label="b"} 2');
  });
});
