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
   * 1. Se estiver online: tenta efetuar a transação na nuvem com timeout de 2.5s.
   * 2. Se a nuvem responder: atualiza o cache local e marca como sincronizada.
   * 3. Se a internet falhar/timeout/offline: grava imediatamente no SQLite/cache local
   *    e joga na fila de contingência para envio posterior. O balcão NUNCA trava.
   */
  public static async processSale(
    sale: Sale,
    isOnline: boolean,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cloudTransactionFn?: (sale: Sale) => Promise<any>
  ): Promise<SaleWriteResult> {
    // 1. Se o operador está em modo explicitamente offline
    if (!isOnline || !cloudTransactionFn) {
      return this.recordLocallyAsFallback(sale, 'Operando em modo offline');
    }

    // 2. Tenta transação online com timeout agressivo de 2500ms
    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT_EXCEEDED')), 2500)
      );

      await Promise.race([cloudTransactionFn(sale), timeoutPromise]);

      // Transação na nuvem foi concluída com sucesso!
      const onlineSale: Sale = { ...sale, syncedAt: Date.now() };

      // Atualiza também o estoque no cache local do computador
      localDb.recordLocalSale(onlineSale);
      // Como já subiu para a nuvem na mesma transação, remove da fila pendente
      localDb.markSalesAsSynced([onlineSale.id]);

      return {
        success: true,
        mode: 'ONLINE_TRANSACTION',
        sale: onlineSale,
        message: 'Venda confirmada e estoque atualizado na nuvem.',
      };
    } catch (err) {
      console.warn('[SaleWriter] Falha ou lentidão na nuvem, acionando contingência offline:', err);
      return this.recordLocallyAsFallback(
        sale,
        'Internet lenta ou indisponível — salva em contingência local'
      );
    }
  }

  private static recordLocallyAsFallback(sale: Sale, reason: string): SaleWriteResult {
    // 1. Grava no banco local instantaneamente (< 1ms) e deduz o estoque local provisoriamente
    localDb.recordLocalSale(sale);

    return {
      success: true,
      mode: 'OFFLINE_FALLBACK',
      sale,
      message: `${reason}. Será sincronizada assim que a conexão restabelecer.`,
    };
  }
}
