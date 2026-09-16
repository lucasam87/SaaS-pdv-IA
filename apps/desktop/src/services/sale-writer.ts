import { Sale } from '@pdv/shared';
import { localDb } from '../db/local-db';
import { CloudApiClient } from './cloud-api-client';

export type SaleWriteMode = 'ONLINE_TRANSACTION' | 'OFFLINE_FALLBACK';

export interface SaleWriteResult {
  success: boolean;
  mode: SaleWriteMode;
  sale: Sale;
  message: string;
}

export class SaleWriterService {
  /**
   * Finaliza e grava a venda aplicando a estratégia de Persistência Local Prévia com Sincronização Imediata.
   *
   * 1. Gera deterministicamente id e operationId antes de qualquer tentativa (preserva nas retentativas).
   * 2. Padroniza IDs: operation_id recebe sale.id (preservando compatibilidade se operationId for fornecido).
   * 3. PERSISTÊNCIA LOCAL OBRIGATÓRIA: Grava atomicamente venda, itens, pagamentos, movimentos e outbox
   *    (status PENDING) no SQLite local ANTES de qualquer tentativa de envio de rede.
   *    Se a persistência local falhar, interrompe imediatamente com exceção (impede confirmação e impressão).
   * 4. Tenta sincronizar imediatamente após o commit local bem-sucedido (se online e handler fornecido).
   * 5. Trata timeout (> 2.5s) e falhas de rede como resultado remoto desconhecido, mantendo a operação
   *    recuperável na outbox local para reenvio pelo worker sem travar o balcão.
   * 6. Atualiza para SYNCED no SQLite somente após confirmação remota válida.
   */
  public static async processSale(
    sale: Sale,
    isOnline: boolean,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cloudTransactionFn?: (sale: Sale) => Promise<any>
  ): Promise<SaleWriteResult> {
    // 1. Identificadores únicos determinísticos gerados uma vez por venda e preservados nas retentativas
    const saleId = sale.id || `sale_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    // Padronização: operation_id recebe sale.id; preserva compatibilidade se operationId já existir
    const operationId = sale.operationId || saleId;

    const normalizedSale: Sale = {
      ...sale,
      id: saleId,
      operationId,
    };

    // 2. PERSISTÊNCIA LOCAL OBRIGATÓRIA ANTES DE QUALQUER ENVIO
    // Grava atomicamente venda, itens, pagamentos, baixa de estoque e outbox (PENDING) no SQLite local.
    // Se a persistência local falhar, o erro é propagado imediatamente para impedir confirmação e impressão.
    await localDb.recordLocalSale(normalizedSale);

    // Função transacional efetiva: usa o parâmetro customizado ou o CloudApiClient padrão
    const effectiveCloudFn =
      cloudTransactionFn !== undefined
        ? cloudTransactionFn
        : (s: Sale) => CloudApiClient.processSaleTransaction(s);

    // 3. Se estiver offline ou sem função de sincronização configurada
    if (!isOnline || !effectiveCloudFn) {
      return {
        success: true,
        mode: 'OFFLINE_FALLBACK',
        sale: normalizedSale,
        message: 'Venda salva localmente com sucesso. Pendente de sincronização com a nuvem.',
      };
    }

    // 4. Tentativa de sincronização imediata pós-commit local com timeout controlado (2.5s)
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

      const remoteResponse = await Promise.race([effectiveCloudFn(normalizedSale), timeoutPromise]);

      // Validar a resposta remota: Promise resolvida com success:false ou ok:false NÃO é sucesso
      if (remoteResponse !== undefined && remoteResponse !== null && typeof remoteResponse === 'object') {
        const respObj = remoteResponse as Record<string, unknown>;
        if (respObj.success === false || respObj.ok === false) {
          const errDetail = String(respObj.error || respObj.message || 'Operação rejeitada pelo backend remoto');
          throw new Error(`REMOTE_REJECTION: ${errDetail}`);
        }
      }

      // Transação na nuvem confirmada dentro do prazo: atualiza para SYNCED
      await localDb.markOutboxSuccess(operationId);

      const onlineSale: Sale = { ...normalizedSale, syncedAt: Date.now() };

      return {
        success: true,
        mode: 'ONLINE_TRANSACTION',
        sale: onlineSale,
        message: 'Venda confirmada e estoque sincronizado na nuvem.',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Timeout ou erro de rede tratado como resultado desconhecido: a venda já está comitada localmente na outbox
      console.warn('[SaleWriter] Sincronização imediata pendente ou timeout (operação salva na outbox):', errMsg);
      return {
        success: true,
        mode: 'OFFLINE_FALLBACK',
        sale: normalizedSale,
        message: `Sincronização imediata pendente (${errMsg}) — venda segura no SQLite e na outbox.`,
      };
    }
  }
}
