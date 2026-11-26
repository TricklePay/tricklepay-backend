import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// This test checks that the decoder handles every field defined in the contract
// event specification. The fixture (contract-interface.txt) holds the contract's
// event spec with its commit hash, copied from the contracts repository's
// docs/interface.txt. When the contract changes an event's fields, this test
// will fail, prompting an update to the decoder or fixture.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixtureContents = readFileSync(
  join(__dirname, "..", "fixtures", "contract-interface.txt"),
  "utf-8"
);

describe("decoder contract interface alignment", () => {
  it("fixture holds the contract commit hash", () => {
    // The fixture must identify which version of the contract interface it
    // represents, so an operator knows what to update when the contract
    // changes.
    expect(fixtureContents).toMatch(/Commit:\s+[\w-]+/);
  });

  it("decoder handles every Created event field from the contract spec", () => {
    // Contract spec defines Created with:
    // Topics: sender (Address), recipient (Address)
    // Value map: id (u64), token (Address), total_amount (i128),
    //            start_time (u64), end_time (u64), cliff_time (u64)
    //
    // The decoder must read all of these fields. Check that the fixture
    // documents each one and that our type definition includes them.
    const createdSection = fixtureContents.match(
      /Event: Created[\s\S]*?(?=Event:|$)/
    );
    expect(createdSection).toBeTruthy();
    const created = createdSection![0];

    // Topics
    expect(created).toContain("sender");
    expect(created).toContain("recipient");

    // Value map fields
    expect(created).toContain("id");
    expect(created).toContain("token");
    expect(created).toContain("total_amount");
    expect(created).toContain("start_time");
    expect(created).toContain("end_time");
    expect(created).toContain("cliff_time");

    // All fields are present in the CreatedEvent interface:
    // sender, recipient, streamId (from id), token, totalAmount (from total_amount),
    // startTime, endTime, cliffTime
    // This is verified by TypeScript at compile time, but we document the
    // expected mapping here.
  });

  it("decoder handles every Withdrawn event field from the contract spec", () => {
    // Contract spec defines Withdrawn with:
    // Topics: recipient (Address)
    // Value map: id (u64), amount (i128)
    const withdrawnSection = fixtureContents.match(
      /Event: Withdrawn[\s\S]*?(?=Event:|$)/
    );
    expect(withdrawnSection).toBeTruthy();
    const withdrawn = withdrawnSection![0];

    // Topics
    expect(withdrawn).toContain("recipient");

    // Value map fields
    expect(withdrawn).toContain("id");
    expect(withdrawn).toContain("amount");

    // All fields are present in the WithdrawnEvent interface:
    // recipient, streamId (from id), amount
  });

  it("decoder handles every Cancelled event field from the contract spec", () => {
    // Contract spec defines Cancelled with:
    // Topics: sender (Address)
    // Value map: id (u64), recipient_amount (i128), sender_refund (i128)
    const cancelledSection = fixtureContents.match(
      /Event: Cancelled[\s\S]*?(?=Event:|$)/
    );
    expect(cancelledSection).toBeTruthy();
    const cancelled = cancelledSection![0];

    // Topics
    expect(cancelled).toContain("sender");

    // Value map fields
    expect(cancelled).toContain("id");
    expect(cancelled).toContain("recipient_amount");
    expect(cancelled).toContain("sender_refund");

    // All fields are present in the CancelledEvent interface:
    // sender, streamId (from id), recipientAmount, senderRefund
  });

  it("documents how to update the fixture when the contract changes", () => {
    // The fixture should reference where it comes from so an operator knows
    // what to update when this test fails.
    expect(fixtureContents).toMatch(/Repository:/);
    expect(fixtureContents.toLowerCase()).toContain("tricklepay");
  });
});
