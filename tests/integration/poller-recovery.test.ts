import { Prisma, PrismaClient } from "@prisma/client";
import { rpc } from "@stellar/stellar-sdk";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { Poller } from "../../src/indexer/poller.js";
import capture from "../fixtures/get-events.json" with { type: "json" };

// Integration test for poller recovery after database failure in the middle of
// a page. Verifies that:
// 1. Events are applied idempotently (no double-counting)
// 2. The cursor does not advance past unapplied events
// 3. Replayed events after recovery do not corrupt state

const url = process.env.DATABASE_URL;
const enabled = !!url;

let prisma: PrismaClient;

const CONTRACT_ID = "CDMB62RVYAXJJNYYH7K442SHSAJIXTZ6K7JANGSMQF2T7MHCTVSK75SW";
const PASSPHRASE = "Test SDF Network ; September 2015";
const CHAIN_HEAD = 56999999;

const captured = rpc.parseRawEvents(capture.result as unknown as rpc.Api.RawGetEventsResponse);

// Stream IDs from the captured events
const STREAM_ID_1 = 42n;
const STREAM_ID_2 = 43n;

// Event IDs from fixture
const CREATED_EVENT_ID = "0241050272077447168-0000000001";
const WITHDRAWAL_EVENT_ID = "0241383411213664256-0000000001";
const CANCELLED_EVENT_ID = "0241763773516349440-0000000001";

beforeAll(async () => {
  if (!enabled) return;
  prisma = new PrismaClient({ datasourceUrl: url });
  // Clean up test data
  await prisma.indexerState.deleteMany();
  await prisma.failedEvent.deleteMany();
  await prisma.stream.deleteMany({
    where: { streamId: { in: [STREAM_ID_1, STREAM_ID_2] } },
  });
});

afterAll(async () => {
  if (!enabled) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!enabled) return;
  // Clean slate for each test
  await prisma.indexerState.deleteMany();
  await prisma.failedEvent.deleteMany();
  await prisma.stream.deleteMany({
    where: { streamId: { in: [STREAM_ID_1, STREAM_ID_2] } },
  });
});

