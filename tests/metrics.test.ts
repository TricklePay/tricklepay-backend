import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, renderMetrics } from "../src/metrics.js";

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

describe("Gauge", () => {
  it("reports the most recently set value", () => {
    const gauge = new Gauge("test_gauge", "A test gauge", ["label"]);
    gauge.set({ label: "a" }, 10);
    gauge.set({ label: "a" }, 20); // set more than once

    const output = renderMetrics();
    expect(output).toContain('test_gauge{label="a"} 20');
    expect(output).not.toContain('test_gauge{label="a"} 10');
  });
});

