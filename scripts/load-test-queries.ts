#!/usr/bin/env tsx
/**
 * Load test for stream list endpoint query performance on a large table.
 *
 * This script:
 * 1. Seeds the database with 100,000 streams across multiple tokens and addresses
 * 2. Measures p50, p95, and p99 query latencies for:
 *    - Unfiltered list query
 *    - Filtered list by sender
 *    - Filtered list by token
 *    - Cursor-based pagination
 *    - Account summary aggregation
 * 3. Records results with PostgreSQL version and system info
 *
 * Run with: npm run load-test
 */

import { PrismaClient, Prisma } from "@prisma/client";
import { performance } from "perf_hooks";

const prisma = new PrismaClient();

// Configuration
const TOTAL_STREAMS = 100_000;
const BATCH_SIZE = 1000;
const WARMUP_QUERIES = 10;
const BENCHMARK_QUERIES = 100;

// Addresses and tokens for diversity
const SENDERS = Array.from({ length: 100 }, (_, i) =>
  `SENDER${String(i).padStart(3, "0")}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
);
const RECIPIENTS = Array.from({ length: 100 }, (_, i) =>
  `RECIP${String(i).padStart(3, "0")}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
);
const TOKENS = Array.from({ length: 10 }, (_, i) =>
  `TOKEN${String(i).padStart(2, "0")}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
);

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBigInt(min: bigint, max: bigint): bigint {
  const range = max - min;
  const randomValue = BigInt(Math.floor(Math.random() * Number(range)));
  return min + randomValue;
}

async function getDatabaseInfo(): Promise<string> {
  const result = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
  return result[0].version;
}

async function clearStreams(): Promise<void> {
  console.log("Clearing existing streams...");
  await prisma.stream.deleteMany({});
  console.log("Database cleared.");
}

async function seedStreams(count: number): Promise<void> {
  console.log(`Seeding ${count.toLocaleString()} streams...`);
  const startTime = performance.now();

  const now = BigInt(Math.floor(Date.now() / 1000));
  const oneYear = BigInt(365 * 24 * 60 * 60);

  for (let batch = 0; batch < count / BATCH_SIZE; batch++) {
    const streams: Array<Prisma.StreamCreateManyInput> = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
      const streamId = BigInt(batch * BATCH_SIZE + i + 1);
      const sender = randomElement(SENDERS);
      const recipient = randomElement(RECIPIENTS);
      const token = randomElement(TOKENS);
      const totalAmount = randomBigInt(1_000_000n, 1_000_000_000_000n);
      const withdrawn = randomBigInt(0n, totalAmount / 2n);
      const startTime = now - randomBigInt(0n, oneYear);
      const endTime = startTime + randomBigInt(oneYear / 4n, oneYear);
      const cliffTime = randomBigInt(startTime, endTime);
      const cancelled = Math.random() < 0.1; // 10% cancelled

      streams.push({
        streamId,
        sender,
        recipient,
        token,
        totalAmount: new Prisma.Decimal(totalAmount.toString()),
        withdrawn: new Prisma.Decimal(withdrawn.toString()),
        startTime,
        endTime,
        cliffTime,
        cancelled,
        createdLedger: 1000000 + batch,
        updatedLedger: 1000000 + batch,
        lastEventId: `event-${streamId}`,
      });
    }

    await prisma.stream.createMany({ data: streams });

    if ((batch + 1) % 10 === 0) {
      const progress = ((batch + 1) * BATCH_SIZE).toLocaleString();
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${progress} streams seeded (${elapsed}s)`);
    }
  }

  const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding completed in ${totalTime}s\n`);
}

async function measureQuery(
  name: string,
  queryFn: () => Promise<unknown>
): Promise<number[]> {
  const timings: number[] = [];

  // Warmup
  for (let i = 0; i < WARMUP_QUERIES; i++) {
    await queryFn();
  }

  // Benchmark
  for (let i = 0; i < BENCHMARK_QUERIES; i++) {
    const start = performance.now();
    await queryFn();
    const duration = performance.now() - start;
    timings.push(duration);
  }

  return timings;
}

function calculatePercentiles(timings: number[]): {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
} {
  const sorted = timings.slice().sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  return { p50, p95, p99, min, max };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

async function runBenchmarks(): Promise<void> {
  console.log("Running benchmarks...\n");

  // 1. Unfiltered list
  console.log("1. Unfiltered list (limit 50, first page)");
  const unfilteredTimings = await measureQuery("unfiltered", () =>
    prisma.stream.findMany({ take: 50, orderBy: { streamId: "desc" } })
  );
  const unfilteredStats = calculatePercentiles(unfilteredTimings);
  console.log(`   p50: ${formatMs(unfilteredStats.p50)}`);
  console.log(`   p95: ${formatMs(unfilteredStats.p95)}`);
  console.log(`   p99: ${formatMs(unfilteredStats.p99)}`);
  console.log();

  // 2. Filtered by sender
  const testSender = SENDERS[0];
  console.log("2. Filtered by sender");
  const senderTimings = await measureQuery("sender", () =>
    prisma.stream.findMany({
      where: { sender: testSender },
      take: 50,
      orderBy: [{ sender: "asc" }, { streamId: "desc" }],
    })
  );
  const senderStats = calculatePercentiles(senderTimings);
  console.log(`   p50: ${formatMs(senderStats.p50)}`);
  console.log(`   p95: ${formatMs(senderStats.p95)}`);
  console.log(`   p99: ${formatMs(senderStats.p99)}`);
  console.log();

  // 3. Filtered by token
  const testToken = TOKENS[0];
  console.log("3. Filtered by token");
  const tokenTimings = await measureQuery("token", () =>
    prisma.stream.findMany({
      where: { token: testToken },
      take: 50,
      orderBy: [{ token: "asc" }, { streamId: "desc" }],
    })
  );
  const tokenStats = calculatePercentiles(tokenTimings);
  console.log(`   p50: ${formatMs(tokenStats.p50)}`);
  console.log(`   p95: ${formatMs(tokenStats.p95)}`);
  console.log(`   p99: ${formatMs(tokenStats.p99)}`);
  console.log();

  // 4. Cursor-based pagination (deep page)
  console.log("4. Cursor-based pagination (page at cursor 50,000)");
  const cursorTimings = await measureQuery("cursor", () =>
    prisma.stream.findMany({
      where: { streamId: { lt: 50_000n } },
      take: 50,
      orderBy: { streamId: "desc" },
    })
  );
  const cursorStats = calculatePercentiles(cursorTimings);
  console.log(`   p50: ${formatMs(cursorStats.p50)}`);
  console.log(`   p95: ${formatMs(cursorStats.p95)}`);
  console.log(`   p99: ${formatMs(cursorStats.p99)}`);
  console.log();

  // 5. Account summary aggregation
  const testAccount = RECIPIENTS[0];
  console.log("5. Account summary (aggregation)");
  const summaryTimings = await measureQuery("summary", async () => {
    const [incoming, outgoing] = await Promise.all([
      prisma.stream.aggregate({
        where: { recipient: testAccount },
        _count: { streamId: true },
        _sum: { totalAmount: true, withdrawn: true },
      }),
      prisma.stream.aggregate({
        where: { sender: testAccount },
        _count: { streamId: true },
        _sum: { totalAmount: true, withdrawn: true },
      }),
    ]);
    return { incoming, outgoing };
  });
  const summaryStats = calculatePercentiles(summaryTimings);
  console.log(`   p50: ${formatMs(summaryStats.p50)}`);
  console.log(`   p95: ${formatMs(summaryStats.p95)}`);
  console.log(`   p99: ${formatMs(summaryStats.p99)}`);
  console.log();
}

async function recordResults(): Promise<void> {
  const dbVersion = await getDatabaseInfo();
  const totalStreams = await prisma.stream.count();

  console.log("=".repeat(60));
  console.log("LOAD TEST RESULTS");
  console.log("=".repeat(60));
  console.log(`Database: ${dbVersion}`);
  console.log(`Total streams: ${totalStreams.toLocaleString()}`);
  console.log(`Warmup queries: ${WARMUP_QUERIES}`);
  console.log(`Benchmark queries: ${BENCHMARK_QUERIES}`);
  console.log();
  console.log("Advisory performance thresholds (not enforced in CI):");
  console.log("  - Unfiltered list p95: < 50ms");
  console.log("  - Filtered list p95: < 100ms");
  console.log("  - Cursor pagination p95: < 50ms");
  console.log("  - Account summary p95: < 200ms");
  console.log();
  console.log("If queries exceed these thresholds, check for missing indexes.");
  console.log("=".repeat(60));
}

async function main(): Promise<void> {
  console.log("Stream List Endpoint Load Test");
  console.log("=".repeat(60));
  console.log();

  try {
    const dbVersion = await getDatabaseInfo();
    console.log(`Connected to: ${dbVersion}\n`);

    await clearStreams();
    await seedStreams(TOTAL_STREAMS);
    await runBenchmarks();
    await recordResults();
  } catch (error) {
    console.error("Error during load test:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
