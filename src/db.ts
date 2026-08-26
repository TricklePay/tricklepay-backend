import { PrismaClient } from "@prisma/client";

// A single Prisma client shared across the process. Each new client opens its
// own connection pool, so every module imports this one instance rather than
// constructing its own.
export const prisma = new PrismaClient();

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export async function checkHealth(timeoutMs = 5000): Promise<{ status: "up" | "down"; error?: string }> {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return { status: "up" };
  } catch (err: unknown) {
    const error = err instanceof Error && err.message === "timeout" ? "timeout" : "database unavailable";
    return { status: "down", error };
  }
}
