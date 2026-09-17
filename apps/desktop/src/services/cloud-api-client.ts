import { Sale } from '@pdv/shared';

export class CloudResponseError extends Error {
  public code: string;
  constructor(code: string, message: string) {
    super(`[CloudApiClient] ${code}: ${message}`);
    this.name = 'CloudResponseError';
    this.code = code;
  }
}

export interface CloudSaleResponse {
  success: boolean;
  idempotentRepeat?: boolean;
  saleId: string;
  operationId: string;
  message?: string;
  error?: string;
}

export interface CloudCatalogResponse {
  success: boolean;
  operationId: string;
  message?: string;
  error?: string;
}

export type CloudSaleDispatcherFn = (sale: Sale) => Promise<CloudSaleResponse>;
export type CloudCatalogDispatcherFn = (payload: any, type: string, operationId?: string) => Promise<CloudCatalogResponse>;

/**
 * Cliente HTTP para comunicação com o backend transacional na nuvem (Firebase Cloud Functions).
 * Garante que tanto o envio imediato (SaleWriter) quanto as retentativas da fila (SyncWorker)
 * utilizem rigorosamente o mesmo endpoint e regras de autenticação/validação estrita.
 */
export class CloudApiClient {
  private static backendUrl: string =
    (typeof process !== 'undefined' && process.env?.VITE_CLOUD_API_URL) ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_CLOUD_API_URL) ||
    'https://us-central1-pdv-inteligente.cloudfunctions.net/apiProcessSale';

  private static catalogBackendUrl: string =
    (typeof process !== 'undefined' && process.env?.VITE_CLOUD_CATALOG_URL) ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_CLOUD_CATALOG_URL) ||
    'https://us-central1-pdv-inteligente.cloudfunctions.net/apiSyncCatalog';

  private static authTokenProvider?: () => Promise<string | null> | string | null;
  private static mockDispatcher?: CloudSaleDispatcherFn;
  private static mockCatalogDispatcher?: CloudCatalogDispatcherFn;

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

  public static setCatalogBackendUrl(url: string): void {
    this.catalogBackendUrl = url;
  }

  public static getCatalogBackendUrl(): string {
    return this.catalogBackendUrl;
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

  public static setMockCatalogDispatcher(dispatcher?: CloudCatalogDispatcherFn): void {
    this.mockCatalogDispatcher = dispatcher;
  }

  /**
   * Dispara a transação de venda para o backend na nuvem com validação estrita da resposta.
   * Lança exceções claras em casos de erro de integridade ou rejeição da nuvem,
   * permitindo que o SaleWriter decida pelo fallback offline e o SyncWorker agende retentativas.
   */
  public static async processSaleTransaction(sale: Sale): Promise<CloudSaleResponse> {
    // 1. Se houver dispatcher customizado/mock ativo (testes ou injeção de dependência)
    if (this.mockDispatcher) {
      const res = await this.mockDispatcher(sale);
      if (!res || res.success !== true) {
        throw new CloudResponseError(
          'REJECTED_RESPONSE',
          res?.error || res?.message || 'Dispatcher retornou resposta de erro (success !== true).'
        );
      }
      if (!res.saleId || typeof res.saleId !== 'string' || res.saleId.trim() === '') {
        throw new CloudResponseError(
          'MISSING_SALE_ID',
          'Dispatcher de venda não retornou o saleId obrigatório.'
        );
      }
      if (res.saleId !== sale.id) {
        throw new CloudResponseError(
          'DIVERGENT_SALE_ID',
          `saleId retornado pelo dispatcher ("${res.saleId}") difere do enviado ("${sale.id}").`
        );
      }
      const sentOpId = sale.operationId || sale.id;
      if (!res.operationId || typeof res.operationId !== 'string' || res.operationId.trim() === '') {
        throw new CloudResponseError(
          'MISSING_OPERATION_ID',
          'Dispatcher de venda não retornou o operationId obrigatório.'
        );
      }
      if (res.operationId !== sentOpId) {
        throw new CloudResponseError(
          'DIVERGENT_OPERATION_ID',
          `operationId retornado pelo dispatcher ("${res.operationId}") difere do enviado ("${sentOpId}").`
        );
      }
      return res;
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

    const response = await fetch(this.backendUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(sale),
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      throw new CloudResponseError(
        'INVALID_CONTENT_TYPE',
        `Resposta da nuvem não é JSON válido (Content-Type: "${contentType}"). Prévia: ${text.substring(0, 150)}`
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch (jsonErr: any) {
      throw new CloudResponseError('MALFORMED_JSON', `Falha ao interpretar JSON de resposta: ${jsonErr.message}`);
    }

    if (!data || typeof data !== 'object') {
      throw new CloudResponseError('EMPTY_BODY', 'Resposta da nuvem vazia ou não estruturada.');
    }

    if (!response.ok || data.success !== true) {
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
      throw new CloudResponseError(`REMOTE_ERROR_${response.status}`, errorMessage);
    }

    // Validação estrita de identificadores obrigatórios
    if (!data.saleId || typeof data.saleId !== 'string' || data.saleId.trim() === '') {
      throw new CloudResponseError(
        'MISSING_SALE_ID',
        'Resposta da nuvem não contém o saleId obrigatório.'
      );
    }
    if (data.saleId !== sale.id) {
      throw new CloudResponseError(
        'DIVERGENT_SALE_ID',
        `saleId retornado ("${data.saleId}") diverge do enviado ("${sale.id}").`
      );
    }

    const sentOpId = sale.operationId || sale.id;
    if (!data.operationId || typeof data.operationId !== 'string' || data.operationId.trim() === '') {
      throw new CloudResponseError(
        'MISSING_OPERATION_ID',
        'Resposta da nuvem não contém o operationId obrigatório.'
      );
    }
    if (data.operationId !== sentOpId) {
      throw new CloudResponseError(
        'DIVERGENT_OPERATION_ID',
        `operationId retornado ("${data.operationId}") diverge do enviado ("${sentOpId}").`
      );
    }

    return {
      success: true,
      idempotentRepeat: !!data.idempotentRepeat,
      saleId: data.saleId,
      operationId: data.operationId,
      message: data.message || 'Venda transacionada na nuvem com sucesso.',
    };
  }

  /**
   * Dispara a transação de catálogo (upsert ou toggle de produto) para a nuvem.
   */
  public static async processCatalogTransaction(
    payload: any,
    type: string,
    operationId?: string
  ): Promise<CloudCatalogResponse> {
    const expectedOpId = operationId || payload?.operationId || (payload?.id ? `op_cat_${payload.id}` : undefined);

    if (this.mockCatalogDispatcher) {
      const res = await this.mockCatalogDispatcher(payload, type, expectedOpId);
      if (!res || res.success !== true) {
        throw new CloudResponseError(
          'REJECTED_RESPONSE',
          res?.error || res?.message || 'Mock catalog dispatcher rejeitou a operação.'
        );
      }
      if (!res.operationId || typeof res.operationId !== 'string' || res.operationId.trim() === '') {
        throw new CloudResponseError(
          'MISSING_OPERATION_ID',
          'Dispatcher de catálogo não retornou o operationId obrigatório.'
        );
      }
      if (expectedOpId && res.operationId !== expectedOpId) {
        throw new CloudResponseError(
          'DIVERGENT_OPERATION_ID',
          `operationId retornado pelo dispatcher de catálogo ("${res.operationId}") diverge do esperado ("${expectedOpId}").`
        );
      }
      return {
        success: true,
        operationId: res.operationId,
        message: res.message,
      };
    }

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

    const response = await fetch(this.catalogBackendUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type, payload, operationId: expectedOpId }),
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      throw new CloudResponseError(
        'INVALID_CONTENT_TYPE',
        `Resposta do catálogo não é JSON válido (Content-Type: "${contentType}"). Prévia: ${text.substring(0, 150)}`
      );
    }

    const data = await response.json();
    if (!response.ok || data?.success !== true) {
      const errMsg = data?.error || data?.message || `HTTP_${response.status}`;
      throw new CloudResponseError(`REMOTE_ERROR_${response.status}`, errMsg);
    }

    if (!data.operationId || typeof data.operationId !== 'string' || data.operationId.trim() === '') {
      throw new CloudResponseError(
        'MISSING_OPERATION_ID',
        'Resposta do catálogo não contém o operationId obrigatório.'
      );
    }
    if (expectedOpId && data.operationId !== expectedOpId) {
      throw new CloudResponseError(
        'DIVERGENT_OPERATION_ID',
        `operationId retornado pelo catálogo ("${data.operationId}") diverge do esperado ("${expectedOpId}").`
      );
    }

    return {
      success: true,
      operationId: data.operationId,
      message: data.message || 'Catálogo atualizado com sucesso na nuvem.',
    };
  }
}
