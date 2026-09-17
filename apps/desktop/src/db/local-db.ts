import { Product, ProductUnit, Sale, CashSession, CashMovement } from '@pdv/shared';
import { ISqliteDriver, createSqliteDriver } from './sqlite-driver';
import { runMigrations } from './schema';

export interface LocalSyncMeta {
  lastSyncAt: number;
  totalLocalProducts: number;
  pendingSalesCount: number;
}

export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED' | 'REVIEW_REQUIRED';

export interface OutboxRecord {
  id: string;
  tenantId: string;
  type: string;
  operationId: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  lastError?: string;
  nextAttemptAt: number;
  processingDeadline: number;
  createdAt: number;
  updatedAt: number;
}

export class ValidationError extends Error {
  public field: string;
  constructor(field: string, message: string) {
    super(`[ValidationError] ${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export class LocalDatabase {
  private driver: ISqliteDriver;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;
  private activeTenantId: string | null = null;

  // Cache em memória para busca instantânea de produtos (< 1ms para leitor de código de barras)
  // Isolado por chave composta: `${tenantId}:${barcode}` e `${tenantId}:${id}`
  private productsByBarcode: Map<string, Product> = new Map();
  private productsById: Map<string, Product> = new Map();
  private productsList: Product[] = [];

  constructor(driver?: ISqliteDriver) {
    this.driver = driver || createSqliteDriver();
  }

  public setActiveTenantId(tenantId: string | null): void {
    this.activeTenantId = tenantId ? tenantId.trim() : null;
  }

  public getActiveTenantId(): string | null {
    return this.activeTenantId;
  }

  /**
   * Centraliza a inicialização do banco de dados em uma única Promise memoizada.
   * Aguarda migrations DDL e carga completa do cache antes de resolver.
   */
  public initialize(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        console.log('[LocalDB] initialize: Running migrations...');
        await runMigrations(this.driver);
        console.log('[LocalDB] initialize: Migrations completed, loading cache...');
        await this.loadProductsIntoCache();
        console.log('[LocalDB] initialize: Products loaded, database ready.');
        this.initialized = true;
      })().catch((err) => {
        console.error('[LocalDB] initialize error:', err);
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }

  public isReady(): boolean {
    return this.initialized;
  }

  public async ensureReady(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  public async loadProductsIntoCache(tenantId?: string): Promise<void> {
    try {
      if (tenantId) {
        this.activeTenantId = tenantId.trim();
      }

      const rows = await this.driver.query<Record<string, unknown>>(
        'SELECT * FROM local_products WHERE is_active = 1;'
      );
      this.populateCacheFromRows(rows);
    } catch (err) {
      console.error('[LocalDB] Erro ao carregar produtos para cache:', err);
      throw err;
    }
  }

  private mapProductRow(r: Record<string, unknown>): Product {
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      name: String(r.name),
      barcode: String(r.barcode),
      costPrice: Number(r.cost_price),
      sellingPrice: Number(r.selling_price),
      minStock: Number(r.min_stock),
      currentStock: Number(r.current_stock),
      unit: (r.unit as ProductUnit) || 'UN',
      category: (r.category as string) || 'Geral',
      ncm: r.ncm ? String(r.ncm) : undefined,
      isActive: Boolean(r.is_active),
      createdAt: Number(r.updated_at),
      updatedAt: Number(r.updated_at),
    };
  }

  private populateCacheFromRows(rows: Record<string, unknown>[]) {
    this.productsByBarcode.clear();
    this.productsById.clear();
    this.productsList = rows.map((r) => this.mapProductRow(r));

    const distinctTenants = new Set(this.productsList.map((p) => p.tenantId));
    if (!this.activeTenantId && distinctTenants.size === 1) {
      this.activeTenantId = distinctTenants.values().next().value ?? null;
    }

    for (const p of this.productsList) {
      const tenantKey = p.tenantId.trim();
      this.productsById.set(`${tenantKey}:${p.id}`, p);
      if (p.barcode) {
        this.productsByBarcode.set(`${tenantKey}:${p.barcode.trim()}`, p);
      }
    }
  }

  // --- Buscas Síncronas Instantâneas no Cache (< 1ms) ---

  public findByBarcode(barcode: string, tenantId?: string): Product | undefined {
    const targetTenant = tenantId || this.activeTenantId;
    if (!targetTenant) return undefined;
    return this.productsByBarcode.get(`${targetTenant}:${barcode.trim()}`);
  }

  public findById(id: string, tenantId?: string): Product | undefined {
    const targetTenant = tenantId || this.activeTenantId;
    if (!targetTenant) return undefined;
    return this.productsById.get(`${targetTenant}:${id}`);
  }

  public search(query: string, limit: number = 20, tenantId?: string): Product[] {
    const targetTenant = tenantId || this.activeTenantId;
    if (!targetTenant) return [];

    const q = query.toLowerCase().trim();
    if (!q) return [];

    const results: Product[] = [];
    for (const p of this.productsList) {
      if (p.tenantId !== targetTenant) continue;
      if (p.name.toLowerCase().includes(q) || p.barcode.includes(q)) {
        results.push(p);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  // --- Operações Assíncronas de Persistência no SQLite ---

  /**
   * Atualiza produtos no SQLite e atualiza o cache em memória atomicamente.
   */
  public async upsertDeltaProducts(incomingProducts: Product[], syncTimestamp: number, tenantId?: string): Promise<void> {
    await this.ensureReady();
    const targetTenant = tenantId || this.activeTenantId;

    await this.driver.transaction(async (tx) => {
      for (const p of incomingProducts) {
        if (targetTenant && p.tenantId && p.tenantId !== targetTenant) {
          throw new ValidationError('tenantId', `Produto "${p.name}" possui tenantId (${p.tenantId}) divergente do contexto (${targetTenant}).`);
        }
        await tx.execute(
          `INSERT INTO local_products (
            id, tenant_id, name, barcode, cost_price, selling_price,
            min_stock, current_stock, unit, category, ncm, is_active, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            barcode = excluded.barcode,
            cost_price = excluded.cost_price,
            selling_price = excluded.selling_price,
            min_stock = excluded.min_stock,
            current_stock = excluded.current_stock,
            unit = excluded.unit,
            category = excluded.category,
            ncm = excluded.ncm,
            is_active = excluded.is_active,
            updated_at = excluded.updated_at;`,
          [
            p.id,
            p.tenantId,
            p.name,
            p.barcode,
            p.costPrice,
            p.sellingPrice,
            p.minStock,
            p.currentStock,
            p.unit || 'UN',
            p.category || 'Geral',
            p.ncm || null,
            p.isActive ? 1 : 0,
            syncTimestamp,
          ]
        );
      }

      await tx.execute(
        `INSERT INTO sync_metadata (key, value, updated_at) VALUES ('lastSyncAt', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
        [String(syncTimestamp), syncTimestamp]
      );
    });

    await this.loadProductsIntoCache(targetTenant || undefined);
  }

