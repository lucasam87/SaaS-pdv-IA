import { Sale, SystemSignal, StockMovement } from '@pdv/shared';
import * as crypto from 'crypto';
import type * as admin from 'firebase-admin';

export interface CloudSaleResult {
  success: boolean;
  idempotentRepeat: boolean;
  saleId: string;
  operationId: string;
  message?: string;
  negativeStockSignals?: SystemSignal[];
}

export interface FirestoreTransactionContext {
  getOperation(tenantId: string, operationId: string): Promise<any>;
  getSale?(tenantId: string, saleId: string): Promise<Sale | null>;
  getProduct(tenantId: string, productId: string): Promise<any>;
  saveSale(tenantId: string, sale: Sale): Promise<void>;
  updateProductStock(tenantId: string, productId: string, newStock: number): Promise<void>;
  recordStockMovement(tenantId: string, movement: StockMovement): Promise<void>;
  saveSignal(tenantId: string, signal: SystemSignal): Promise<void>;
  recordOperation(tenantId: string, operationId: string, data: any): Promise<void>;
}

/**
 * Calcula o hash canônico SHA-256 sobre os campos comerciais da venda com ordenação determinística.
 */
export function computeCanonicalSaleHash(sale: Sale): string {
  const sortedItems = [...sale.items]
    .sort((a, b) => a.productId.localeCompare(b.productId))
    .map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      discount: i.discount || 0,
      totalPrice: i.totalPrice,
    }));

  const sortedPayments = [...sale.payments]
    .sort((a, b) => a.method.localeCompare(b.method))
    .map((p) => ({
      method: p.method,
      amount: p.amount,
      changeAmount: p.changeAmount || 0,
    }));

  const canonicalPayload = {
    tenantId: sale.tenantId,
    saleId: sale.id,
    sessionId: sale.sessionId,
    deviceId: sale.deviceId,
    subtotal: sale.subtotal,
    discount: sale.discount,
    total: sale.total,
    items: sortedItems,
    payments: sortedPayments,
  };

  return crypto.createHash('sha256').update(JSON.stringify(canonicalPayload)).digest('hex');
}

/**
 * Validador rigoroso de payload e consistência financeira no servidor.
 */
