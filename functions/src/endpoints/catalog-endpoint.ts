import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { verifyAuthToken, AuthenticatedUserContext } from './sale-endpoint';

// Inicialização segura do Firebase Admin
if (admin.apps.length === 0) {
  admin.initializeApp();
}

export interface CatalogSyncPayload {
  type: 'CATALOG_PRODUCT_UPSERT' | 'CATALOG_PRODUCT_TOGGLE';
  payload: any;
  operationId?: string;
}

export interface CloudCatalogResult {
  success: boolean;
  idempotentRepeat: boolean;
  operationId: string;
  productId: string;
  message?: string;
}

export interface FirestoreCatalogTransactionContext {
  getOperation(tenantId: string, operationId: string): Promise<any>;
  getProduct(tenantId: string, productId: string): Promise<any>;
  saveProduct(tenantId: string, product: any): Promise<void>;
  updateProductStatus(tenantId: string, productId: string, isActive: boolean, updatedAt: number): Promise<void>;
  recordOperation(tenantId: string, operationId: string, data: any): Promise<void>;
}

/**
 * Adaptador de transação real do Firestore para operações de catálogo.
 */
export class RealFirestoreCatalogTransactionAdapter implements FirestoreCatalogTransactionContext {
  constructor(private firestore: admin.firestore.Firestore, private tx: admin.firestore.Transaction) {}

  async getOperation(tenantId: string, operationId: string): Promise<any> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('operations').doc(operationId);
    const snap = await this.tx.get(ref);
    return snap.exists ? snap.data() : null;
  }

  async getProduct(tenantId: string, productId: string): Promise<any> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('products').doc(productId);
    const snap = await this.tx.get(ref);
    return snap.exists ? snap.data() : null;
  }

  async saveProduct(tenantId: string, product: any): Promise<void> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('products').doc(product.id);
    this.tx.set(ref, product, { merge: true });
  }

  async updateProductStatus(tenantId: string, productId: string, isActive: boolean, updatedAt: number): Promise<void> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('products').doc(productId);
    this.tx.update(ref, { isActive, updatedAt });
  }

  async recordOperation(tenantId: string, operationId: string, data: any): Promise<void> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('operations').doc(operationId);
    this.tx.set(ref, data);
  }
}

/**
 * Calcula o hash canônico determinístico para a operação de catálogo.
 */
export function computeCanonicalCatalogHash(type: string, tenantId: string, productId: string, payload: any): string {
  const canonicalData = {
    type,
    tenantId,
    productId,
    name: payload.name ?? null,
    barcode: payload.barcode ?? null,
    costPrice: payload.costPrice !== undefined ? Number(payload.costPrice) : null,
    sellingPrice: payload.sellingPrice !== undefined ? Number(payload.sellingPrice) : null,
    minStock: payload.minStock !== undefined ? Number(payload.minStock) : null,
    unit: payload.unit ?? null,
    category: payload.category ?? null,
    ncm: payload.ncm ?? null,
    isActive: payload.isActive !== undefined ? Boolean(payload.isActive) : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalData)).digest('hex');
}

/**
 * Executa a lógica de sincronização de catálogo no Firestore com idempotência estrita.
 */
