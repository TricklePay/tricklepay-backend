import { describe, expect, it } from "vitest";

import { ifNoneMatchMatches, strongEtag, weakEtagFromBody } from "../../src/lib/etag.js";

describe("strongEtag", () => {
  it("quotes a single part", () => {
    expect(strongEtag(200)).toBe('"200"');
  });

  it("joins several parts with hyphens", () => {
    expect(strongEtag(200, "schedule", 50)).toBe('"200-schedule-50"');
    expect(strongEtag(200, 1735689600n)).toBe('"200-1735689600"');
  });
});

describe("weakEtagFromBody", () => {
  it("returns a weak sha256 tag", () => {
    expect(weakEtagFromBody({ a: 1 })).toMatch(/^W\/"[0-9a-f]{64}"$/);
  });

  it("is stable for equal bodies and changes with the body", () => {
    expect(weakEtagFromBody({ a: 1 })).toBe(weakEtagFromBody({ a: 1 }));
    expect(weakEtagFromBody({ a: 1 })).not.toBe(weakEtagFromBody({ a: 2 }));
  });
});

describe("ifNoneMatchMatches", () => {
  const strong = '"200"';
  const weak = 'W/"abc"';

  it("is false when the header is absent", () => {
    expect(ifNoneMatchMatches(undefined, strong)).toBe(false);
  });

  it("matches an identical tag", () => {
    expect(ifNoneMatchMatches('"200"', strong)).toBe(true);
    expect(ifNoneMatchMatches('W/"abc"', weak)).toBe(true);
  });

  it("uses weak comparison: weak and strong forms of the same value match", () => {
    expect(ifNoneMatchMatches('W/"200"', strong)).toBe(true);
    expect(ifNoneMatchMatches('"abc"', weak)).toBe(true);
  });

  it("matches * regardless of the current tag", () => {
    expect(ifNoneMatchMatches("*", strong)).toBe(true);
    expect(ifNoneMatchMatches(" * ", weak)).toBe(true);
  });

  it("matches when any element of a list matches", () => {
    expect(ifNoneMatchMatches('W/"a", W/"b", "200"', strong)).toBe(true);
    expect(ifNoneMatchMatches('"x","200"', strong)).toBe(true);
    expect(ifNoneMatchMatches('W/"a", W/"abc"', weak)).toBe(true);
  });

  it("does not match a list whose elements all differ", () => {
    expect(ifNoneMatchMatches('W/"a", W/"b"', strong)).toBe(false);
  });

  it("treats a comma inside quotes as part of the opaque value", () => {
    expect(ifNoneMatchMatches('"2,00"', strong)).toBe(false);
    expect(ifNoneMatchMatches('"2,00"', '"2,00"')).toBe(true);
  });

  it("joins repeated header values into one list", () => {
    expect(ifNoneMatchMatches(['"x"', '"200"'], strong)).toBe(true);
  });

  it("ignores malformed elements and never matches on them", () => {
    expect(ifNoneMatchMatches("200", strong)).toBe(false);
    expect(ifNoneMatchMatches("not-a-valid-etag", strong)).toBe(false);
    expect(ifNoneMatchMatches('w/"200"', strong)).toBe(false);
    expect(ifNoneMatchMatches('garbage, "200"', strong)).toBe(true);
  });

  it("does not treat * inside a list as a wildcard", () => {
    expect(ifNoneMatchMatches('"x", *', strong)).toBe(false);
  });

  it("does not match an empty header", () => {
    expect(ifNoneMatchMatches("", strong)).toBe(false);
  });
});