export function validateSalePayload(sale: Sale, expectedTenantId?: string): void {
  if (!sale || typeof sale !== 'object') {
    throw new Error('INVALID_PAYLOAD: O objeto da venda não foi fornecido.');
  }
  if (!sale.id || typeof sale.id !== 'string' || sale.id.trim() === '') {
    throw new Error('INVALID_PAYLOAD: sale.id é obrigatório.');
  }
  if (!sale.tenantId || typeof sale.tenantId !== 'string' || sale.tenantId.trim() === '') {
    throw new Error('INVALID_PAYLOAD: sale.tenantId é obrigatório.');
  }
  if (expectedTenantId && sale.tenantId !== expectedTenantId) {
    throw new Error(`PERMISSION_DENIED: Tenant informado (${sale.tenantId}) não corresponde ao tenant autenticado (${expectedTenantId}).`);
  }
  if (!sale.deviceId || typeof sale.deviceId !== 'string' || sale.deviceId.trim() === '') {
    throw new Error('INVALID_PAYLOAD: sale.deviceId é obrigatório.');
  }
  if (!sale.userId || typeof sale.userId !== 'string' || sale.userId.trim() === '') {
    throw new Error('INVALID_PAYLOAD: sale.userId é obrigatório.');
  }
  if (!Array.isArray(sale.items) || sale.items.length === 0) {
    throw new Error('INVALID_PAYLOAD: A venda deve conter pelo menos um item.');
  }

  let calculatedGrossSubtotal = 0;
  let calculatedItemDiscounts = 0;

  for (let idx = 0; idx < sale.items.length; idx++) {
    const item = sale.items[idx];
    if (!item.productId || typeof item.productId !== 'string' || item.productId.trim() === '') {
      throw new Error(`INVALID_PAYLOAD: Item #${idx + 1} sem productId válido.`);
    }
    if (typeof item.quantity !== 'number' || item.quantity <= 0) {
      throw new Error(`INVALID_PAYLOAD: Item "${item.productName || item.productId}" possui quantidade inválida (${item.quantity}). Deve ser > 0.`);
    }
    if (typeof item.unitPrice !== 'number' || item.unitPrice < 0) {
      throw new Error(`INVALID_PAYLOAD: Item "${item.productName || item.productId}" possui unitPrice inválido (${item.unitPrice}).`);
    }
    const discount = typeof item.discount === 'number' ? item.discount : 0;
    if (discount < 0) {
      throw new Error(`INVALID_PAYLOAD: Item "${item.productName || item.productId}" possui desconto negativo.`);
    }

    calculatedGrossSubtotal += item.quantity * item.unitPrice;
    calculatedItemDiscounts += discount;

    const expectedItemTotal = Math.round((item.quantity * item.unitPrice - discount) * 100) / 100;
    if (Math.abs(item.totalPrice - expectedItemTotal) > 0.05) {
      throw new Error(
        `INVALID_PAYLOAD: Total do item #${idx + 1} (${item.totalPrice}) diverge do cálculo quantidade * preço - desconto (${expectedItemTotal}).`
      );
    }
  }

  calculatedGrossSubtotal = Math.round(calculatedGrossSubtotal * 100) / 100;
  calculatedItemDiscounts = Math.round(calculatedItemDiscounts * 100) / 100;

  if (Math.abs(sale.subtotal - calculatedGrossSubtotal) > 0.05) {
    throw new Error(
      `INVALID_PAYLOAD: Subtotal da venda (${sale.subtotal}) diverge da soma dos itens (${calculatedGrossSubtotal}).`
    );
  }

  const totalDiscount = typeof sale.discount === 'number' ? sale.discount : 0;
  if (totalDiscount < calculatedItemDiscounts - 0.05) {
    throw new Error(
      `INVALID_PAYLOAD: Desconto da venda (${totalDiscount}) é inferior à soma dos descontos dos itens (${calculatedItemDiscounts}).`
    );
  }

  const expectedSaleTotal = Math.round((sale.subtotal - totalDiscount) * 100) / 100;
  if (Math.abs(sale.total - expectedSaleTotal) > 0.05) {
    throw new Error(
      `INVALID_PAYLOAD: Total da venda (${sale.total}) diverge de subtotal - desconto (${expectedSaleTotal}).`
    );
  }
  if (sale.total < 0) {
    throw new Error('INVALID_PAYLOAD: O total da venda não pode ser negativo.');
  }

  if (!Array.isArray(sale.payments) || sale.payments.length === 0) {
    throw new Error('INVALID_PAYLOAD: A venda deve conter pelo menos uma forma de pagamento.');
  }

  let totalEffectivePayments = 0;
  for (let pIdx = 0; pIdx < sale.payments.length; pIdx++) {
    const p = sale.payments[pIdx];
    if (typeof p.amount !== 'number' || p.amount <= 0) {
      throw new Error(`INVALID_PAYLOAD: Pagamento #${pIdx + 1} possui valor inválido (${p.amount}).`);
    }
    const change = typeof p.changeAmount === 'number' ? p.changeAmount : 0;
    if (change < 0) {
      throw new Error(`INVALID_PAYLOAD: Pagamento #${pIdx + 1} possui troco negativo.`);
    }
    // Pagamentos não em dinheiro (PIX, Cartão, Fiado) não podem ter changeAmount > 0
    if (p.method !== 'DINHEIRO' && change > 0) {
      throw new Error(`INVALID_PAYLOAD: Pagamentos na forma "${p.method}" não podem conter troco (changeAmount > 0).`);
    }
    totalEffectivePayments += p.amount - change;
  }

  totalEffectivePayments = Math.round(totalEffectivePayments * 100) / 100;
  if (totalEffectivePayments < sale.total - 0.05) {
    throw new Error(
      `INVALID_PAYLOAD: Total pago líquido (R$ ${totalEffectivePayments.toFixed(2)}) é inferior ao total da venda (R$ ${sale.total.toFixed(2)}).`
    );
  }
  if (totalEffectivePayments > sale.total + 0.05) {
    throw new Error(
      `INVALID_PAYLOAD: Total pago líquido (R$ ${totalEffectivePayments.toFixed(2)}) excede o total da venda (R$ ${sale.total.toFixed(2)}).`
    );
  }
}

/**
 * Adaptador de Transação Real do Firestore.
 * Garante que todas as chamadas de leitura usem tx.get() e gravações usem tx.set()/tx.update().
 */
export class RealFirestoreTransactionAdapter implements FirestoreTransactionContext {
  constructor(
    private readonly firestore: admin.firestore.Firestore,
    private readonly tx: admin.firestore.Transaction
  ) {}

  async getOperation(tenantId: string, operationId: string): Promise<any> {
    const ref = this.firestore.doc(`tenants/${tenantId}/operations/${operationId}`);
    const snap = await this.tx.get(ref);
    return snap.exists ? snap.data() : null;
  }

  async getSale(tenantId: string, saleId: string): Promise<Sale | null> {
    const ref = this.firestore.doc(`tenants/${tenantId}/sales/${saleId}`);
    const snap = await this.tx.get(ref);
    return snap.exists ? (snap.data() as Sale) : null;
  }

