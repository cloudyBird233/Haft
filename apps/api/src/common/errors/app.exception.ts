import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorDetail } from '@raft-lite/contracts';

export class AppException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details: ApiErrorDetail[] | Record<string, unknown> | null = null,
  ) {
    super(message, status);
  }
}