  /**
   * Retorna todos os produtos do SQLite, com opção de incluir inativos para o tenant ativo.
   */
  public async getAllProducts(includeInactive: boolean = false, tenantId?: string): Promise<Product[]> {
    await this.ensureReady();
    const targetTenant = tenantId || this.activeTenantId;
    if (!targetTenant) {
      throw new Error('[LocalDB] tenantId is required to query products');
    }
    const sql = includeInactive
      ? 'SELECT * FROM local_products WHERE tenant_id = ? ORDER BY name ASC;'
      : 'SELECT * FROM local_products WHERE is_active = 1 AND tenant_id = ? ORDER BY name ASC;';
    const rows = await this.driver.query<Record<string, unknown>>(sql, [targetTenant]);
    return rows.map((r) => this.mapProductRow(r));
  }

  /**
   * Salva ou atualiza um produto no SQLite com validação estrita, garantia de unicidade de barcode por tenant,
   * gravação de evento transacional na outbox e atualização imediata do cache em memória.
   */
  public async saveProduct(
    input: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> & { id?: string; createdAt?: number; updatedAt?: number },
    tenantId?: string
  ): Promise<Product> {
    await this.ensureReady();

    // 1. Validação estrita de Tenant
    const targetTenant = input.tenantId?.trim() || tenantId || this.activeTenantId;
    if (!targetTenant) {
      throw new ValidationError('tenantId', 'Tenant ID é obrigatório.');
    }
    if (this.activeTenantId && targetTenant !== this.activeTenantId) {
      throw new ValidationError('tenantId', `Tenant ID (${targetTenant}) diverge do contexto ativo (${this.activeTenantId}).`);
    }

    // 2. Validação estrita de Nome
    const name = input.name ? input.name.trim() : '';
    if (!name) {
      throw new ValidationError('name', 'Nome do produto é obrigatório e não pode ser vazio.');
    }

    // 3. Validação estrita de Código de Barras
    const barcode = input.barcode ? input.barcode.trim() : '';
    if (!barcode) {
      throw new ValidationError('barcode', 'Código de barras é obrigatório e não pode ser vazio.');
    }
    if (/[\x00-\x1F\x7F]/.test(barcode)) {
      throw new ValidationError('barcode', 'Código de barras contém caracteres de controle não imprimíveis inválidos.');
    }

    // 4. Validação estrita de Preço de Custo
    if (typeof input.costPrice !== 'number' || isNaN(input.costPrice) || !isFinite(input.costPrice) || input.costPrice < 0) {
      throw new ValidationError('costPrice', `Preço de custo inválido (${input.costPrice}). Deve ser um número maior ou igual a zero.`);
    }

    // 5. Validação estrita de Preço de Venda
    if (typeof input.sellingPrice !== 'number' || isNaN(input.sellingPrice) || !isFinite(input.sellingPrice) || input.sellingPrice <= 0) {
      throw new ValidationError('sellingPrice', `Preço de venda inválido (${input.sellingPrice}). Deve ser um número estritamente maior que zero.`);
    }

    // 6. Validação estrita de Estoques
    if (typeof input.minStock !== 'number' || isNaN(input.minStock) || !isFinite(input.minStock) || input.minStock < 0) {
      throw new ValidationError('minStock', `Estoque mínimo inválido (${input.minStock}). Não pode ser negativo.`);
    }
    if (typeof input.currentStock !== 'number' || isNaN(input.currentStock) || !isFinite(input.currentStock)) {
      throw new ValidationError('currentStock', `Estoque atual inválido (${input.currentStock}). Deve ser um número finito.`);
    }

    // 7. Validação estrita de Unidade
    const validUnits: ProductUnit[] = ['UN', 'KG', 'CX', 'PCT', 'L', 'M'];
    const unit = input.unit as ProductUnit;
    if (!unit || !validUnits.includes(unit)) {
      throw new ValidationError('unit', `Unidade "${unit}" inválida. Permitidas: ${validUnits.join(', ')}.`);
    }

    // 8. Validação estrita de NCM (opcional, mas se informado deve ter entre 2 e 8 dígitos numéricos)
    let cleanNcm: string | undefined = undefined;
    if (input.ncm !== undefined && input.ncm !== null && String(input.ncm).trim() !== '') {
      const stripped = String(input.ncm).replace(/[\.\s]/g, '');
      if (!/^\d{2,8}$/.test(stripped)) {
        throw new ValidationError('ncm', `NCM "${input.ncm}" inválido. Deve conter entre 2 e 8 dígitos numéricos.`);
      }
      cleanNcm = stripped;
    }

    const now = Date.now();
    const id = input.id || `prod_${now}_${Math.floor(Math.random() * 1000)}`;

    const product: Product = {
      id,
      tenantId: targetTenant,
      name,
      barcode,
      costPrice: input.costPrice,
      sellingPrice: input.sellingPrice,
      minStock: input.minStock,
      currentStock: input.currentStock,
      unit,
      category: input.category?.trim() || 'Geral',
      ncm: cleanNcm,
      isActive: input.isActive !== false,
      createdAt: input.createdAt || now,
      updatedAt: now,
    };

    // Executa em transação atômica para evitar race conditions em validação concorrente de barcode
    await this.driver.transaction(async (tx) => {
      const existingBarcode = await tx.query<{ id: string; name: string }>(
        'SELECT id, name FROM local_products WHERE barcode = ? AND tenant_id = ? AND id != ? AND is_active = 1;',
        [barcode, targetTenant, id]
      );
      if (existingBarcode.length > 0) {
        throw new Error(`Código de barras "${barcode}" já está em uso pelo produto "${existingBarcode[0].name}" no tenant "${targetTenant}".`);
      }

      await tx.execute(
        `INSERT INTO local_products (
          id, tenant_id, name, barcode, cost_price, selling_price,
          min_stock, current_stock, unit, category, ncm, is_active, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          barcode = excluded.barcode,
          cost_price = excluded.cost_price,
          selling_price = excluded.selling_price,
          min_stock = excluded.min_stock,
          current_stock = excluded.current_stock,
          unit = excluded.unit,
          category = excluded.category,
          ncm = excluded.ncm,
          is_active = excluded.is_active,
          updated_at = excluded.updated_at;`,
        [
          product.id,
          product.tenantId,
          product.name,
          product.barcode,
          product.costPrice,
          product.sellingPrice,
          product.minStock,
          product.currentStock,
          product.unit,
          product.category,
          product.ncm || null,
          product.isActive ? 1 : 0,
          now,
        ]
      );

      // Enfileira evento de catálogo na Outbox transacionalmente
      const operationId = `op_cat_upsert_${product.id}_${now}`;
      const outboxId = `outbox_${operationId}`;
      await tx.execute(
        `INSERT INTO outbox_operations (
          id, tenant_id, type, operation_id, payload, status, attempts, next_attempt_at, processing_deadline, created_at, updated_at
        ) VALUES (?, ?, 'CATALOG_PRODUCT_UPSERT', ?, ?, 'PENDING', 0, 0, 0, ?, ?);`,
        [
          outboxId,
          product.tenantId,
          operationId,
          JSON.stringify(product),
          now,
          now,
        ]
      );
    });

    // Atualiza imediatamente o cache em memória do tenant ativo
    await this.loadProductsIntoCache(targetTenant);
    return product;
  }

