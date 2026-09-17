import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { verifyAuthToken, AuthenticatedUserContext } from './sale-endpoint';

// Inicialização segura do Firebase Admin
if (admin.apps.length === 0) {
  admin.initializeApp();
}

export const VALID_PRODUCT_UNITS = ['UN', 'KG', 'CX', 'PCT', 'L', 'M'] as const;
export type ValidProductUnit = typeof VALID_PRODUCT_UNITS[number];

export interface ValidatedCatalogUpsert {
  id: string;
  tenantId: string;
  name: string;
  barcode: string;
  costPrice: number;
  sellingPrice: number;
  minStock: number;
  unit: ValidProductUnit;
  category: string;
  ncm?: string;
  isActive: boolean;
  initialStock?: number;
}

export interface ValidatedCatalogToggle {
  id: string;
  tenantId: string;
  isActive: boolean;
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
  getBarcodeReservation(tenantId: string, barcode: string): Promise<{ productId: string } | null>;
  saveBarcodeReservation(tenantId: string, barcode: string, productId: string): Promise<void>;
  deleteBarcodeReservation(tenantId: string, barcode: string): Promise<void>;
}

/**
 * Validação rigorosa do payload de catálogo no servidor sem uso de `any` irrestrito.
 */
export function validateCatalogPayload(
  type: string,
  rawPayload: unknown,
  expectedTenantId: string
): { productId: string; upsertData?: ValidatedCatalogUpsert; toggleData?: ValidatedCatalogToggle } {
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw new Error('INVALID_PAYLOAD: Payload da operação de catálogo deve ser um objeto válido.');
  }

  const payload = rawPayload as Record<string, unknown>;
  const productId = (payload.id || payload.productId) as string | undefined;

  if (!productId || typeof productId !== 'string' || productId.trim() === '') {
    throw new Error('INVALID_PAYLOAD: Identificador do produto (id) é obrigatório e não pode ser vazio.');
  }

  const payloadTenant = payload.tenantId as string | undefined;
  if (payloadTenant && payloadTenant !== expectedTenantId) {
    throw new Error(
      `PERMISSION_DENIED: Tenant informado no payload ("${payloadTenant}") diverge do contexto autenticado ("${expectedTenantId}").`
    );
  }

  if (type === 'CATALOG_PRODUCT_UPSERT') {
    // 1. Validação de Nome
    const name = payload.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('INVALID_PAYLOAD: "name" do produto é obrigatório e não pode ser vazio.');
    }

    // 2. Validação de Código de Barras
    const rawBarcode = payload.barcode;
    if (typeof rawBarcode !== 'string' || rawBarcode.trim() === '') {
      throw new Error('INVALID_PAYLOAD: "barcode" do produto é obrigatório e não pode ser vazio.');
    }
    const barcode = rawBarcode.trim();
    if (/[\x00-\x1F\x7F]/.test(barcode)) {
      throw new Error('INVALID_PAYLOAD: "barcode" contém caracteres de controle ASCII inválidos.');
    }

    // 3. Validação de Preços e Estoques
    const costPrice = Number(payload.costPrice);
    if (typeof payload.costPrice !== 'number' || isNaN(costPrice) || !isFinite(costPrice) || costPrice < 0) {
      throw new Error(`INVALID_PAYLOAD: "costPrice" inválido (${payload.costPrice}). Deve ser um número finito maior ou igual a zero.`);
    }

    const sellingPrice = Number(payload.sellingPrice);
    if (typeof payload.sellingPrice !== 'number' || isNaN(sellingPrice) || !isFinite(sellingPrice) || sellingPrice <= 0) {
      throw new Error(`INVALID_PAYLOAD: "sellingPrice" inválido (${payload.sellingPrice}). Deve ser um número finito estritamente maior que zero.`);
    }

    const minStock = Number(payload.minStock);
    if (typeof payload.minStock !== 'number' || isNaN(minStock) || !isFinite(minStock) || minStock < 0) {
      throw new Error(`INVALID_PAYLOAD: "minStock" inválido (${payload.minStock}). Deve ser um número finito maior ou igual a zero.`);
    }

    // 4. Validação de Unidade
    const unit = payload.unit as ValidProductUnit;
    if (!VALID_PRODUCT_UNITS.includes(unit)) {
      throw new Error(`INVALID_PAYLOAD: "unit" inválida ("${payload.unit}"). Permitidas: ${VALID_PRODUCT_UNITS.join(', ')}.`);
    }

    // 5. Validação de NCM
    let cleanNcm: string | undefined = undefined;
    if (payload.ncm !== undefined && payload.ncm !== null && payload.ncm !== '') {
      if (typeof payload.ncm !== 'string') {
        throw new Error('INVALID_PAYLOAD: "ncm" deve ser uma string de dígitos.');
      }
      const digits = payload.ncm.replace(/\D/g, '');
      if (digits.length < 2 || digits.length > 8) {
        throw new Error(`INVALID_PAYLOAD: "ncm" inválido ("${payload.ncm}"). Deve conter entre 2 e 8 dígitos numéricos.`);
      }
      cleanNcm = digits;
    }

    // 6. Validação de isActive (estritamente booleano se informado)
    let isActive = true;
    if (payload.isActive !== undefined && payload.isActive !== null) {
      if (typeof payload.isActive !== 'boolean') {
        throw new Error(`INVALID_PAYLOAD: "isActive" deve ser estritamente booleano (true ou false). Recebido: ${typeof payload.isActive}`);
      }
      isActive = payload.isActive;
    }

    // 7. Validação de initialStock
    let initialStock = 0;
    if (payload.initialStock !== undefined && payload.initialStock !== null) {
      const numInit = Number(payload.initialStock);
      if (typeof payload.initialStock !== 'number' || isNaN(numInit) || !isFinite(numInit) || numInit < 0) {
        throw new Error('INVALID_PAYLOAD: "initialStock" deve ser número finito maior ou igual a zero.');
      }
      initialStock = numInit;
    }

    const category = typeof payload.category === 'string' && payload.category.trim() !== '' ? payload.category.trim() : 'Geral';

    return {
      productId,
      upsertData: {
        id: productId,
        tenantId: expectedTenantId,
        name: name.trim(),
        barcode,
        costPrice,
        sellingPrice,
        minStock,
        unit,
        category,
        ncm: cleanNcm,
        isActive,
        initialStock,
      },
    };
  }

  if (type === 'CATALOG_PRODUCT_TOGGLE') {
    if (typeof payload.isActive !== 'boolean') {
      throw new Error(`INVALID_PAYLOAD: "isActive" deve ser estritamente booleano (true ou false). Recebido: ${typeof payload.isActive}`);
    }

    return {
      productId,
      toggleData: {
        id: productId,
        tenantId: expectedTenantId,
        isActive: payload.isActive,
      },
    };
  }

  throw new Error(`INVALID_PAYLOAD: Tipo de operação de catálogo desconhecido: "${type}".`);
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

  async getBarcodeReservation(tenantId: string, barcode: string): Promise<{ productId: string } | null> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('barcode_reservations').doc(barcode);
    const snap = await this.tx.get(ref);
    return snap.exists ? (snap.data() as { productId: string }) : null;
  }

  async saveBarcodeReservation(tenantId: string, barcode: string, productId: string): Promise<void> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('barcode_reservations').doc(barcode);
    this.tx.set(ref, {
      productId,
      barcode,
      tenantId,
      reservedAt: Date.now(),
    });
  }

  async deleteBarcodeReservation(tenantId: string, barcode: string): Promise<void> {
    const ref = this.firestore.collection('tenants').doc(tenantId).collection('barcode_reservations').doc(barcode);
    this.tx.delete(ref);
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
 * Executa a lógica de sincronização de catálogo no Firestore com idempotência estrita,
 * validação estrita de payload e preservação de estoque existente.
 */
export async function executeCatalogTransactionLogic(
  tenantId: string,
  type: string,
  payload: any,
  operationId: string,
  tx: FirestoreCatalogTransactionContext
): Promise<CloudCatalogResult> {
  // 1. Validação estrita de payload sem any
  const validated = validateCatalogPayload(type, payload, tenantId);
  const productId = validated.productId;

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

  const existingProduct = await tx.getProduct(tenantId, productId);
  if (type === 'CATALOG_PRODUCT_TOGGLE' && !existingProduct) {
    throw new Error(`NOT_FOUND: Produto "${productId}" não encontrado no catálogo do tenant "${tenantId}".`);
  }

  // Se for UPSERT, valida reserva de código de barras
  if (type === 'CATALOG_PRODUCT_UPSERT' && validated.upsertData) {
    const reservation = await tx.getBarcodeReservation(tenantId, validated.upsertData.barcode);
    if (reservation && reservation.productId !== productId) {
      throw new Error(
        `INTEGRITY_CONFLICT: Código de barras "${validated.upsertData.barcode}" já está reservado pelo produto "${reservation.productId}" no tenant "${tenantId}".`
      );
    }
  }

  // -------------------------------------------------------------------------
  // FASE 2: ESCRITAS (Atômicas)
  // -------------------------------------------------------------------------
  const now = Date.now();

  if (type === 'CATALOG_PRODUCT_UPSERT' && validated.upsertData) {
    const data = validated.upsertData;

    // Se o produto já existia e alterou o código de barras, remove a reserva antiga
    if (existingProduct && existingProduct.barcode && existingProduct.barcode.trim() !== data.barcode) {
      await tx.deleteBarcodeReservation(tenantId, existingProduct.barcode.trim());
    }

    // Cria/atualiza a reserva do novo código de barras na mesma transação
    await tx.saveBarcodeReservation(tenantId, data.barcode, productId);

    // PROTEÇÃO CRÍTICA DE ESTOQUE REMOTO:
    // Se o produto já existe no banco remoto, currentStock PRESERVA o saldo existente no Firestore.
    // O payload cadastral NUNCA sobrescreve saldo existente.
    // Nunca usa spread irrestrito (...payload).
    const productDoc = {
      id: productId,
      tenantId,
      name: data.name,
      barcode: data.barcode,
      costPrice: data.costPrice,
      sellingPrice: data.sellingPrice,
      minStock: data.minStock,
      unit: data.unit,
      category: data.category,
      ncm: data.ncm || null,
      isActive: data.isActive,
      currentStock: existingProduct ? (existingProduct.currentStock ?? 0) : (data.initialStock ?? 0),
      createdAt: existingProduct?.createdAt || now,
      updatedAt: now,
    };

    await tx.saveProduct(tenantId, productDoc);
  } else if (type === 'CATALOG_PRODUCT_TOGGLE' && validated.toggleData) {
    await tx.updateProductStatus(tenantId, productId, validated.toggleData.isActive, now);
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
 * Apenas ADMIN e MANAGER podem alterar catálogo (CASHIER e roles ausentes são estritamente rejeitados).
 */
export function assertCatalogPermissions(auth: AuthenticatedUserContext, targetTenantId: string): void {
  if (!auth || !auth.tenantId || auth.tenantId !== targetTenantId) {
    throw new Error(
      `PERMISSION_DENIED: Usuário pertence ao tenant "${auth?.tenantId || 'DESCONHECIDO'}", acesso negado ao catálogo do tenant "${targetTenantId}".`
    );
  }

  if (!auth.role) {
    throw new Error('PERMISSION_DENIED: Papel (role) do usuário não informado ou ausente.');
  }

  const allowedRoles = ['ADMIN', 'MANAGER'];
  if (!allowedRoles.includes(auth.role)) {
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

    const targetTenantId = (payload && typeof payload === 'object' && 'tenantId' in payload && payload.tenantId)
      ? String(payload.tenantId)
      : authContext.tenantId;

    assertCatalogPermissions(authContext, targetTenantId);

    const opId = body.operationId || payload.operationId || `op_cat_${payload.id || payload.productId}_${Date.now()}`;

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
