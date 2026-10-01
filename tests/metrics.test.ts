import { describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, registerMetric, renderMetrics } from "../src/metrics.js";

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

describe("Histogram", () => {
  it("observations are cumulative across buckets", () => {
    const hist = new Histogram("test_hist", "A test histogram", [], [10, 50, 100]);
    // single observation of 25. Should appear in 50, 100, and +Inf bucket.
    hist.observe({}, 25);

    const output = renderMetrics();
    expect(output).toContain('test_hist_bucket{le="10"} 0');
    expect(output).toContain('test_hist_bucket{le="50"} 1');
    expect(output).toContain('test_hist_bucket{le="100"} 1');
    expect(output).toContain('test_hist_bucket{le="+Inf"} 1');
    expect(output).toContain('test_hist_sum 25');
    expect(output).toContain('test_hist_count 1');
  });
});

describe("registerMetric helper (#367)", () => {
  it("handles collector construction and registration into shared registry", () => {
    registerMetric("test_custom_metric", "A helper-registered metric", "gauge", () => {
      return "# HELP test_custom_metric A helper-registered metric\n# TYPE test_custom_metric gauge\ntest_custom_metric 42";
    });

    const output = renderMetrics();
    expect(output).toContain("test_custom_metric 42");
    expect(output).toContain("# TYPE test_custom_metric gauge");
  });
});

describe("backlog metric tracking failed events", () => {
  it("asserts the gauge rises when a failure is recorded", () => {
    const backlogGauge = new Gauge(
      "tricklepay_failed_events_backlog_rise",
      "Tracks unresolved failed events backlog",
    );
    let failedEventsCount = 0;
    const recordFailure = () => {
      failedEventsCount += 1;
      backlogGauge.set(failedEventsCount);
    };

    backlogGauge.set(failedEventsCount);
    expect(renderMetrics()).toContain("tricklepay_failed_events_backlog_rise 0");

    recordFailure();
    expect(renderMetrics()).toContain("tricklepay_failed_events_backlog_rise 1");

    recordFailure();
    expect(renderMetrics()).toContain("tricklepay_failed_events_backlog_rise 2");
  });

  it("asserts it falls when the record is cleared", () => {
    const backlogGauge = new Gauge(
      "tricklepay_failed_events_backlog_fall",
      "Tracks unresolved failed events backlog",
    );
    let failedEventsCount = 2;
    backlogGauge.set(failedEventsCount);
    expect(renderMetrics()).toContain("tricklepay_failed_events_backlog_fall 2");

    const clearRecord = () => {
      failedEventsCount = Math.max(0, failedEventsCount - 1);
      backlogGauge.set(failedEventsCount);
    };

    clearRecord();
    expect(renderMetrics()).toContain("tricklepay_failed_events_backlog_fall 1");

    clearRecord();
    expect(renderMetrics()).toContain("tricklepay_failed_events_backlog_fall 0");
  });
});

describe("Exposition format", () => {
  it("matches the exposition format for counters, gauges and histograms together", () => {
    // The previous tests have already registered a Counter, Gauge, and Histogram.
    // Generating the metrics output will include all of them.
    const output = renderMetrics();
    const lines = output.split("\n").filter((l) => l.length > 0 && !l.startsWith("#"));
    
    // A valid sample line is: metric_name[{labels}] value [timestamp]
    // The value must be a number or NaN/+Inf/-Inf.
    for (const line of lines) {
      expect(line).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\{[^}]*\})? [-+]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\+Inf|-Inf|NaN)$/);
    }
  });
});