  /**
   * Ativa ou desativa um produto no banco, registra evento na outbox e reflete no cache.
   */
  public async toggleProductStatus(productId: string, tenantId?: string): Promise<boolean> {
    await this.ensureReady();
    const targetTenant = tenantId || this.activeTenantId;
    if (!targetTenant) {
      throw new Error('[LocalDB] tenantId is required to toggle product status');
    }

    const now = Date.now();
    return await this.driver.transaction(async (tx) => {
      const rows = await tx.query<{ is_active: number }>(
        'SELECT is_active FROM local_products WHERE id = ? AND tenant_id = ?;',
        [productId, targetTenant]
      );
      if (rows.length === 0) {
        throw new Error(`Produto "${productId}" não encontrado para o tenant "${targetTenant}".`);
      }
      const newStatus = rows[0].is_active === 1 ? 0 : 1;
      await tx.execute(
        'UPDATE local_products SET is_active = ?, updated_at = ? WHERE id = ? AND tenant_id = ?;',
        [newStatus, now, productId, targetTenant]
      );

      const operationId = `op_cat_toggle_${productId}_${now}`;
      const outboxId = `outbox_${operationId}`;
      const togglePayload = {
        id: productId,
        tenantId: targetTenant,
        isActive: newStatus === 1,
        updatedAt: now,
      };

      await tx.execute(
        `INSERT INTO outbox_operations (
          id, tenant_id, type, operation_id, payload, status, attempts, next_attempt_at, processing_deadline, created_at, updated_at
        ) VALUES (?, ?, 'CATALOG_PRODUCT_TOGGLE', ?, ?, 'PENDING', 0, 0, 0, ?, ?);`,
        [
          outboxId,
          targetTenant,
          operationId,
          JSON.stringify(togglePayload),
          now,
          now,
        ]
      );

      return newStatus === 1;
    });
  }

