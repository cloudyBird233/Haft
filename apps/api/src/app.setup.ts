import { type INestApplication, RequestMethod } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppLogger } from './common/logger/app-logger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { requestContext } from './common/middleware/request-context';

export function configureApp(app: INestApplication): void {
  const logger = app.get(AppLogger);
  app.use(requestContext(logger));
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.setGlobalPrefix('api', {
    exclude: [{ path: '__test__/(.*)', method: RequestMethod.ALL }],
  });

  const configuredOrigins = process.env.WEB_ORIGIN?.split(',')
    ?.map((origin) => origin.trim())
    .filter(Boolean);
  const origins =
    configuredOrigins && configuredOrigins.length > 0
      ? configuredOrigins
      : [
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:5174',
          'http://127.0.0.1:5174',
        ];
  app.enableCors({
    origin: origins,
    credentials: true,
  });
  app.enableShutdownHooks();
  const instance = app.getHttpAdapter().getInstance() as { disable: (header: string) => void };
  instance.disable('x-powered-by');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Raft Lite API')
    .setDescription(
      'REST API for managing agents, tasks, mock executions, activity history, and workspace dashboards.',
    )
    .setVersion('0.1.0')
    .addServer('/api')
    .addTag('health')
    .addTag('workspace')
    .addTag('agents')
    .addTag('tasks')
    .addTag('executions')
    .addTag('activities')
    .addTag('computers')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    customSiteTitle: 'Raft Lite API Docs',
  });
}
