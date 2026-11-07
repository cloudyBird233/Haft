import { randomUUID } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import {
  RUNNER_PROTOCOL_VERSION,
  runnerHandshakeSchema,
  runnerInboundMessageSchema,
  type RunnerEnvelope,
} from '@raft-lite/contracts';
import { AppException } from '../../common/errors/app.exception';
import { AppLogger } from '../../common/logger/app-logger';
import {
  RunnerRegistryService,
  type RunnerHandshakeResult,
  type RunnerTransport,
} from './runner-registry.service';

const allowedOrigins = (): string[] | true => {
  const origins = process.env.WEB_ORIGIN?.split(',').map((origin) => origin.trim());
  return origins && origins.length > 0 ? origins : true;
};

/**
 * Socket.IO transport for the runner protocol.
 *
 * Authentication runs as Socket.IO middleware so no application message can
 * arrive before the runner identity is established. This gateway only moves
 * validated envelopes; business state remains in the API and database.
 */
@WebSocketGateway({
  namespace: '/runner',
  cors: { origin: allowedOrigins(), credentials: true },
  maxHttpBufferSize: 2 * 1024 * 1024,
})
export class RunnerGateway
  implements RunnerTransport, OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private readonly sockets = new Map<string, Socket>();
  private readonly messageQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly runners: RunnerRegistryService,
    private readonly logger: AppLogger,
  ) {}

  afterInit(server: Server): void {
    this.runners.setTransport(this);
    server.use((socket, next) => {
      void this.authenticateSocket(socket)
        .then(() => next())
        .catch((error: unknown) => {
          const appError = error instanceof AppException ? error : null;
          const code = appError?.code ?? 'RUNNER_AUTH_FAILED';
          const message = appError?.message ?? 'Runner authentication failed';
          this.logger.warn({
            eventType: 'runner.connection_rejected',
            message: 'Runner connection rejected',
            status: 'warning',
            error: code,
          });
          const connectError = new Error(`${code}: ${message}`) as Error & {
            data?: { code: string; message: string };
          };
          connectError.data = { code, message };
          next(connectError);
        });
    });
  }

  handleConnection(client: Socket): void {
    const handshake = client.data.handshake as RunnerHandshakeResult | undefined;
    if (!handshake) {
      client.disconnect(true);
      return;
    }

    const previous = this.sockets.get(handshake.runnerId);
    if (previous && previous.id !== client.id) {
      previous.emit(
        'runner.message',
        this.envelope(handshake.runnerId, 'runner.error', {
          code: 'RUNNER_REPLACED',
          message: 'Another runner connection replaced this one',
          fatal: true,
        }),
      );
      previous.disconnect(true);
    }

    client.data.runnerId = handshake.runnerId;
    client.data.computerId = handshake.computerId;
    this.sockets.set(handshake.runnerId, client);
    void client.join(`runner:${handshake.runnerId}`);
    void this.runners
      .markConnected({
        runnerId: handshake.runnerId,
        computerId: handshake.computerId,
        socketId: client.id,
      })
      .catch((error: unknown) => {
        this.logger.error({
          eventType: 'runner.connect_failed',
          message: 'Failed to persist runner connection state',
          runnerId: handshake.runnerId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });

    this.send(
      handshake.runnerId,
      this.envelope(handshake.runnerId, 'runner.welcome', {
        issuedToken: handshake.issuedToken,
        serverTime: new Date().toISOString(),
        heartbeatIntervalMs: this.runners.getHeartbeatIntervalMs(),
        reconnectGraceMs: this.runners.getReconnectGraceMs(),
        maxConcurrentExecutions: this.runnerConcurrency(),
      }),
    );
    this.logger.info({
      eventType: 'runner.socket_ready',
      message: 'Runner socket authenticated',
      runnerId: handshake.runnerId,
      status: 'online',
    });
  }

  handleDisconnect(client: Socket): void {
    const runnerId = client.data.runnerId as string | undefined;
    if (!runnerId) {
      return;
    }
    if (this.sockets.get(runnerId) === client) {
      this.sockets.delete(runnerId);
      void this.runners.markDisconnected(runnerId, client.id).catch((error: unknown) => {
        this.logger.error({
          eventType: 'runner.disconnect_failed',
          message: 'Failed to persist runner disconnect',
          runnerId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  @SubscribeMessage('runner.message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<void> {
    const runnerId = client.data.runnerId as string | undefined;
    if (!runnerId || this.sockets.get(runnerId) !== client) {
      return;
    }

    const parsed = runnerInboundMessageSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn({
        eventType: 'runner.message_invalid',
        message: 'Runner sent a message that does not match protocol v1',
        runnerId,
        status: 'warning',
        error: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
      this.send(
        runnerId,
        this.envelope(runnerId, 'runner.error', {
          code: 'RUNNER_MESSAGE_INVALID',
          message: 'Message does not match runner protocol v1',
          fatal: false,
        }),
      );
      return;
    }

    // Process messages from one runner strictly in arrival order. Terminal
    // events must never overtake the final logs that explain them, and a
    // replayed log must be acknowledged in the same order it was streamed.
    const previous = this.messageQueues.get(runnerId) ?? Promise.resolve();
    const run = previous.then(() =>
      this.runners.handleInbound(runnerId, parsed.data).catch((error: unknown) => {
        const appError = error instanceof AppException ? error : null;
        const code = appError?.code ?? 'RUNNER_MESSAGE_FAILED';
        const fatal = code === 'RUNNER_NOT_FOUND' || code === 'RUNNER_AUTH_FAILED';
        this.logger.warn({
          eventType: 'runner.message_failed',
          message: 'Runner message could not be applied',
          runnerId,
          status: 'warning',
          error: code,
        });
        this.send(
          runnerId,
          this.envelope(runnerId, 'runner.error', {
            code,
            message:
              appError?.message ??
              (error instanceof Error ? error.message : 'Runner message could not be applied'),
            fatal,
          }),
        );
      }),
    );
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    this.messageQueues.set(runnerId, tracked);
    try {
      await run;
    } finally {
      if (this.messageQueues.get(runnerId) === tracked) {
        this.messageQueues.delete(runnerId);
      }
    }
  }

  send(runnerId: string, message: RunnerEnvelope): boolean {
    const socket = this.sockets.get(runnerId);
    if (!socket?.connected) {
      return false;
    }
    socket.emit('runner.message', message);
    return true;
  }

  isConnected(runnerId: string): boolean {
    return Boolean(this.sockets.get(runnerId)?.connected);
  }

  private async authenticateSocket(socket: Socket): Promise<void> {
    const parsed = runnerHandshakeSchema.safeParse(socket.handshake.auth ?? {});
    if (!parsed.success) {
      throw new AppException(
        'RUNNER_HANDSHAKE_INVALID',
        'Runner handshake must include runnerId, computerId and a token',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const handshake = await this.runners.authenticate(parsed.data);
    socket.data.handshake = handshake;
  }

  private runnerConcurrency(): number {
    const configured = Number(process.env.HAFT_RUNNER_MAX_CONCURRENT ?? 1);
    return Number.isInteger(configured) ? Math.min(32, Math.max(1, configured)) : 1;
  }

  private envelope(
    runnerId: string,
    type: string,
    payload: Record<string, unknown>,
  ): RunnerEnvelope {
    return {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      messageId: randomUUID(),
      runnerId,
      type,
      sentAt: new Date().toISOString(),
      payload,
    };
  }
}
