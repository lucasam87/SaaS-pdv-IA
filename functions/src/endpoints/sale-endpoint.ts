import * as admin from 'firebase-admin';
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { Sale } from '@pdv/shared';
import {
  executeFirestoreSaleTransaction,
  validateSalePayload,
  CloudSaleResult,
} from '../cloud-sale-handler';

// Inicialização segura do Firebase Admin
if (admin.apps.length === 0) {
  admin.initializeApp();
}

export interface AuthenticatedUserContext {
  uid: string;
  tenantId: string;
  role?: string;
}

/**
 * Validador de Token Bearer para endpoints HTTP REST.
 */
export async function verifyAuthToken(authHeader?: string): Promise<AuthenticatedUserContext> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('UNAUTHENTICATED: Cabeçalho de autorização (Bearer token) ausente ou mal formatado.');
  }

  const idToken = authHeader.split('Bearer ')[1].trim();
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken, true /* checkRevoked */);
    const tenantId = (decodedToken.tenantId as string) || (decodedToken.uid as string);
    const role = (decodedToken.role as string) || undefined;
    return {
      uid: decodedToken.uid,
      tenantId,
      role,
    };
  } catch (err: any) {
    throw new Error(`UNAUTHENTICATED: Token inválido ou expirado (${err.message}).`);
  }
}

/**
 * Endpoint Callable Firebase (SDK Client) para processamento transacional de vendas.
 */
export const processSaleTransaction = onCall<Sale, Promise<CloudSaleResult>>(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Requer autenticação do usuário.');
  }

  const callerTenantId = (request.auth.token.tenantId as string) || request.auth.uid;
  const callerRole = (request.auth.token.role as string) || 'CASHIER';

  const sale = request.data;
  if (!sale) {
    throw new HttpsError('invalid-argument', 'Payload de venda não informado.');
  }

  // 1. Validação de Vínculo com Tenant
  if (sale.tenantId !== callerTenantId) {
    throw new HttpsError(
      'permission-denied',
      `Acesso negado: o tenant da venda (${sale.tenantId}) não corresponde ao tenant autenticado (${callerTenantId}).`
    );
  }

  // 2. Validação de Permissões de Papel
  const allowedRoles = ['ADMIN', 'MANAGER', 'CASHIER'];
  if (callerRole && !allowedRoles.includes(callerRole)) {
    throw new HttpsError(
      'permission-denied',
      `Papel de usuário "${callerRole}" não autorizado a registrar vendas.`
    );
  }

  // 3. Validação de Dispositivo
  if (!sale.deviceId || typeof sale.deviceId !== 'string' || sale.deviceId.trim() === '') {
    throw new HttpsError('invalid-argument', 'O identificador do dispositivo (deviceId) é obrigatório.');
  }

  try {
    // 4. Validação completa do payload e aritmética antes da transação
    validateSalePayload(sale, callerTenantId);

    // 5. Execução em transação atômica no Firestore
    const result = await executeFirestoreSaleTransaction(admin.firestore(), callerTenantId, sale);
    return result;
  } catch (err: any) {
    if (err.message?.startsWith('INVALID_PAYLOAD')) {
      throw new HttpsError('invalid-argument', err.message);
    }
    if (err.message?.startsWith('INTEGRITY_CONFLICT')) {
      throw new HttpsError('already-exists', err.message);
    }
    throw new HttpsError('internal', err.message || 'Erro ao processar transação de venda.');
  }
});

/**
 * Endpoint HTTP REST com suporte a CORS e autenticação via Bearer token.
 * Usado pelo desktop (Tauri/Fetch) para envio imediato e retentativas do worker de sincronização.
 */
export const apiProcessSale = onRequest(async (req, res) => {
  // Configuração de CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED: Apenas POST é permitido.' });
    return;
  }

  try {
    const authContext = await verifyAuthToken(req.headers.authorization);
    const sale = req.body as Sale;

    if (!sale) {
      res.status(400).json({ success: false, error: 'INVALID_PAYLOAD: Dados da venda ausentes.' });
      return;
    }

    if (sale.tenantId !== authContext.tenantId) {
      res.status(403).json({
        success: false,
        error: `PERMISSION_DENIED: Tenant ${sale.tenantId} incompatível com credencial autenticada (${authContext.tenantId}).`,
      });
      return;
    }

    // Validação de papel
    const allowedRoles = ['ADMIN', 'MANAGER', 'CASHIER'];
    if (authContext.role && !allowedRoles.includes(authContext.role)) {
      res.status(403).json({
        success: false,
        error: `PERMISSION_DENIED: Papel "${authContext.role}" não autorizado a registrar vendas.`,
      });
      return;
    }

    // Executa transação no Firestore
    const result = await executeFirestoreSaleTransaction(admin.firestore(), authContext.tenantId, sale);
    res.status(200).json(result);
  } catch (err: any) {
    const errMsg = err.message || String(err);
    if (errMsg.startsWith('UNAUTHENTICATED')) {
      res.status(401).json({ success: false, error: errMsg });
    } else if (errMsg.startsWith('INVALID_PAYLOAD')) {
      res.status(400).json({ success: false, error: errMsg });
    } else if (errMsg.startsWith('INTEGRITY_CONFLICT')) {
      res.status(409).json({ success: false, error: errMsg });
    } else {
      res.status(500).json({ success: false, error: errMsg });
    }
  }
});
