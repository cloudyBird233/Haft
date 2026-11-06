import { PrismaClient } from '@prisma/client';
import { initializeDemoData } from '../src/common/seed/demo-data';

const prisma = new PrismaClient();

async function main() {
  await initializeDemoData(prisma, 'default');
  console.log('Demo data seeded.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