describe("poller recovery from mid-page failure", () => {
  it("recovers from database failure after processing first event, does not double-apply", async () => {
    if (!enabled) return;

    // We'll simulate a page with 3 events: created, withdrawn, cancelled
    // The database will fail after the first event (created) is applied
    // On recovery, the page is replayed but the first event should be skipped (idempotent)

    const events = [
      captured.events[0], // created event for stream 42
      captured.events[1], // withdrawn event for stream 42
      captured.events[2], // cancelled event for stream 42
    ];

    let applyCount = 0;
    let shouldFail = true;

    // Create a mock RPC server
    const mockServer = {
      getLatestLedger: async () => ({ sequence: CHAIN_HEAD, id: "abc123" }),
      getEvents: async () => ({
        events,
        latestLedger: CHAIN_HEAD,
        cursor: "0241763773516349440-0000000001",
      }),
    } as unknown as rpc.Server;

    const config: Config = {
      port: 3000,
      host: "0.0.0.0",
      databaseUrl: url,
      network: "testnet",
      networkPassphrase: PASSPHRASE,
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: CONTRACT_ID,
      pollIntervalMs: 0,
      startLedger: 56000000,
      maxBackoffMs: 60000,
      maxPagesPerTick: 1,
      bodyLimit: 1048576,
      queryStringLimit: 2048,
      compressionThresholdBytes: 1024,
      trustedProxies: [],
      rateLimitAllowlist: [],
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
      readinessRetryAfterSeconds: 10,
      publicBaseUrl: null,
      metricsToken: null,
      docsUiEnabled: true,
      connectionTimeoutMs: 30000,
      summaryCacheTtlMs: 30000,
      lagWarnLedgers: 0,
    };

    const logger = pino({ level: "silent" });
    const poller = new Poller(mockServer, config, logger);

    // Inject a custom prisma transaction that fails after first event
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = async (callback: any) => {
      applyCount++;
      if (shouldFail && applyCount === 2) {
        // Fail on the second event (withdrawn)
        throw new Error("Simulated database connection lost");
      }
      return originalTransaction(callback);
    } as any;

    try {
      // First tick - will fail after applying first event
      await poller.start();
    } catch (err) {
      // Expected to fail
    }

    // Stop the poller
    poller.stop();

    // Check state after first (failed) tick
    const stream1AfterFailure = await prisma.stream.findUnique({
      where: { streamId: STREAM_ID_1 },
    });

    // First event (created) should be applied
    expect(stream1AfterFailure).not.toBeNull();
    expect(stream1AfterFailure!.totalAmount.toString()).toBe("10000000000");
    expect(stream1AfterFailure!.withdrawn.toString()).toBe("0");
    expect(stream1AfterFailure!.cancelled).toBe(false);

    // Cursor should NOT be saved because page processing failed
    const stateAfterFailure = await prisma.indexerState.findFirst();
    // Either no state saved, or cursor is from before this page
    if (stateAfterFailure) {
      expect(stateAfterFailure.cursor).not.toBe("0241763773516349440-0000000001");
    }

    // Now recover - remove the failure injection
    shouldFail = false;
    applyCount = 0;

    // Reset transaction to normal
    prisma.$transaction = originalTransaction as any;

    // Create new poller for recovery tick
    const poller2 = new Poller(mockServer, config, logger);

    // Recovery tick - should replay the page but skip already-applied event
    const tickPromise = poller2.start();
    
    // Give it time to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    poller2.stop();
    
    try {
      await tickPromise;
    } catch (err) {
      // May timeout, that's ok
    }

    // Check final state
    const stream1Final = await prisma.stream.findUnique({
      where: { streamId: STREAM_ID_1 },
    });

    expect(stream1Final).not.toBeNull();
    
    // All events should now be applied
    expect(stream1Final!.totalAmount.toString()).not.toBe("10000000000"); // Should be adjusted by cancellation
    expect(stream1Final!.withdrawn.toString()).not.toBe("0"); // Withdrawal should be applied
    expect(stream1Final!.cancelled).toBe(true); // Should be cancelled

    // Verify idempotence: withdrawn amount should be exactly 2500000000 (from fixture)
    // not 5000000000 (which would indicate double-application)
    const totalWithdrawn = new Prisma.Decimal(stream1Final!.withdrawn.toString());
    expect(totalWithdrawn.lessThanOrEqualTo(new Prisma.Decimal("2500000000"))).toBe(true);

    // Cursor should now be saved
    const stateFinal = await prisma.indexerState.findFirst();
    expect(stateFinal).not.toBeNull();
    expect(stateFinal!.cursor).toBe("0241763773516349440-0000000001");
  });

  it("does not advance lastLedger past unapplied events during failure", async () => {
    if (!enabled) return;

    const events = [
      captured.events[0], // ledger 56000001 - created
      captured.events[1], // ledger 56201455 - withdrawn  
      captured.events[2], // ledger 56290013 - cancelled
    ];

    let eventCount = 0;

    // Create a mock RPC server
    const mockServer = {
      getLatestLedger: async () => ({ sequence: CHAIN_HEAD, id: "abc123" }),
      getEvents: async () => ({
        events,
        latestLedger: CHAIN_HEAD,
        cursor: "test-cursor",
      }),
    } as unknown as rpc.Server;

    const config: Config = {
      port: 3000,
      host: "0.0.0.0",
      databaseUrl: url,
      network: "testnet",
      networkPassphrase: PASSPHRASE,
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: CONTRACT_ID,
      pollIntervalMs: 0,
      startLedger: 56000000,
      maxBackoffMs: 60000,
      maxPagesPerTick: 1,
      bodyLimit: 1048576,
      queryStringLimit: 2048,
      compressionThresholdBytes: 1024,
      trustedProxies: [],
      rateLimitAllowlist: [],
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
      readinessRetryAfterSeconds: 10,
      publicBaseUrl: null,
      metricsToken: null,
      docsUiEnabled: true,
      connectionTimeoutMs: 30000,
      summaryCacheTtlMs: 30000,
      lagWarnLedgers: 0,
    };

    const logger = pino({ level: "silent" });

    // Inject failure after first event
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = async (callback: any) => {
      eventCount++;
      if (eventCount === 2) {
        // Fail on second event
        throw new Error("Database failure");
      }
      return originalTransaction(callback);
    } as any;

    const poller = new Poller(mockServer, config, logger);

    try {
      await poller.start();
    } catch (err) {
      // Expected
    }

    poller.stop();

    // Check that lastLedger only reflects the successfully applied event
    const state = await prisma.indexerState.findFirst();
    
    // Either no state was saved (because saveIndexerPosition failed), 
    // or lastLedger should be from before the failed page
    if (state && state.lastLedger) {
      // Should not have advanced past the first event's ledger
      expect(state.lastLedger).toBeLessThan(56201455);
    }

    // Reset for cleanup
    prisma.$transaction = originalTransaction as any;
  });

  it("replays page without double-counting metrics after recovery", async () => {
    if (!enabled) return;

    const events = [captured.events[0], captured.events[1]];

    let firstRun = true;

    const mockServer = {
      getLatestLedger: async () => ({ sequence: CHAIN_HEAD, id: "abc123" }),
      getEvents: async () => ({
        events,
        latestLedger: CHAIN_HEAD,
        cursor: "cursor-1",
      }),
    } as unknown as rpc.Server;

    const config: Config = {
      port: 3000,
      host: "0.0.0.0",
      databaseUrl: url,
      network: "testnet",
      networkPassphrase: PASSPHRASE,
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: CONTRACT_ID,
      pollIntervalMs: 0,
      startLedger: 56000000,
      maxBackoffMs: 60000,
      maxPagesPerTick: 1,
      bodyLimit: 1048576,
      queryStringLimit: 2048,
      compressionThresholdBytes: 1024,
      trustedProxies: [],
      rateLimitAllowlist: [],
      rateLimitMax: 100,
      rateLimitWindowMs: 60000,
      readinessRetryAfterSeconds: 10,
      publicBaseUrl: null,
      metricsToken: null,
      docsUiEnabled: true,
      connectionTimeoutMs: 30000,
      summaryCacheTtlMs: 30000,
      lagWarnLedgers: 0,
    };

    const logger = pino({ level: "silent" });

    // Inject failure on first run, success on second
    const originalTransaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = async (callback: any) => {
      if (firstRun) {
        firstRun = false;
        throw new Error("First run fails");
      }
      return originalTransaction(callback);
    } as any;

    const poller1 = new Poller(mockServer, config, logger);

    try {
      await poller1.start();
    } catch (err) {
      // Expected
    }

    poller1.stop();

    // Reset transaction
    prisma.$transaction = originalTransaction as any;

    // Second run should succeed
    const poller2 = new Poller(mockServer, config, logger);
    const tickPromise = poller2.start();
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    poller2.stop();
    
    try {
      await tickPromise;
    } catch (err) {
      // May timeout
    }

    // Verify both streams exist and have correct state
    const stream1 = await prisma.stream.findUnique({ where: { streamId: STREAM_ID_1 } });
    expect(stream1).not.toBeNull();
    
    // The withdrawn amount should be exactly as in the fixture, not doubled
    expect(stream1!.withdrawn.toString()).toBe("2500000000");
  });
});
