import type {
  ArgumentsHost} from '@nestjs/common';
import {
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppException } from '../errors/app.exception';
import type { AppLogger } from '../logger/app-logger';
import type { ApiErrorDetail } from '@raft-lite/contracts';

interface ErrorPayload {
  status: number;
  code: string;
  message: string;
  details: ApiErrorDetail[] | Record<string, unknown> | null;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';
    const payload = this.normalize(exception);

    this.logger.error({
      eventType: 'http.error',
      message: payload.message,
      status: payload.status,
      requestId,
      path: request.url,
      method: request.method,
      error: exception instanceof Error ? exception.message : String(exception),
    });

    response.status(payload.status).json({
      error: {
        code: payload.code,
        message: payload.message,
        details: payload.details,
      },
      requestId,
    });
  }

  private normalize(exception: unknown): ErrorPayload {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: exception.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        })),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2025') {
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'NOT_FOUND',
          message: 'Resource not found',
          details: null,
        };
      }
      if (exception.code === 'P2002') {
        return {
          status: HttpStatus.CONFLICT,
          code: 'CONFLICT',
          message: 'A resource with those values already exists',
          details: null,
        };
      }
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null) {
        const record = body as Record<string, unknown>;
        return {
          status,
          code: typeof record.code === 'string' ? record.code : 'HTTP_ERROR',
          message:
            typeof record.message === 'string'
              ? record.message
              : Array.isArray(record.message)
                ? record.message.join(', ')
                : exception.message,
          details: (record.details as ErrorPayload['details']) ?? null,
        };
      }
      return {
        status,
        code: 'HTTP_ERROR',
        message: exception.message,
        details: null,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
      details: null,
    };
  }
}
