import { Sale, SystemSignal } from '@pdv/shared';

export interface CloudSaleResult {
  success: boolean;
  idempotentRepeat: boolean;
  saleId: string;
  message?: string;
  negativeStockSignals?: SystemSignal[];
}

export interface FirestoreTransactionContext {
  getOperation(tenantId: string, operationId: string): Promise<any>;
  getProduct(tenantId: string, productId: string): Promise<any>;
  saveSale(tenantId: string, sale: Sale): Promise<void>;
  updateProductStock(tenantId: string, productId: string, newStock: number): Promise<void>;
  saveSignal(tenantId: string, signal: SystemSignal): Promise<void>;
  recordOperation(tenantId: string, operationId: string, data: any): Promise<void>;
}

/**
 * Processador de Venda na Nuvem com Idempotência Estrita por Operação.
 * Garante que reenvios causados por timeout de rede ou retentativas da outbox
 * NUNCA dupliquem baixas de estoque nem criem vendas repetidas.
 */
export class CloudSaleHandler {
  public static async processCloudSale(
    tenantId: string,
    sale: Sale,
    tx: FirestoreTransactionContext
  ): Promise<CloudSaleResult> {
    const opId = sale.operationId || sale.id;

    // 1. Checagem de Idempotência: a operação já foi gravada antes?
    const existingOp = await tx.getOperation(tenantId, opId);
    if (existingOp) {
      return {
        success: true,
        idempotentRepeat: true,
        saleId: sale.id,
        message: `Operação "${opId}" já processada com sucesso anteriormente. Re-execução ignorada.`,
      };
    }

    const negativeSignals: SystemSignal[] = [];

    // 2. Grava a Venda
    const cloudSale: Sale = {
      ...sale,
      syncedAt: Date.now(),
    };
    await tx.saveSale(tenantId, cloudSale);

    // 3. Atualiza Estoque de cada item
    for (const item of sale.items) {
      const product = await tx.getProduct(tenantId, item.productId);
      const currentStock = product ? Number(product.currentStock ?? 0) : 0;
      const newStock = currentStock - item.quantity;

      await tx.updateProductStock(tenantId, item.productId, newStock);

      // Se o estoque ficou negativo, registra sinal de auditoria operacional
      if (newStock < 0) {
        const signal: SystemSignal = {
          id: `signal_neg_${Date.now()}_${item.productId}`,
          tenantId,
          type: 'STOCK_NEGATIVE_CONFLICT',
          severity: 'WARNING',
          payload: {
            productId: item.productId,
            productName: item.productName,
            barcode: item.barcode,
            negativeBalance: newStock,
            saleIds: [sale.id],
            deviceIds: [sale.deviceId],
            occurredAt: Date.now(),
          },
          createdAt: Date.now(),
        };
        await tx.saveSignal(tenantId, signal);
        negativeSignals.push(signal);
      }
    }

    // 4. Grava o registro da operação para fechar a barreira de idempotência
    await tx.recordOperation(tenantId, opId, {
      status: 'COMMITTED',
      saleId: sale.id,
      deviceId: sale.deviceId,
      total: sale.total,
      processedAt: Date.now(),
    });

    return {
      success: true,
      idempotentRepeat: false,
      saleId: sale.id,
      negativeStockSignals: negativeSignals.length > 0 ? negativeSignals : undefined,
    };
  }
}
