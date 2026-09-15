import { Sale, SystemSignal, Product } from '@pdv/shared';

export interface SyncBatchResult {
  syncedSalesCount: number;
  conflictsDetected: SystemSignal[];
  updatedStockMap: Record<string, number>;
}

/**
 * Processador de Sincronização de Vendas Offline com Resolução de Conflitos.
 *
 * REGRA DO VAREJO FÍSICO:
 * - Vendas que aconteceram offline no mundo real NUNCA são rejeitadas.
 * - Se duas máquinas venderam o mesmo item offline e a soma ultrapassar o estoque físico,
 *   o estoque fica NEGATIVO sem travar o sistema.
 * - É gerado um sinal 'STOCK_NEGATIVE_CONFLICT' para auditoria e conferência do lojista no relatório noturno.
 */
export class OfflineSyncWorker {
  public static processOfflineBatch(
    offlineSales: Sale[],
    currentProducts: Product[]
  ): SyncBatchResult {
    const stockMap: Record<string, number> = {};
    const productCatalog = new Map<string, Product>();

    // Inicializa o mapa com o estoque atual conhecido
    currentProducts.forEach((p) => {
      stockMap[p.id] = p.currentStock;
      productCatalog.set(p.id, p);
    });

    const salesPerProduct = new Map<string, { sales: Sale[]; totalQtySold: number }>();

    // Agrupa as vendas por produto
    for (const sale of offlineSales) {
      for (const item of sale.items) {
        const group = salesPerProduct.get(item.productId) || { sales: [], totalQtySold: 0 };
        group.sales.push(sale);
        group.totalQtySold += item.quantity;
        salesPerProduct.set(item.productId, group);
      }
    }

    const conflictsDetected: SystemSignal[] = [];

    // Processa a baixa de cada produto
    for (const [productId, data] of salesPerProduct.entries()) {
      const product = productCatalog.get(productId);
      const startingStock = stockMap[productId] ?? 0;
      const newBalance = startingStock - data.totalQtySold;
      stockMap[productId] = newBalance;

      // Se o saldo ficou negativo, detectou conflito concorrente de venda offline!
      if (newBalance < 0 && product) {
        const deviceIds = Array.from(new Set(data.sales.map((s) => s.deviceId)));
        const saleIds = data.sales.map((s) => s.id);

        const conflictSignal: SystemSignal = {
          id: `signal_conflict_${Date.now()}_${productId}`,
          tenantId: product.tenantId,
          type: 'STOCK_NEGATIVE_CONFLICT',
          severity: 'WARNING',
          payload: {
            productId,
            productName: product.name,
            barcode: product.barcode,
            negativeBalance: newBalance,
            saleIds,
            deviceIds,
            occurredAt: Date.now(),
          },
          createdAt: Date.now(),
        };

        conflictsDetected.push(conflictSignal);
        console.warn(
          `[SyncWorker] Conflito de estoque detectado para "${product.name}": saldo ${newBalance} un nos terminais [${deviceIds.join(', ')}]. Sinal registrado.`
        );
      }
    }

    return {
      syncedSalesCount: offlineSales.length,
      conflictsDetected,
      updatedStockMap: stockMap,
    };
  }
}
