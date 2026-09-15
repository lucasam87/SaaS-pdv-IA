import { localDb, OutboxRecord } from '../db/local-db';
import { Sale } from '@pdv/shared';

export type SyncHandlerFn = (op: OutboxRecord, sale: Sale) => Promise<{ success: boolean; error?: string }>;

export interface SyncWorkerOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  intervalMs?: number;
}

export class SyncWorkerClient {
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private syncHandler: SyncHandlerFn;
  private options: Required<SyncWorkerOptions>;

  constructor(syncHandler?: SyncHandlerFn, options?: SyncWorkerOptions) {
    this.options = {
      baseDelayMs: options?.baseDelayMs ?? 1500,
      maxDelayMs: options?.maxDelayMs ?? 30000,
      maxAttempts: options?.maxAttempts ?? 10,
      intervalMs: options?.intervalMs ?? 5000,
    };

    // Handler padrão caso não seja injetado (pode ser sobrescrito)
    this.syncHandler = syncHandler || (async (_op, _sale) => {
      // Por padrão tenta simular/chamar nuvem
      return { success: true };
    });
  }

  public setSyncHandler(handler: SyncHandlerFn) {
    this.syncHandler = handler;
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNext(100);
  }

  public stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number) {
    if (!this.isRunning) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.syncOnce();
      this.scheduleNext(this.options.intervalMs);
    }, delayMs);
  }

  /**
   * Executa uma rodada de sincronização de todos os registros pendentes da outbox.
   * @param force Se true, ignora o tempo de backoff (útil para clique manual ou testes).
   */
  public async syncOnce(force: boolean = false): Promise<{ processedCount: number; successCount: number; failedCount: number }> {
    if (this.isProcessing) {
      return { processedCount: 0, successCount: 0, failedCount: 0 };
    }

    this.isProcessing = true;
    let successCount = 0;
    let failedCount = 0;

    try {
      const pendingOperations = localDb.getPendingOutboxOperations(20);

      for (const op of pendingOperations) {
        // Se excedeu o número máximo de tentativas
        if (op.attempts >= this.options.maxAttempts) {
          continue;
        }

        // Se não for forçado, calcula e respeita o backoff exponencial com jitter
        if (!force) {
          const backoff = Math.min(
            this.options.baseDelayMs * Math.pow(2, op.attempts),
            this.options.maxDelayMs
          );
          const jitter = Math.floor(Math.random() * 500);
          const requiredDelay = backoff + jitter;

          if (op.status === 'FAILED' && Date.now() - op.updatedAt < requiredDelay) {
            continue;
          }
        }

        localDb.markOutboxProcessing(op.operationId);

        try {
          const sale: Sale = JSON.parse(op.payload);
          const result = await this.syncHandler(op, sale);

          if (result.success) {
            localDb.markOutboxSuccess(op.operationId);
            successCount++;
          } else {
            const errorMsg = result.error || 'Erro desconhecido retornado pela nuvem';
            localDb.markOutboxFailed(op.operationId, errorMsg);
            failedCount++;
          }
        } catch (err: any) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          localDb.markOutboxFailed(op.operationId, errorMsg);
          failedCount++;
        }
      }

      return {
        processedCount: successCount + failedCount,
        successCount,
        failedCount,
      };
    } finally {
      this.isProcessing = false;
    }
  }

  public getPendingCount(): number {
    return localDb.getPendingOutboxCount();
  }
}

export const syncWorkerClient = new SyncWorkerClient();
