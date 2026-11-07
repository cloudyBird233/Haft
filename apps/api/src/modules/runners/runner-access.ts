import { timingSafeEqual } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { AppException } from '../../common/errors/app.exception';

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

/**
 * Runner management is local-only by default. When an admin token is
 * configured it must be presented explicitly; otherwise only loopback requests
 * are accepted. Pairing itself is authenticated with the bootstrap token.
 */
export function assertRunnerAdminAccess(request: Request): void {
  const configured = process.env.HAFT_RUNNER_ADMIN_TOKEN?.trim();
  if (configured) {
    const supplied = request.header('x-haft-admin-token') ?? '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppException(
        'RUNNER_ADMIN_FORBIDDEN',
        'A valid x-haft-admin-token header is required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return;
  }

  const remote = request.ip ?? request.socket?.remoteAddress;
  if (!isLoopback(remote)) {
    throw new AppException(
      'RUNNER_ADMIN_FORBIDDEN',
      'Runner management is restricted to the local machine',
      HttpStatus.FORBIDDEN,
    );
  }
}
