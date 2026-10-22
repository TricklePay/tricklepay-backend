import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { normalizeAddress } from "../../src/lib/address.js";

// Pure unit tests for the address normalizer — no Fastify instance, no HTTP
// request, no database. It used to be reachable only through the stream
// routes' query-string handling; these exercise it directly.

const ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const CONTRACT = "CBFS2HT4TIHTMWA5ZND6FEC27BRRA4V6JWOD7JIIDZVSPVAM7EJ2LZS7";

describe("normalizeAddress", () => {
  describe("valid account addresses", () => {
    it("accepts the canonical uppercase spelling", () => {
      expect(normalizeAddress(ACCOUNT)).toBe(ACCOUNT);
    });

    it("upper-cases a lowercase spelling", () => {
      expect(normalizeAddress(ACCOUNT.toLowerCase())).toBe(ACCOUNT);
    });

    it("upper-cases a mixed-case spelling", () => {
      const mixed = ACCOUNT.slice(0, 1) + ACCOUNT.slice(1).toLowerCase();
      expect(normalizeAddress(mixed)).toBe(ACCOUNT);
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalizeAddress(`  ${ACCOUNT}  `)).toBe(ACCOUNT);
    });

    it("trims whitespace and upper-cases together", () => {
      expect(normalizeAddress(`\t${ACCOUNT.toLowerCase()}\n`)).toBe(ACCOUNT);
    });
  });

  describe("valid contract addresses", () => {
    it("accepts the canonical uppercase spelling", () => {
      expect(normalizeAddress(CONTRACT)).toBe(CONTRACT);
    });

    it("upper-cases a lowercase spelling", () => {
      expect(normalizeAddress(CONTRACT.toLowerCase())).toBe(CONTRACT);
    });

    it("trims whitespace and upper-cases together", () => {
      expect(normalizeAddress(`  ${CONTRACT.toLowerCase()} `)).toBe(CONTRACT);
    });
  });

  describe("muxed addresses", () => {
    // A muxed (M...) address encodes an account plus an id, but the stream
    // contract never accepts one as a sender, recipient, or token — only
    // plain accounts and contracts. It must fail both checks and come back
    // null rather than being silently accepted as an account.
    // stellar-base encodes a muxed key from the raw 32-byte key followed by the
    // 8-byte big-endian id; the two-argument helper was removed in SDK 13.
    const muxedId = Buffer.alloc(8);
    muxedId.writeBigUInt64BE(12345n);
    const muxed = StrKey.encodeMed25519PublicKey(
      Buffer.concat([StrKey.decodeEd25519PublicKey(ACCOUNT), muxedId]),
    );

    it("rejects a valid muxed address", () => {
      expect(normalizeAddress(muxed)).toBeNull();
    });

    it("rejects a lowercase muxed address", () => {
      expect(normalizeAddress(muxed.toLowerCase())).toBeNull();
    });

    it("rejects a padded muxed address", () => {
      expect(normalizeAddress(`  ${muxed}  `)).toBeNull();
    });
  });

  describe("invalid inputs", () => {
    it("rejects an empty string", () => {
      expect(normalizeAddress("")).toBeNull();
    });

    it("rejects whitespace only", () => {
      expect(normalizeAddress("   ")).toBeNull();
    });

    it("rejects an address one character too short", () => {
      expect(normalizeAddress(ACCOUNT.slice(0, -1))).toBeNull();
    });

    it("rejects an address one character too long", () => {
      expect(normalizeAddress(`${ACCOUNT}A`)).toBeNull();
    });

    it("rejects a contract address one character too short", () => {
      expect(normalizeAddress(CONTRACT.slice(0, -1))).toBeNull();
    });

    it("rejects non-base32 characters (0, 1, 8, 9 are not in the alphabet)", () => {
      expect(normalizeAddress(`G${"0".repeat(ACCOUNT.length - 1)}`)).toBeNull();
    });

    it("rejects a plausible but non-strkey string", () => {
      expect(normalizeAddress("not-an-address")).toBeNull();
    });

    it("rejects a strkey with a corrupted checksum", () => {
      const corrupted = `${ACCOUNT.slice(0, -1)}${ACCOUNT.at(-1) === "A" ? "B" : "A"}`;
      expect(normalizeAddress(corrupted)).toBeNull();
    });

    it("rejects an address with the wrong version byte prefix", () => {
      // 'G' accounts and 'C' contracts are both valid prefixes; 'T' (signed
      // payload) is a real strkey type but not one this normalizer accepts.
      expect(normalizeAddress(`T${ACCOUNT.slice(1)}`)).toBeNull();
    });
  });

  describe("cross-type inputs", () => {
    it("rejects a contract address checked as if it might be an account", () => {
      // Sanity check on the fixture itself: a contract key must not also
      // pass as a valid account key, or this suite would not be testing
      // what it claims to.
      expect(StrKey.isValidEd25519PublicKey(CONTRACT)).toBe(false);
      expect(normalizeAddress(CONTRACT)).toBe(CONTRACT);
    });

    it("rejects an account address checked as if it might be a contract", () => {
      expect(StrKey.isValidContract(ACCOUNT)).toBe(false);
      expect(normalizeAddress(ACCOUNT)).toBe(ACCOUNT);
    });
  });
});
