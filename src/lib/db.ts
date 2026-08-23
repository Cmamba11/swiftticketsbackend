import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

async function initPragmas() {
  try {
    const dbUrl = process.env.DATABASE_URL || '';
    if (dbUrl.startsWith('file:') || dbUrl.includes('sqlite')) {
      await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL;');
      await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
      await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL;');
    }
  } catch {
    // Ignore error if not using SQLite
  }
}

initPragmas();
