import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AppLogger } from '../logger/app-logger';

export function requestContext(logger: AppLogger) {
  return (request: Request & { requestId?: string }, response: Response, next: NextFunction): void => {
    const incoming = request.header('x-request-id');
    const requestId = incoming && incoming.length <= 120 ? incoming : randomUUID();
    request.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    const startedAt = Date.now();

    response.on('finish', () => {
      logger.info({
        eventType: 'http.request',
        message: `${request.method} ${request.originalUrl}`,
        requestId,
        method: request.method,
        path: request.originalUrl,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  };
}
