import { Product } from '@pdv/shared';
import { localDb } from '../db/local-db';

export type ProductFetchFn = (sinceTimestamp: number) => Promise<{ products: Product[]; timestamp: number }>;

export class CacheReconciler {
  private isReconciling: boolean = false;
  private fetchFn: ProductFetchFn;

  constructor(fetchFn?: ProductFetchFn) {
    this.fetchFn = fetchFn || (async () => ({ products: [], timestamp: Date.now() }));
  }

  public setFetchFn(fn: ProductFetchFn) {
    this.fetchFn = fn;
  }

  /**
   * Executa a reconciliação delta de produtos da nuvem para o SQLite local.
   */
  public async reconcile(): Promise<{ updatedCount: number; lastSyncAt: number }> {
    if (this.isReconciling) {
      return { updatedCount: 0, lastSyncAt: localDb.getMeta().lastSyncAt };
    }

    this.isReconciling = true;
    try {
      const meta = localDb.getMeta();
      const result = await this.fetchFn(meta.lastSyncAt);

      if (result.products.length > 0) {
        localDb.upsertDeltaProducts(result.products, result.timestamp);
      }

      return {
        updatedCount: result.products.length,
        lastSyncAt: result.timestamp,
      };
    } finally {
      this.isReconciling = false;
    }
  }
}

export const cacheReconciler = new CacheReconciler();
