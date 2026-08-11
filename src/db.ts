import { PrismaClient } from "@prisma/client";

// A single Prisma client shared across the process. Each new client opens its
// own connection pool, so every module imports this one instance rather than
// constructing its own.
export const prisma = new PrismaClient();

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