  /**
   * Retorna lista de categorias distintas existentes na loja para o tenant.
   */
  public async getCategories(tenantId?: string): Promise<string[]> {
    await this.ensureReady();
    const targetTenant = tenantId || this.activeTenantId;
    if (!targetTenant) {
      throw new Error('[LocalDB] tenantId is required to query categories');
    }
    const rows = await this.driver.query<{ category: string }>(
      'SELECT DISTINCT category FROM local_products WHERE category IS NOT NULL AND category != "" AND tenant_id = ? ORDER BY category ASC;',
      [targetTenant]
    );
    return rows.map((r) => r.category);
  }

  /**
   * Gravação de Venda Atômica com Idempotência e Propagação Estrita de Erro.
   *
   * Transação única engloba:
   * 1. Verificação de idempotência (sale.id).
   * 2. Insert em local_sales.
   * 3. Insert em local_sale_items.
   * 4. Insert em local_sale_payments.
   * 5. Baixa de estoque em local_products com filtro estrito de tenant e log em local_stock_movements.
   * 6. Insert em outbox_operations.
   *
   * Se qualquer etapa falhar, ocorre ROLLBACK completo e o erro é propagado.
   */
  public async recordLocalSale(sale: Sale): Promise<void> {
    await this.ensureReady();

    await this.driver.transaction(async (tx) => {
      // 1. Guarda de Idempotência e Detecção de Conteúdo Comercial Divergente
      const existing = await tx.query<{ id: string; total: number; subtotal: number }>(
        'SELECT id, total, subtotal FROM local_sales WHERE id = ?;',
        [sale.id]
      );
      if (existing.length > 0) {
        const row = existing[0];
        const existingTotal = Number(row.total);
        const existingSubtotal = Number(row.subtotal);
        const tolerance = 0.001;

        const isDivergent =
          Math.abs(existingTotal - sale.total) > tolerance ||
          Math.abs(existingSubtotal - sale.subtotal) > tolerance;

        if (isDivergent) {
          throw new Error(
            `[LocalDB] Conflito de integridade comercial: Venda "${sale.id}" já foi gravada com valores divergentes (Gravado: R$ ${existingTotal.toFixed(2)}, Recebido: R$ ${sale.total.toFixed(2)}). Operação abortada para evitar corrupção.`
          );
        }

        console.warn(`[LocalDB] Venda "${sale.id}" já gravada anteriormente com conteúdo idêntico. Ignorando re-gravação idempotente.`);
        return;
      }

      // 2. Insert da Venda
      await tx.execute(
        `INSERT INTO local_sales (
          id, tenant_id, session_id, device_id, sale_number, user_id, user_name,
          customer_name, subtotal, discount, total, total_cost, status, created_at, synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          sale.id,
          sale.tenantId,
          sale.sessionId,
          sale.deviceId,
          sale.saleNumber,
          sale.userId,
          sale.userName,
          sale.customerName || null,
          sale.subtotal,
          sale.discount,
          sale.total,
          sale.totalCost,
          sale.status,
          sale.createdAt,
          sale.syncedAt || null,
        ]
      );

      // 3. Insert dos Itens e Baixa de Estoque
      for (let i = 0; i < sale.items.length; i++) {
        const item = sale.items[i];
        const itemId = `${sale.id}_item_${i + 1}`;
        await tx.execute(
          `INSERT INTO local_sale_items (
            id, sale_id, product_id, product_name, barcode, quantity,
            unit_price, unit_cost, discount, total_price, total_cost, lot_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            itemId,
            sale.id,
            item.productId,
            item.productName,
            item.barcode,
            item.quantity,
            item.unitPrice,
            item.unitCost,
            item.discount || 0,
            item.totalPrice,
            item.totalCost,
            item.lotId || null,
          ]
        );

        // Baixa de estoque e movimentação com validação estrita de tenantId
        const prodRows = await tx.query<{ current_stock: number }>(
          'SELECT current_stock FROM local_products WHERE id = ? AND tenant_id = ?;',
          [item.productId, sale.tenantId]
        );
        const prevStock = prodRows.length > 0 ? Number(prodRows[0].current_stock) : 0;
        const newStock = prevStock - item.quantity;

        await tx.execute(
          'UPDATE local_products SET current_stock = current_stock - ? WHERE id = ? AND tenant_id = ?;',
          [item.quantity, item.productId, sale.tenantId]
        );

        const movementId = `mov_${sale.id}_${item.productId}_${i + 1}`;
        await tx.execute(
          `INSERT INTO local_stock_movements (
            id, tenant_id, product_id, device_id, sale_id, quantity,
            previous_stock, new_stock, type, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SAIDA_VENDA', ?);`,
          [
            movementId,
            sale.tenantId,
            item.productId,
            sale.deviceId,
            sale.id,
            item.quantity,
            prevStock,
            newStock,
            sale.createdAt,
          ]
        );
      }

      // 4. Insert dos Pagamentos
      for (let i = 0; i < sale.payments.length; i++) {
        const payment = sale.payments[i];
        const paymentId = `${sale.id}_pay_${i + 1}`;
        await tx.execute(
          `INSERT INTO local_sale_payments (
            id, sale_id, method, amount, change_amount
          ) VALUES (?, ?, ?, ?, ?);`,
          [
            paymentId,
            sale.id,
            payment.method,
            payment.amount,
            payment.changeAmount || 0,
          ]
        );
      }

      // 5. Enfileira na Outbox de Sincronização
      const operationId = sale.operationId || sale.id;
      const outboxId = `outbox_${sale.id}`;
      const outboxStatus = sale.syncedAt ? 'SYNCED' : 'PENDING';
      await tx.execute(
        `INSERT INTO outbox_operations (
          id, tenant_id, type, operation_id, payload, status, attempts, next_attempt_at, processing_deadline, created_at, updated_at
        ) VALUES (?, ?, 'SALE_CREATED', ?, ?, ?, 0, 0, 0, ?, ?);`,
        [
          outboxId,
          sale.tenantId,
          operationId,
          JSON.stringify(sale),
          outboxStatus,
          sale.createdAt,
          sale.createdAt,
        ]
      );
    });

