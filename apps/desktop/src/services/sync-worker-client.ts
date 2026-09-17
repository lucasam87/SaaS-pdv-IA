import { localDb, OutboxRecord } from '../db/local-db';
import { Sale } from '@pdv/shared';
import { CloudApiClient } from './cloud-api-client';

export type SyncHandlerFn = (op: OutboxRecord, sale: Sale) => Promise<{ success: boolean; error?: string }>;

export interface SyncWorkerOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  intervalMs?: number;
  batchSize?: number;
  processingLeaseMs?: number;
  requestTimeoutMs?: number;
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
      batchSize: options?.batchSize ?? 20,
      processingLeaseMs: options?.processingLeaseMs ?? 60000,
      requestTimeoutMs: options?.requestTimeoutMs ?? 5000,
    };

    // Handler padrão: utiliza CloudApiClient (mesmo endpoint e contrato do envio imediato)
    this.syncHandler =
      syncHandler ||
      (async (_op, sale) => {
        try {
          const res = await CloudApiClient.processSaleTransaction(sale);
          return { success: res.success };
        } catch (err: any) {
          return {
            success: false,
            error: err.message || String(err),
          };
        }
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
   * Executa uma rodada de sincronização com reivindicação atômica e proteção contra bloqueio de fila.
   * @param force Se true, antecipa retentativas transitórias (útil para clique manual ou testes),
   *              sem contornar validações, autenticação ou integridade.
   */
  public async syncOnce(force: boolean = false): Promise<{ processedCount: number; successCount: number; failedCount: number }> {
    if (this.isProcessing) {
      return { processedCount: 0, successCount: 0, failedCount: 0 };
    }

    this.isProcessing = true;
    let successCount = 0;
    let failedCount = 0;

    try {
      // 1. Reivindica atomicamente os registros elegíveis em transação SQLite.
      // - Registros em PROCESSING abandonados (prazo vencido) são automaticamente recuperados.
      // - Registros com tentativas esgotadas são ignorados pelo SQL, nunca bloqueando as operações seguintes.
      const claimedOperations = await localDb.claimEligibleOutboxBatch(
        this.options.batchSize,
        this.options.processingLeaseMs,
        force,
        this.options.maxAttempts
      );

      for (const op of claimedOperations) {
        try {
          // 2. Aplica timeout individual ao envio para que chamadas travadas não paralisem o worker
          const timeoutPromise = new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`SYNC_TIMEOUT: Envio da operação "${op.operationId}" excedeu ${this.options.requestTimeoutMs}ms.`));
            }, this.options.requestTimeoutMs);
            if (typeof (timer as any)?.unref === 'function') {
              (timer as any).unref();
            }
          });

          let result: { success: boolean; error?: string };

          if (op.type === 'CATALOG_PRODUCT_UPSERT' || op.type === 'CATALOG_PRODUCT_TOGGLE') {
            // Roteamento específico para eventos de catálogo (evita parse indevido como Sale)
            const payload = JSON.parse(op.payload);
            const catalogPromise = CloudApiClient.processCatalogTransaction(payload, op.type, op.operationId);
            result = await Promise.race([catalogPromise, timeoutPromise]);
          } else {
            // Eventos de venda padrão (SALE_CREATED, etc.)
            const sale: Sale = JSON.parse(op.payload);
            result = await Promise.race([this.syncHandler(op, sale), timeoutPromise]);
          }

          if (result && result.success) {
            await localDb.markOutboxSuccess(op.operationId);
            successCount++;
          } else {
            const errorMsg = result?.error || 'Erro desconhecido retornado pela nuvem';
            await localDb.markOutboxFailed(
              op.operationId,
              errorMsg,
              this.options.baseDelayMs,
              this.options.maxDelayMs,
              this.options.maxAttempts
            );
            failedCount++;
          }
        } catch (err: any) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await localDb.markOutboxFailed(
            op.operationId,
            errorMsg,
            this.options.baseDelayMs,
            this.options.maxDelayMs,
            this.options.maxAttempts
          );
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

  /**
   * Força uma sincronização imediata (acionado pelo botão manual na interface).
   */
  public async forceSync(): Promise<{ processedCount: number; successCount: number; failedCount: number }> {
    return await this.syncOnce(true);
  }

  /**
   * Recupera manualmente operações em processamento abandonadas.
   */
  public async recoverAbandoned(): Promise<number> {
    return await localDb.recoverAbandonedProcessing(Date.now(), this.options.maxAttempts);
  }

  /**
   * Reprocessa todas as operações que atingiram o estado de revisão.
   */
  public async reprocessReviewItems(): Promise<number> {
    return await localDb.reprocessAllReviewRequired();
  }

  public async getPendingCount(): Promise<number> {
    return await localDb.getPendingOutboxCount();
  }
}

export const syncWorkerClient = new SyncWorkerClient();

