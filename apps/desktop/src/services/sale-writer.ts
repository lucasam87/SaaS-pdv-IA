import { Sale } from '@pdv/shared';
import { localDb } from '../db/local-db';

export type SaleWriteMode = 'ONLINE_TRANSACTION' | 'OFFLINE_FALLBACK';

export interface SaleWriteResult {
  success: boolean;
  mode: SaleWriteMode;
  sale: Sale;
  message: string;
}

export class SaleWriterService {
  /**
   * Finaliza e grava a venda aplicando a estratégia Online-First com Fallback de Contingência.
   *
   * 1. Gera deterministicamente id e operationId antes de qualquer tentativa.
   * 2. Se estiver online: tenta efetuar a transação na nuvem com timeout de 2.5s.
   * 3. Se a nuvem responder: grava localmente com status sincronizado.
   * 4. Se a internet falhar/timeout/offline: grava imediatamente no SQLite local
   *    e mantém na outbox com o mesmo operationId. O balcão NUNCA trava.
   */
  public static async processSale(
    sale: Sale,
    isOnline: boolean,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cloudTransactionFn?: (sale: Sale) => Promise<any>
  ): Promise<SaleWriteResult> {
    // Garante identificadores únicos e determinísticos antes de qualquer envio
    const saleId = sale.id || `sale_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const operationId = sale.operationId || `op_${saleId}`;

    const normalizedSale: Sale = {
      ...sale,
      id: saleId,
      operationId,
    };

    // 1. Se o operador está em modo explicitamente offline ou sem função de nuvem
    if (!isOnline || !cloudTransactionFn) {
      return this.recordLocallyAsFallback(normalizedSale, 'Operando em modo offline');
    }

    // 2. Tenta transação online com timeout controlado
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('TIMEOUT_EXCEEDED'));
        }, 2500);
        // Desassocia o timer caso a runtime suporte unref
        if (typeof (timer as any)?.unref === 'function') {
          (timer as any).unref();
        }
      });

      await Promise.race([cloudTransactionFn(normalizedSale), timeoutPromise]);

      // Transação na nuvem foi concluída com sucesso dentro do prazo!
      const onlineSale: Sale = { ...normalizedSale, syncedAt: Date.now() };

      // Grava no SQLite local como sincronizada
      localDb.recordLocalSale(onlineSale);
      localDb.markOutboxSuccess(onlineSale.id);

      return {
        success: true,
        mode: 'ONLINE_TRANSACTION',
        sale: onlineSale,
        message: 'Venda confirmada e estoque atualizado na nuvem.',
      };
    } catch (err) {
      console.warn('[SaleWriter] Falha ou lentidão na nuvem, acionando contingência offline:', err);
      return this.recordLocallyAsFallback(
        normalizedSale,
        'Internet lenta ou indisponível — salva em contingência local com fila de outbox'
      );
    }
  }

  private static recordLocallyAsFallback(sale: Sale, reason: string): SaleWriteResult {
    // Grava no SQLite local atomicamente (< 1ms) e deduz o estoque local provisoriamente
    localDb.recordLocalSale(sale);

    return {
      success: true,
      mode: 'OFFLINE_FALLBACK',
      sale,
      message: `${reason}. Será sincronizada assim que a conexão restabelecer.`,
    };
  }
}
