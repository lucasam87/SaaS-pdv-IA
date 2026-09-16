import { Sale } from '@pdv/shared';

export interface CloudSaleResponse {
  success: boolean;
  idempotentRepeat?: boolean;
  saleId: string;
  message?: string;
  error?: string;
}

export type CloudSaleDispatcherFn = (sale: Sale) => Promise<CloudSaleResponse>;

/**
 * Cliente HTTP para comunicação com o backend transacional na nuvem (Firebase Cloud Functions).
 * Garante que tanto o envio imediato (SaleWriter) quanto as retentativas da fila (SyncWorker)
 * utilizem rigorosamente o mesmo endpoint e regras de autenticação/validação.
 */
export class CloudApiClient {
  private static backendUrl: string =
    (typeof process !== 'undefined' && process.env?.VITE_CLOUD_API_URL) ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_CLOUD_API_URL) ||
    'https://us-central1-pdv-inteligente.cloudfunctions.net/apiProcessSale';

  private static authTokenProvider?: () => Promise<string | null> | string | null;
  private static mockDispatcher?: CloudSaleDispatcherFn;

  /**
   * Configura a URL base do endpoint backend (útil para desenvolvimento local com emuladores).
   */
  public static setBackendUrl(url: string): void {
    this.backendUrl = url;
  }

  /**
   * Retorna a URL configurada do endpoint transacional.
   */
  public static getBackendUrl(): string {
    return this.backendUrl;
  }

  /**
   * Configura o provedor de token de autenticação (Firebase ID Token).
   */
  public static setAuthTokenProvider(provider: () => Promise<string | null> | string | null): void {
    this.authTokenProvider = provider;
  }

  /**
   * Permite configurar um dispatcher de teste ou transacional direto para testes unitários/integração.
   */
  public static setMockDispatcher(dispatcher?: CloudSaleDispatcherFn): void {
    this.mockDispatcher = dispatcher;
  }

  /**
   * Dispara a transação de venda para o backend na nuvem.
   * Lança exceções claras em casos de erro de integridade ou rejeição da nuvem,
   * permitindo que o SaleWriter decida pelo fallback offline e o SyncWorker agende retentativas.
   */
  public static async processSaleTransaction(sale: Sale): Promise<CloudSaleResponse> {
    // 1. Se houver dispatcher customizado/mock ativo (testes ou injeção de dependência)
    if (this.mockDispatcher) {
      return await this.mockDispatcher(sale);
    }

    // 2. Obtém o token autenticado
    let token: string | null = null;
    if (this.authTokenProvider) {
      try {
        token = await this.authTokenProvider();
      } catch (err) {
        console.warn('[CloudApiClient] Erro ao obter token do provedor:', err);
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(this.backendUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(sale),
      });

      const contentType = response.headers.get('content-type') || '';
      let data: any = {};
      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        data = { message: text };
      }

      if (!response.ok) {
        const errorMessage = data.error || data.message || `HTTP_${response.status}`;
        if (response.status === 409) {
          throw new Error(`INTEGRITY_CONFLICT: ${errorMessage}`);
        }
        if (response.status === 401) {
          throw new Error(`UNAUTHENTICATED: ${errorMessage}`);
        }
        if (response.status === 403) {
          throw new Error(`PERMISSION_DENIED: ${errorMessage}`);
        }
        if (response.status === 400) {
          throw new Error(`INVALID_PAYLOAD: ${errorMessage}`);
        }
        throw new Error(`REMOTE_ERROR_${response.status}: ${errorMessage}`);
      }

      return {
        success: true,
        idempotentRepeat: !!data.idempotentRepeat,
        saleId: data.saleId || sale.id,
        message: data.message || 'Venda transacionada na nuvem com sucesso.',
      };
    } catch (err: any) {
      // Propaga o erro para tratamento pelo SaleWriter ou SyncWorker
      throw err;
    }
  }
}