    // Atualiza cache em memória após sucesso da transação
    await this.loadProductsIntoCache();
  }

  public async getPendingSales(): Promise<Sale[]> {
    await this.ensureReady();
    const rows = await this.driver.query<{ payload: string }>(
      `SELECT payload FROM outbox_operations 
       WHERE status = 'PENDING' AND type = 'SALE_CREATED' 
       ORDER BY created_at ASC;`
    );
    return rows.map((r) => JSON.parse(r.payload) as Sale);
  }

  public async getPendingOutboxCount(): Promise<number> {
    await this.ensureReady();
    // Contabiliza rigorosamente TODAS as operações ainda não confirmadas na nuvem
    const rows = await this.driver.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM outbox_operations WHERE status != 'SYNCED';"
    );
    return rows.length > 0 ? Number(rows[0].count) : 0;
  }

  public async getOutboxStats(): Promise<{
    pending: number;
    processing: number;
    failed: number;
    reviewRequired: number;
    synced: number;
    totalUnconfirmed: number;
    total: number;
  }> {
    await this.ensureReady();
    const rows = await this.driver.query<{ status: string; count: number }>(
      'SELECT status, COUNT(*) as count FROM outbox_operations GROUP BY status;'
    );
    const stats = {
      pending: 0,
      processing: 0,
      failed: 0,
      reviewRequired: 0,
      synced: 0,
      totalUnconfirmed: 0,
      total: 0,
    };
    for (const r of rows) {
      const count = Number(r.count);
      stats.total += count;
      if (r.status === 'PENDING') stats.pending = count;
      else if (r.status === 'PROCESSING') stats.processing = count;
      else if (r.status === 'FAILED') stats.failed = count;
      else if (r.status === 'REVIEW_REQUIRED') stats.reviewRequired = count;
      else if (r.status === 'SYNCED') stats.synced = count;
    }
    stats.totalUnconfirmed = stats.pending + stats.processing + stats.failed + stats.reviewRequired;
    return stats;
  }

  public async getPendingOutboxOperations(limit: number = 50): Promise<OutboxRecord[]> {
    await this.ensureReady();
    const rows = await this.driver.query<Record<string, unknown>>(
      `SELECT * FROM outbox_operations 
       WHERE status IN ('PENDING', 'FAILED') 
       ORDER BY created_at ASC LIMIT ?;`,
      [limit]
    );
    return rows.map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      type: String(r.type),
      operationId: String(r.operation_id),
      payload: String(r.payload),
      status: r.status as OutboxStatus,
      attempts: Number(r.attempts),
      lastError: r.last_error ? String(r.last_error) : undefined,
      nextAttemptAt: Number(r.next_attempt_at || 0),
      processingDeadline: Number(r.processing_deadline || 0),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  /**
   * Recupera operações abandonadas em PROCESSING após expiração do prazo de concessão (processing_deadline).
   * Operações com tentativas esgotadas são enviadas para REVIEW_REQUIRED; as demais voltam para PENDING.
   */
  public async recoverAbandonedProcessing(
    now: number = Date.now(),
    maxAttempts: number = 10
  ): Promise<number> {
    await this.ensureReady();
    return await this.driver.transaction(async (tx) => {
      // 1. Abandonadas com tentativas esgotadas -> REVIEW_REQUIRED
      await tx.execute(
        `UPDATE outbox_operations 
         SET status = 'REVIEW_REQUIRED', processing_deadline = 0, updated_at = ? 
         WHERE status = 'PROCESSING' AND processing_deadline > 0 AND processing_deadline <= ? AND attempts >= ?;`,
        [now, now, maxAttempts]
      );

      // 2. Abandonadas com tentativas restantes -> PENDING
      const countRows = await tx.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM outbox_operations 
         WHERE status = 'PROCESSING' AND processing_deadline > 0 AND processing_deadline <= ?;`,
        [now]
      );
      const recoveredCount = countRows.length > 0 ? Number(countRows[0].count) : 0;

      await tx.execute(
        `UPDATE outbox_operations 
         SET status = 'PENDING', processing_deadline = 0, updated_at = ? 
         WHERE status = 'PROCESSING' AND processing_deadline > 0 AND processing_deadline <= ?;`,
        [now, now]
      );

      return recoveredCount;
    });
  }

  /**
   * Reivindica atomicamente um lote de operações elegíveis para processamento.
   * 1. Recupera operações abandonadas em PROCESSING com prazo vencido.
   * 2. Filtra no SQL apenas operações elegíveis (evitando que tentativas esgotadas ocupem o limite do lote).
   * 3. Atualiza atomicamente os registros para status PROCESSING com prazo limite de execução (processing_deadline).
   */
  public async claimEligibleOutboxBatch(
    limit: number = 20,
    processingLeaseMs: number = 60000,
    forceImmediate: boolean = false,
    maxAttempts: number = 10
  ): Promise<OutboxRecord[]> {
    await this.ensureReady();
    const now = Date.now();
    const deadline = now + processingLeaseMs;

    return await this.driver.transaction(async (tx) => {
      // 1. Recupera operações abandonadas
      await tx.execute(
        `UPDATE outbox_operations 
         SET status = 'REVIEW_REQUIRED', processing_deadline = 0, updated_at = ? 
         WHERE status = 'PROCESSING' AND processing_deadline > 0 AND processing_deadline <= ? AND attempts >= ?;`,
        [now, now, maxAttempts]
      );
      await tx.execute(
        `UPDATE outbox_operations 
         SET status = 'PENDING', processing_deadline = 0, updated_at = ? 
         WHERE status = 'PROCESSING' AND processing_deadline > 0 AND processing_deadline <= ?;`,
        [now, now]
      );

      // 2. Seleciona estritamente registros elegíveis no SQL antes do LIMIT
      let querySql: string;
      let queryParams: any[];

      if (forceImmediate) {
        // Modo forçado (ex: clique manual): antecipa retentativas sem aguardar next_attempt_at,
        // mas respeita o limite de tentativas máximas (maxAttempts)
        querySql = `
          SELECT * FROM outbox_operations 
          WHERE (status = 'PENDING') 
             OR (status = 'FAILED' AND attempts < ?)
          ORDER BY created_at ASC 
          LIMIT ?;
        `;
        queryParams = [maxAttempts, limit];
      } else {
        // Modo normal: respeita o next_attempt_at do backoff exponencial
        querySql = `
          SELECT * FROM outbox_operations 
          WHERE (status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) 
             OR (status = 'FAILED' AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          ORDER BY created_at ASC 
          LIMIT ?;
        `;
        queryParams = [now, maxAttempts, now, limit];
      }

      const rows = await tx.query<Record<string, unknown>>(querySql, queryParams);
      if (rows.length === 0) {
        return [];
      }

      // 3. Reivindica atomicamente o lote
      const claimed: OutboxRecord[] = [];
      for (const r of rows) {
        const id = String(r.id);
        const currentAttempts = Number(r.attempts || 0);
        const newAttempts = currentAttempts + 1;

        await tx.execute(
          `UPDATE outbox_operations 
           SET status = 'PROCESSING', processing_deadline = ?, attempts = ?, updated_at = ? 
           WHERE id = ?;`,
          [deadline, newAttempts, now, id]
        );

        claimed.push({
          id,
          tenantId: String(r.tenant_id),
          type: String(r.type),
          operationId: String(r.operation_id),
          payload: String(r.payload),
          status: 'PROCESSING',
          attempts: newAttempts,
          lastError: r.last_error ? String(r.last_error) : undefined,
          nextAttemptAt: Number(r.next_attempt_at || 0),
          processingDeadline: deadline,
          createdAt: Number(r.created_at),
          updatedAt: now,
        });
      }

      return claimed;
    });
  }

  public async markOutboxProcessing(operationId: string, leaseMs: number = 60000): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    await this.driver.execute(
      `UPDATE outbox_operations 
       SET status = 'PROCESSING', processing_deadline = ?, updated_at = ? 
       WHERE operation_id = ? OR operation_id = ('op_' || ?) OR id = ('outbox_' || ?);`,
      [now + leaseMs, now, operationId, operationId, operationId]
    );
  }

  public async markOutboxSuccess(operationId: string): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    await this.driver.transaction(async (tx) => {
      await tx.execute(
        `UPDATE outbox_operations 
         SET status = 'SYNCED', processing_deadline = 0, updated_at = ? 
         WHERE operation_id = ? OR operation_id = ('op_' || ?) OR id = ('outbox_' || ?);`,
        [now, operationId, operationId, operationId]
      );
      await tx.execute(
        `UPDATE local_sales SET synced_at = ? 
         WHERE id = ? OR ('op_' || id) = ?;`,
        [now, operationId, operationId]
      );
    });
  }

  public async markOutboxFailed(
    operationId: string,
    errorMessage: string,
    baseDelayMs: number = 1500,
    maxDelayMs: number = 30000,
    maxAttempts: number = 10
  ): Promise<{ status: OutboxStatus; nextAttemptAt?: number }> {
    await this.ensureReady();
    const now = Date.now();

    return await this.driver.transaction(async (tx) => {
      const rows = await tx.query<{ attempts: number }>(
        `SELECT attempts FROM outbox_operations 
         WHERE operation_id = ? OR operation_id = ('op_' || ?) OR id = ('outbox_' || ?);`,
        [operationId, operationId, operationId]
      );
      const attempts = rows.length > 0 ? Number(rows[0].attempts) : 1;

      if (attempts >= maxAttempts) {
        // Esgotou tentativas: entra em estado de revisão operacional
        await tx.execute(
          `UPDATE outbox_operations 
           SET status = 'REVIEW_REQUIRED', last_error = ?, processing_deadline = 0, updated_at = ? 
           WHERE operation_id = ? OR operation_id = ('op_' || ?) OR id = ('outbox_' || ?);`,
          [errorMessage, now, operationId, operationId, operationId]
        );
        return { status: 'REVIEW_REQUIRED' };
      }

      // Calcula backoff exponencial com jitter
      const backoff = Math.min(baseDelayMs * Math.pow(2, attempts - 1), maxDelayMs);
      const jitter = Math.floor(Math.random() * 500);
      const nextAttemptAt = now + backoff + jitter;

      await tx.execute(
        `UPDATE outbox_operations 
         SET status = 'FAILED', next_attempt_at = ?, last_error = ?, processing_deadline = 0, updated_at = ? 
         WHERE operation_id = ? OR operation_id = ('op_' || ?) OR id = ('outbox_' || ?);`,
        [nextAttemptAt, errorMessage, now, operationId, operationId, operationId]
      );

      return { status: 'FAILED', nextAttemptAt };
    });
  }

  public async reprocessOutboxOperation(operationId: string): Promise<boolean> {
    await this.ensureReady();
    const now = Date.now();
    await this.driver.execute(
      `UPDATE outbox_operations 
       SET status = 'PENDING', attempts = 0, next_attempt_at = 0, processing_deadline = 0, last_error = NULL, updated_at = ? 
       WHERE operation_id = ? OR operation_id = ('op_' || ?) OR id = ('outbox_' || ?);`,
      [now, operationId, operationId, operationId]
    );
    return true;
  }

  public async reprocessAllReviewRequired(): Promise<number> {
    await this.ensureReady();
    const now = Date.now();
    return await this.driver.transaction(async (tx) => {
      const rows = await tx.query<{ count: number }>(
        "SELECT COUNT(*) as count FROM outbox_operations WHERE status = 'REVIEW_REQUIRED';"
      );
      const count = rows.length > 0 ? Number(rows[0].count) : 0;
      await tx.execute(
        `UPDATE outbox_operations 
         SET status = 'PENDING', attempts = 0, next_attempt_at = 0, processing_deadline = 0, last_error = NULL, updated_at = ? 
         WHERE status = 'REVIEW_REQUIRED';`,
        [now]
      );
      return count;
    });
  }

  public async markSalesAsSynced(syncedSaleIds: string[]): Promise<void> {
    for (const id of syncedSaleIds) {
      await this.markOutboxSuccess(id);
    }
  }

  public async getMeta(): Promise<LocalSyncMeta> {
    await this.ensureReady();
    const metaRows = await this.driver.query<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'lastSyncAt';"
    );
    const lastSyncAt = metaRows.length > 0 ? Number(metaRows[0].value) : 0;
    const pendingSalesCount = await this.getPendingOutboxCount();
    return {
      lastSyncAt,
      totalLocalProducts: this.productsList.length,
      pendingSalesCount,
    };
  }

  public async seedDemoProductsIfEmpty(tenantId: string): Promise<void> {
    await this.ensureReady();
    this.setActiveTenantId(tenantId);
    const countRows = await this.driver.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM local_products WHERE tenant_id = ?;',
      [tenantId]
    );
    if (countRows.length > 0 && Number(countRows[0].count) > 0) {
      await this.loadProductsIntoCache(tenantId);
      return;
    }

    const demoItems: Product[] = [
      {
        id: 'prod_1',
        tenantId,
        name: 'Café Tradicional 500g',
        barcode: '7891000100101',
        costPrice: 12.5,
        sellingPrice: 18.9,
        minStock: 10,
        currentStock: 35,
        unit: 'UN',
        category: 'Mercearia',
        ncm: '09012100',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'prod_2',
        tenantId,
        name: 'Arroz Branco Tipo 1 5kg',
        barcode: '7892000200202',
        costPrice: 22.0,
        sellingPrice: 29.9,
        minStock: 15,
        currentStock: 42,
        unit: 'UN',
        category: 'Mercearia',
        ncm: '10063021',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'prod_3',
        tenantId,
        name: 'Óleo de Soja 900ml',
        barcode: '7893000300303',
        costPrice: 4.8,
        sellingPrice: 7.2,
        minStock: 20,
        currentStock: 8,
        unit: 'UN',
        category: 'Mercearia',
        ncm: '15079011',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'prod_4',
        tenantId,
        name: 'Refrigerante Cola 2L',
        barcode: '7894000400404',
        costPrice: 6.5,
        sellingPrice: 10.5,
        minStock: 12,
        currentStock: 28,
        unit: 'UN',
        category: 'Bebidas',
        ncm: '22021000',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'prod_5',
        tenantId,
        name: 'Sabonete Hidratante 90g',
        barcode: '7895000500505',
        costPrice: 1.8,
        sellingPrice: 3.25,
        minStock: 25,
        currentStock: 64,
        unit: 'UN',
        category: 'Higiene',
        ncm: '34011190',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: 'prod_6',
        tenantId,
        name: 'Detergente Líquido 500ml',
        barcode: '7896000600606',
        costPrice: 1.6,
        sellingPrice: 2.8,
        minStock: 15,
        currentStock: 5,
        unit: 'UN',
        category: 'Limpeza',
        ncm: '34022000',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    await this.upsertDeltaProducts(demoItems, Date.now(), tenantId);
  }

  public async recordCashMovement(movement: CashMovement): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(
      `INSERT INTO local_cash_movements (
        id, tenant_id, session_id, type, amount, reason, user_id, user_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        movement.id,
        movement.tenantId,
        movement.sessionId,
        movement.type,
        movement.amount,
        movement.reason,
        movement.userId,
        movement.userName,
        movement.createdAt,
      ]
    );
  }

  public async openCashSession(session: CashSession): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(
      `INSERT INTO local_cash_sessions (
        id, tenant_id, device_id, terminal_number, opened_by_user_id,
        opened_by_name, opened_at, initial_amount, total_cash_sales,
        total_pix_sales, total_card_sales, total_credit_sales,
        total_sangrias, total_suprimentos, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'OPEN');`,
      [
        session.id,
        session.tenantId,
        session.deviceId,
        session.terminalNumber,
        session.openedByUserId,
        session.openedByName,
        session.openedAt,
        session.initialAmount,
      ]
    );
  }

  public async closeCashSession(
    sessionId: string,
    finalAmount: number,
    calculatedAmount: number,
    difference: number,
    notes?: string
  ): Promise<void> {
    await this.ensureReady();
    await this.driver.execute(
      `UPDATE local_cash_sessions SET
        status = 'CLOSED',
        closed_at = ?,
        final_reported_amount = ?,
        system_calculated_amount = ?,
        difference_amount = ?,
        notes = ?
       WHERE id = ?;`,
      [Date.now(), finalAmount, calculatedAmount, difference, notes || null, sessionId]
    );
  }

  public async close(): Promise<void> {
    await this.driver.close();
  }
}

export const localDb = new LocalDatabase();
