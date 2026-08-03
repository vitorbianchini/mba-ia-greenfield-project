import { getQueueToken } from '@nestjs/bullmq';
import type { TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';

/**
 * BullMQ re-emits ioredis connection errors on the Queue. An EventEmitter with
 * no 'error' listener crashes the process, and shutting a connection down races
 * with in-flight commands, so tearing a module down without this handler fails
 * the whole run with "Unhandled error. (Error: Connection is closed.)".
 * Attaching a listener is what the BullMQ docs prescribe, not a workaround.
 */
export async function closeQueues(
  moduleRef: TestingModule,
  ...names: string[]
): Promise<void> {
  for (const name of names) {
    const queue = moduleRef.get<Queue>(getQueueToken(name), { strict: false });
    queue.on('error', () => undefined);
    await queue.close();
  }
}
