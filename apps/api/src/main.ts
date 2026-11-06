import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      eventType: 'api.started',
      message: `Raft Lite API listening on http://${host}:${port}`,
      status: 'ready',
      testMode: process.env.E2E_TEST_MODE === 'true',
    }),
  );
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