  async getProduct(tenantId: string, productId: string): Promise<any> {
    const ref = this.firestore.doc(`tenants/${tenantId}/products/${productId}`);
    const snap = await this.tx.get(ref);
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async saveSale(tenantId: string, sale: Sale): Promise<void> {
    const ref = this.firestore.doc(`tenants/${tenantId}/sales/${sale.id}`);
    this.tx.set(ref, sale);
  }

  async updateProductStock(tenantId: string, productId: string, newStock: number): Promise<void> {
    const ref = this.firestore.doc(`tenants/${tenantId}/products/${productId}`);
    this.tx.update(ref, {
      currentStock: newStock,
      updatedAt: Date.now(),
    });
  }

  async recordStockMovement(tenantId: string, movement: StockMovement): Promise<void> {
    const ref = this.firestore.doc(`tenants/${tenantId}/stock_movements/${movement.id}`);
    this.tx.set(ref, movement);
  }

  async saveSignal(tenantId: string, signal: SystemSignal): Promise<void> {
    const ref = this.firestore.doc(`tenants/${tenantId}/signals/${signal.id}`);
    this.tx.set(ref, signal);
  }

  async recordOperation(tenantId: string, operationId: string, data: any): Promise<void> {
    const ref = this.firestore.doc(`tenants/${tenantId}/operations/${operationId}`);
    this.tx.set(ref, data);
  }
}

/**
 * Executa a venda em uma transação atômica real do Firestore.
 */
export async function executeFirestoreSaleTransaction(
  firestore: admin.firestore.Firestore,
  tenantId: string,
  sale: Sale
): Promise<CloudSaleResult> {
  return firestore.runTransaction(async (tx) => {
    const adapter = new RealFirestoreTransactionAdapter(firestore, tx);
    return CloudSaleHandler.processCloudSale(tenantId, sale, adapter);
  });
}

/**
 * Processador de Venda na Nuvem com Idempotência Estrita por Operação e Ordem Estrita de Transação.
 * 
 * Regras implementadas:
 * 1. Validação completa do payload e aritmética antes da transação.
 * 2. ORDEM ESTRITA DE TRANSAÇÃO: Todas as leituras (operação + todos os produtos)
 *    são executadas ANTES de qualquer escrita (exigência indispensável do Firestore).
 * 3. Consolidação de quantidades para produtos que aparecem em múltiplos itens da mesma venda.
 * 4. Detecção de divergência comercial para mesmo operationId (rejeita alterações silenciosas via hash canônico).
 * 5. Escritas atômicas: venda, movimentações de estoque, atualização de saldo, sinais e comprovante de operação.
 * 6. Suporte a estoque negativo para vendas físicas válidas com emissão de SystemSignal auditável.
 */
export class CloudSaleHandler {
  public static async processCloudSale(
    tenantId: string,
    sale: Sale,
    tx: FirestoreTransactionContext
  ): Promise<CloudSaleResult> {
    // 1. Validação estrita do payload e coerência do tenant
    validateSalePayload(sale, tenantId);

    const opId = sale.operationId || sale.id;
    const currentCanonicalHash = computeCanonicalSaleHash(sale);

    // -----------------------------------------------------------------------
    // FASE 1: LEITURAS (TODAS AS LEITURAS ANTES DE QUALQUER ESCRITA)
    // -----------------------------------------------------------------------

    // Leitura 1: Comprovante de Operação existente (verificação de idempotência e divergência)
    const existingOp = await tx.getOperation(tenantId, opId);
    if (existingOp) {
      let isIdentical = false;
      if (existingOp.canonicalHash) {
        isIdentical = existingOp.canonicalHash === currentCanonicalHash;
      } else {
        const sameSaleId = !existingOp.saleId || existingOp.saleId === sale.id;
        const sameTotal = Math.abs(Number(existingOp.total) - Number(sale.total)) < 0.01;
        const sameSubtotal =
          existingOp.subtotal === undefined || Math.abs(Number(existingOp.subtotal) - Number(sale.subtotal)) < 0.01;
        const sameItemsCount =
          existingOp.itemsCount === undefined || Number(existingOp.itemsCount) === sale.items.length;
        isIdentical = sameSaleId && sameTotal && sameSubtotal && sameItemsCount;
      }

      if (!isIdentical) {
        throw new Error(
          `INTEGRITY_CONFLICT: Operação comercial "${opId}" já foi gravada com dados divergentes (hash divergente). Rejeitando alteração.`
        );
      }

      return {
        success: true,
        idempotentRepeat: true,
        saleId: sale.id,
        operationId: opId,
        message: `Operação "${opId}" já processada com sucesso anteriormente. Re-execução ignorada.`,
      };
    }

    // Leitura 1b: Se a operação é nova, verifica se o saleId já foi gravado sob outro operationId
    // para prevenir duplicidade de venda com redução duplicada de estoque
    if (tx.getSale) {
      const existingSale = await tx.getSale(tenantId, sale.id);
      if (existingSale && (existingSale.operationId || existingSale.id) !== opId) {
        throw new Error(
          `INTEGRITY_CONFLICT: Venda com saleId "${sale.id}" já foi gravada sob outra operação ("${existingSale.operationId || existingSale.id}"). Rejeitando duplicidade de venda.`
        );
      }
    }

    // Consolidação de quantidades por produto: produtos repetidos em diferentes itens são somados
    const consolidated = new Map<
      string,
      {
        productId: string;
        productName: string;
        barcode: string;
        totalQuantity: number;
        unitPrice: number;
      }
    >();

    for (const item of sale.items) {
      const existing = consolidated.get(item.productId);
      if (existing) {
        existing.totalQuantity += item.quantity;
      } else {
        consolidated.set(item.productId, {
          productId: item.productId,
          productName: item.productName,
          barcode: item.barcode,
          totalQuantity: item.quantity,
          unitPrice: item.unitPrice,
        });
      }
    }

    const consolidatedItems = Array.from(consolidated.values());

    // Leitura 2: Todos os produtos envolvidos lidos em paralelo ANTES de qualquer escrita
    const productDocs = await Promise.all(
      consolidatedItems.map((c) => tx.getProduct(tenantId, c.productId))
    );

    // -----------------------------------------------------------------------
    // FASE 2: ESCRITAS (TODAS AS GRAVAÇÕES ATÔMICAS)
    // -----------------------------------------------------------------------

    const negativeSignals: SystemSignal[] = [];
    const now = Date.now();

    // 1. Grava a Venda
    const cloudSale: Sale = {
      ...sale,
      operationId: opId,
      syncedAt: now,
    };
    await tx.saveSale(tenantId, cloudSale);

    // 2. Grava baixa de estoque e movimentações consolidadas
    for (let i = 0; i < consolidatedItems.length; i++) {
      const itemGroup = consolidatedItems[i];
      const product = productDocs[i];
      const currentStock = product ? Number(product.currentStock ?? 0) : 0;
      const newStock = currentStock - itemGroup.totalQuantity;

      // Atualiza o estoque no produto (mesmo se ficar negativo)
      await tx.updateProductStock(tenantId, itemGroup.productId, newStock);

      // Registra a movimentação rastreável de estoque (StockMovement)
      const stockMovement: StockMovement = {
        id: `sm_${sale.id}_${itemGroup.productId}`,
        tenantId,
        productId: itemGroup.productId,
        type: 'SALE',
        quantity: -itemGroup.totalQuantity,
        balanceAfter: newStock,
        reason: `Venda ${sale.saleNumber || sale.id}`,
        userId: sale.userId,
        userName: sale.userName,
        deviceId: sale.deviceId,
        createdAt: now,
      };
      await tx.recordStockMovement(tenantId, stockMovement);

      // Se o estoque ficou negativo, registra sinal de auditoria operacional
      if (newStock < 0) {
        const signal: SystemSignal = {
          id: `signal_neg_${now}_${itemGroup.productId}`,
          tenantId,
          type: 'STOCK_NEGATIVE_CONFLICT',
          severity: 'WARNING',
          payload: {
            productId: itemGroup.productId,
            productName: itemGroup.productName,
            barcode: itemGroup.barcode,
            negativeBalance: newStock,
            saleIds: [sale.id],
            deviceIds: [sale.deviceId],
            occurredAt: now,
          },
          createdAt: now,
        };
        await tx.saveSignal(tenantId, signal);
        negativeSignals.push(signal);
      }
    }

    // 3. Grava o comprovante da operação para selar a barreira de idempotência
    await tx.recordOperation(tenantId, opId, {
      status: 'COMMITTED',
      operationId: opId,
      saleId: sale.id,
      tenantId,
      deviceId: sale.deviceId,
      subtotal: sale.subtotal,
      discount: sale.discount,
      total: sale.total,
      itemsCount: sale.items.length,
      canonicalHash: currentCanonicalHash,
      processedAt: now,
    });

    return {
      success: true,
      idempotentRepeat: false,
      saleId: sale.id,
      operationId: opId,
      negativeStockSignals: negativeSignals.length > 0 ? negativeSignals : undefined,
    };
  }
}
