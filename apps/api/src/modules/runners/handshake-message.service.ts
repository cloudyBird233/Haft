import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  CANONICALIZATION_VERSION,
  type HandshakeMessageType,
  type RunnerEnvelope,
} from '@raft-lite/contracts';
import { canonicalPayloadHash, canonicalizeJson } from '../../common/canonical-json';
import { AppLogger } from '../../common/logger/app-logger';
import { PrismaService } from '../../common/prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export interface HandshakeRegistrationBinding {
  registrationId: string;
  registrationEpoch: number;
}

export interface HandshakeMessageInput {
  executionId: string;
  runnerId: string;
  envelope: RunnerEnvelope;
  registration: HandshakeRegistrationBinding;
  attempt?: number;
}

/**
 * Durable evidence for outbound handshake messages.
 *
 * Two rules shape this service:
 *
 *  1. Evidence is written **before** the message is handed to the transport and
 *     in the same transaction as the dispatch-state transition it justifies.
 *     `status = created` therefore means "the API built this message and may or
 *     may not have sent it", which is exactly what an at-most-once start needs.
 *  2. `execution.start` carries the prompt and task description. Those fields are
 *     never written to the database: the persisted envelope stores content
 *     digests in a `redacted` block instead. No encryption scheme is invented
 *     and no plaintext prompt is stored.
 */
@Injectable()
export class HandshakeMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: AppLogger,
  ) {}

  /** Inserts the evidence row inside the caller's transaction. */
  async create(tx: Tx, input: HandshakeMessageInput): Promise<void> {
    const record = buildHandshakeMessageRecord(input);
    await tx.repositoryHandshakeMessage.create({ data: record });
  }

  /** `created -> sent`. Failure leaves the row in `created` (send unconfirmed). */
  async markSent(messageId: string, sentAt: Date = new Date()): Promise<boolean> {
    try {
      const result = await this.prisma.repositoryHandshakeMessage.updateMany({
        where: { messageId, status: 'created' },
        data: { status: 'sent', sentAt },
      });
      return result.count === 1;
    } catch (error) {
      this.warn('handshake.message_sent_write_failed', messageId, error);
      return false;
    }
  }

  /**
   * `sent -> acked` inside the caller's transaction.
   *
   * A coalesced ack (`created -> acked`) is accepted: a runner can only ack a
   * message that was sent, so the intermediate write was simply not committed
   * before the acknowledgement arrived. `sentAt` is then recorded as the ack
   * instant, which is the latest possible send time.
   */
  async markAcked(tx: Tx, messageId: string, ackedAt: Date = new Date()): Promise<boolean> {
    const coalesced = await tx.repositoryHandshakeMessage.updateMany({
      where: { messageId, status: 'created' },
      data: { status: 'acked', ackedAt, sentAt: ackedAt },
    });
    if (coalesced.count === 1) {
      return true;
    }
    const acked = await tx.repositoryHandshakeMessage.updateMany({
      where: { messageId, status: 'sent' },
      data: { status: 'acked', ackedAt },
    });
    return acked.count === 1;
  }

  /** Best-effort rejection record. Never breaks the failure path. */
  async markRejected(messageId: string): Promise<void> {
    try {
      await this.prisma.repositoryHandshakeMessage.updateMany({
        where: { messageId, status: { in: ['created', 'sent'] } },
        data: { status: 'rejected' },
      });
    } catch (error) {
      this.warn('handshake.message_rejected_write_failed', messageId, error);
    }
  }

  /**
   * Records an idempotent replay of a repository message. Only
   * `execution.repository` may be replayed; the start is never a replay source.
   */
  recordReplay(messageId: string, replayedAt: Date = new Date()): void {
    void this.prisma.repositoryHandshakeMessage
      .updateMany({
        where: { messageId, messageType: 'execution.repository', status: 'sent' },
        data: { lastReplayedAt: replayedAt },
      })
      .catch((error: unknown) => this.warn('handshake.message_replay_write_failed', messageId, error));
  }

  private warn(eventType: string, messageId: string, error: unknown): void {
    this.logger.warn({
      eventType,
      message: 'Could not persist handshake message state',
      status: 'warning',
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface HandshakeMessageRecord {
  executionId: string;
  runnerId: string;
  messageType: HandshakeMessageType;
  messageId: string;
  protocolVersion: number;
  attempt: number;
  envelopeJson: string;
  payloadHash: string;
  canonicalizationVersion: string;
  createdRegistrationId: string;
  createdRegistrationEpoch: number;
  status: 'created';
}

/**
 * Builds the persisted evidence for an outgoing envelope.
 *
 * `payloadHash` is the SHA-256 of `envelopeJson`, so the pair is self-verifying:
 * `payloadHash === sha256(envelopeJson)` for every stored row.
 */
export function buildHandshakeMessageRecord(input: HandshakeMessageInput): HandshakeMessageRecord {
  const evidence = redactEnvelope(input.envelope);
  const envelopeJson = canonicalizeJson(evidence);
  return {
    executionId: input.executionId,
    runnerId: input.runnerId,
    messageType: input.envelope.type as HandshakeMessageType,
    messageId: input.envelope.messageId,
    protocolVersion: input.envelope.protocolVersion,
    attempt: input.attempt ?? 1,
    envelopeJson,
    payloadHash: canonicalPayloadHash(evidence),
    canonicalizationVersion: CANONICALIZATION_VERSION,
    createdRegistrationId: input.registration.registrationId,
    createdRegistrationEpoch: input.registration.registrationEpoch,
    status: 'created',
  };
}

function redactEnvelope(envelope: RunnerEnvelope): unknown {
  if (envelope.type !== 'execution.start') {
    return envelope;
  }
  const payload = envelope.payload as Record<string, unknown>;
  const { prompt, taskDescription, ...routing } = payload;
  return {
    ...envelope,
    payload: {
      ...routing,
      redacted: {
        promptSha256: digestOf(prompt),
        taskDescriptionSha256: digestOf(taskDescription),
      },
    },
  };
}

function digestOf(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value ?? null), 'utf8')
    .digest('hex');
}