export async function executeCatalogTransactionLogic(
  tenantId: string,
  type: string,
  payload: any,
  operationId: string,
  tx: FirestoreCatalogTransactionContext
): Promise<CloudCatalogResult> {
  const productId = payload.id || payload.productId;
  if (!productId || typeof productId !== 'string' || productId.trim() === '') {
    throw new Error('INVALID_PAYLOAD: Identificador do produto (id) ausente no payload.');
  }

  const currentCanonicalHash = computeCanonicalCatalogHash(type, tenantId, productId, payload);

  // -------------------------------------------------------------------------
  // FASE 1: LEITURAS (Todas antes das escritas no Firestore)
  // -------------------------------------------------------------------------
  const existingOp = await tx.getOperation(tenantId, operationId);
  if (existingOp) {
    const isIdentical = existingOp.canonicalHash
      ? existingOp.canonicalHash === currentCanonicalHash
      : existingOp.productId === productId && existingOp.type === type;

    if (!isIdentical) {
      throw new Error(
        `INTEGRITY_CONFLICT: Operação de catálogo "${operationId}" já foi processada anteriormente com dados divergentes (hash divergente).`
      );
    }

    return {
      success: true,
      idempotentRepeat: true,
      operationId,
      productId,
      message: `Operação de catálogo "${operationId}" já processada anteriormente. Retorno idempotente.`,
    };
  }

  if (type === 'CATALOG_PRODUCT_TOGGLE') {
    const existingProduct = await tx.getProduct(tenantId, productId);
    if (!existingProduct) {
      throw new Error(`NOT_FOUND: Produto "${productId}" não encontrado no catálogo do tenant "${tenantId}".`);
    }
  }

  // -------------------------------------------------------------------------
  // FASE 2: ESCRITAS (Atômicas)
  // -------------------------------------------------------------------------
  const now = Date.now();

  if (type === 'CATALOG_PRODUCT_UPSERT') {
    const productDoc = {
      ...payload,
      id: productId,
      tenantId,
      updatedAt: now,
    };
    await tx.saveProduct(tenantId, productDoc);
  } else if (type === 'CATALOG_PRODUCT_TOGGLE') {
    const newActiveState = Boolean(payload.isActive);
    await tx.updateProductStatus(tenantId, productId, newActiveState, now);
  } else {
    throw new Error(`INVALID_PAYLOAD: Tipo de operação de catálogo desconhecido: "${type}".`);
  }

  // Grava comprovante da operação na coleção operations do tenant
  await tx.recordOperation(tenantId, operationId, {
    status: 'COMMITTED',
    operationId,
    type,
    tenantId,
    productId,
    canonicalHash: currentCanonicalHash,
    processedAt: now,
  });

  return {
    success: true,
    idempotentRepeat: false,
    operationId,
    productId,
    message: `Produto "${productId}" sincronizado com sucesso no catálogo.`,
  };
}

/**
 * Validação estrita de autorização para alterações de catálogo.
 * Apenas ADMIN e MANAGER podem alterar catálogo (CASHIER é proibido).
 */
export function assertCatalogPermissions(auth: AuthenticatedUserContext, targetTenantId: string): void {
  if (auth.tenantId !== targetTenantId) {
    throw new Error(
      `PERMISSION_DENIED: Usuário pertence ao tenant "${auth.tenantId}", acesso negado ao catálogo do tenant "${targetTenantId}".`
    );
  }

  const allowedRoles = ['ADMIN', 'MANAGER'];
  if (auth.role && !allowedRoles.includes(auth.role)) {
    throw new Error(
      `PERMISSION_DENIED: Papel "${auth.role}" não autorizado a alterar o catálogo. Apenas Administradores e Gerentes têm permissão.`
    );
  }
}

/**
 * Endpoint HTTP REST oficial para sincronização de catálogo.
 * Suporta CORS e autenticação estrita via Firebase ID Token (Bearer token).
 */
export const apiSyncCatalog = onRequest(async (req, res) => {
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
    const body = req.body as CatalogSyncPayload;

    if (!body || !body.type || !body.payload) {
      res.status(400).json({ success: false, error: 'INVALID_PAYLOAD: "type" e "payload" são obrigatórios.' });
      return;
    }

    const { type, payload } = body;
    if (type !== 'CATALOG_PRODUCT_UPSERT' && type !== 'CATALOG_PRODUCT_TOGGLE') {
      res.status(400).json({
        success: false,
        error: `INVALID_PAYLOAD: Tipo "${type}" inválido. Permitidos: CATALOG_PRODUCT_UPSERT, CATALOG_PRODUCT_TOGGLE.`,
      });
      return;
    }

    const targetTenantId = payload.tenantId || authContext.tenantId;
    assertCatalogPermissions(authContext, targetTenantId);

    const opId = body.operationId || payload.operationId || `op_cat_${payload.id}_${Date.now()}`;

    // Executa em transação Firestore com adaptador real
    const firestore = admin.firestore();
    const result = await firestore.runTransaction(async (tx) => {
      const adapter = new RealFirestoreCatalogTransactionAdapter(firestore, tx);
      return executeCatalogTransactionLogic(targetTenantId, type, payload, opId, adapter);
    });

    res.status(200).json(result);
  } catch (err: any) {
    const errMsg = err.message || String(err);
    if (errMsg.startsWith('UNAUTHENTICATED')) {
      res.status(401).json({ success: false, error: errMsg });
    } else if (errMsg.startsWith('PERMISSION_DENIED')) {
      res.status(403).json({ success: false, error: errMsg });
    } else if (errMsg.startsWith('INVALID_PAYLOAD')) {
      res.status(400).json({ success: false, error: errMsg });
    } else if (errMsg.startsWith('INTEGRITY_CONFLICT')) {
      res.status(409).json({ success: false, error: errMsg });
    } else if (errMsg.startsWith('NOT_FOUND')) {
      res.status(404).json({ success: false, error: errMsg });
    } else {
      res.status(500).json({ success: false, error: errMsg });
    }
  }
});
