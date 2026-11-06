import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';
import type { ApiErrorDetail } from '@raft-lite/contracts';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        const details: ApiErrorDetail[] = error.issues.map((issue) => ({
          path: issue.path.join('.') || 'root',
          message: issue.message,
        }));
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
        });
      }
      throw error;
    }
  }
}
