import { Product, Sale, CashSession, CashMovement } from '@pdv/shared';
import { ISqliteDriver, createSqliteDriver } from './sqlite-driver';
import { runMigrations, runMigrationsSync } from './schema';

export interface LocalSyncMeta {
  lastSyncAt: number;
  totalLocalProducts: number;
  pendingSalesCount: number;
}

export interface OutboxRecord {
  id: string;
  tenantId: string;
  type: string;
  operationId: string;
  payload: string;
  status: 'PENDING' | 'PROCESSING' | 'SYNCED' | 'FAILED';
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export class LocalDatabase {
  private driver: ISqliteDriver;
  private initialized: boolean = false;
  // Cache em memória para busca instantânea de produtos (< 1ms)
  private productsByBarcode: Map<string, Product> = new Map();
  private productsById: Map<string, Product> = new Map();
  private productsList: Product[] = [];

  constructor(driver?: ISqliteDriver) {
    this.driver = driver || createSqliteDriver();
    this.ensureInitializedSync();
  }

  private ensureInitializedSync() {
    if (this.initialized) return;
    try {
      runMigrationsSync(this.driver);
      this.loadProductsIntoCache();
      this.initialized = true;
    } catch (err) {
      console.error('[LocalDB] Falha ao inicializar banco local SQLite sincronamente:', err);
      // Fallback para async se o driver for assíncrono (ex: Tauri)
      runMigrations(this.driver).then(() => {
        this.loadProductsIntoCache();
        this.initialized = true;
      }).catch((e) => console.error('[LocalDB] Erro no fallback assíncrono:', e));
    }
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await runMigrations(this.driver);
    await this.loadProductsIntoCache();
    this.initialized = true;
  }

  private loadProductsIntoCache() {
    try {
      const rows = this.driver.query<any>(
        'SELECT * FROM local_products WHERE is_active = 1;'
      );
      if (Array.isArray(rows)) {
        this.populateCacheFromRows(rows);
      }
    } catch (err) {
      console.error('[LocalDB] Erro ao carregar produtos para cache:', err);
    }
  }

  private populateCacheFromRows(rows: any[]) {
    this.productsByBarcode.clear();
    this.productsById.clear();
    this.productsList = rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      barcode: r.barcode,
      costPrice: Number(r.cost_price),
      sellingPrice: Number(r.selling_price),
      minStock: Number(r.min_stock),
      currentStock: Number(r.current_stock),
      unit: r.unit || 'UN',
      category: r.category || 'Geral',
      isActive: Boolean(r.is_active),
      createdAt: Number(r.updated_at),
      updatedAt: Number(r.updated_at),
    }));

    for (const p of this.productsList) {
      this.productsById.set(p.id, p);
      if (p.barcode) {
        this.productsByBarcode.set(p.barcode.trim(), p);
      }
    }
  }

  public findByBarcode(barcode: string): Product | undefined {
    return this.productsByBarcode.get(barcode.trim());
  }

  public findById(id: string): Product | undefined {
    return this.productsById.get(id);
  }

  public search(query: string, limit: number = 20): Product[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];

    const results: Product[] = [];
    for (const p of this.productsList) {
      if (p.name.toLowerCase().includes(q) || p.barcode.includes(q)) {
        results.push(p);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * Atualiza produtos no SQLite e no cache em memória.
   */
  public upsertDeltaProducts(incomingProducts: Product[], syncTimestamp: number) {
    this.driver.transaction(() => {
      for (const p of incomingProducts) {
        this.driver.execute(
          `INSERT INTO local_products (
            id, tenant_id, name, barcode, cost_price, selling_price,
            min_stock, current_stock, unit, category, is_active, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            barcode = excluded.barcode,
            cost_price = excluded.cost_price,
            selling_price = excluded.selling_price,
            min_stock = excluded.min_stock,
            current_stock = excluded.current_stock,
            unit = excluded.unit,
            category = excluded.category,
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
            p.isActive ? 1 : 0,
            syncTimestamp,
          ]
        );
      }

      this.driver.execute(
        `INSERT INTO sync_metadata (key, value, updated_at) VALUES ('lastSyncAt', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
        [String(syncTimestamp), syncTimestamp]
      );
    });

    this.loadProductsIntoCache();
  }

  /**
   * Gravação de Venda Atômica com Idempotência e Propagação de Erro.
   *
   * Transação única engloba:
   * 1. Verificação de idempotência (sale.id).
   * 2. Insert em local_sales.
   * 3. Insert em local_sale_items.
   * 4. Insert em local_sale_payments.
   * 5. Baixa de estoque em local_products e log em local_stock_movements.
   * 6. Insert em outbox_operations.
   *
   * Se qualquer etapa falhar, ocorre ROLLBACK e a exceção é propagada ao chamador.
   */
  public recordLocalSale(sale: Sale): void {
    this.driver.transaction(() => {
      // 1. Guarda de Idempotência: se a venda já foi gravada, não duplica estoque nem outbox!
      const existing = this.driver.query<{ id: string }>(
        'SELECT id FROM local_sales WHERE id = ?;',
        [sale.id]
      );
      if (Array.isArray(existing) && existing.length > 0) {
        console.warn(`[LocalDB] Venda "${sale.id}" já gravada anteriormente. Ignorando re-gravação idempotente.`);
        return;
      }

      // 2. Insert da Venda
      this.driver.execute(
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

      // 3. Insert dos Itens
      for (let i = 0; i < sale.items.length; i++) {
        const item = sale.items[i];
        const itemId = `${sale.id}_item_${i + 1}`;
        this.driver.execute(
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

        // 4. Baixa de estoque e movimentação
        const prodRows = this.driver.query<{ current_stock: number }>(
          'SELECT current_stock FROM local_products WHERE id = ?;',
          [item.productId]
        );
        const prevStock = prodRows.length > 0 ? Number(prodRows[0].current_stock) : 0;
        const newStock = prevStock - item.quantity;

        this.driver.execute(
          'UPDATE local_products SET current_stock = current_stock - ? WHERE id = ?;',
          [item.quantity, item.productId]
        );

        const movementId = `mov_${sale.id}_${item.productId}_${i + 1}`;
        this.driver.execute(
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

      // 5. Insert dos Pagamentos
      for (let i = 0; i < sale.payments.length; i++) {
        const payment = sale.payments[i];
        const paymentId = `${sale.id}_pay_${i + 1}`;
        this.driver.execute(
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

      // 6. Enfileira na Outbox de Sincronização
      const outboxId = `outbox_${sale.id}`;
      const outboxStatus = sale.syncedAt ? 'SYNCED' : 'PENDING';
      this.driver.execute(
        `INSERT INTO outbox_operations (
          id, tenant_id, type, operation_id, payload, status, attempts, created_at, updated_at
        ) VALUES (?, ?, 'SALE_CREATED', ?, ?, ?, 0, ?, ?);`,
        [
          outboxId,
          sale.tenantId,
          sale.id,
          JSON.stringify(sale),
          outboxStatus,
          sale.createdAt,
          sale.createdAt,
        ]
      );
    });

    // Atualiza cache em memória após sucesso da transação
    this.loadProductsIntoCache();
  }

  public getPendingSales(): Sale[] {
    const rows = this.driver.query<{ payload: string }>(
      `SELECT payload FROM outbox_operations 
       WHERE status = 'PENDING' AND type = 'SALE_CREATED' 
       ORDER BY created_at ASC;`
    );
    return rows.map((r) => JSON.parse(r.payload) as Sale);
  }

  public getPendingOutboxCount(): number {
    const rows = this.driver.query<{ count: number }>(
      "SELECT COUNT(*) as count FROM outbox_operations WHERE status IN ('PENDING', 'FAILED');"
    );
    return rows.length > 0 ? Number(rows[0].count) : 0;
  }

  public getPendingOutboxOperations(limit: number = 50): OutboxRecord[] {
    const rows = this.driver.query<any>(
      `SELECT * FROM outbox_operations 
       WHERE status IN ('PENDING', 'FAILED') 
       ORDER BY created_at ASC LIMIT ?;`,
      [limit]
    );
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      type: r.type,
      operationId: r.operation_id,
      payload: r.payload,
      status: r.status,
      attempts: Number(r.attempts),
      lastError: r.last_error || undefined,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  public markOutboxProcessing(operationId: string) {
    this.driver.execute(
      "UPDATE outbox_operations SET status = 'PROCESSING', updated_at = ? WHERE operation_id = ?;",
      [Date.now(), operationId]
    );
  }

  public markOutboxSuccess(operationId: string) {
    const now = Date.now();
    this.driver.transaction(() => {
      this.driver.execute(
        "UPDATE outbox_operations SET status = 'SYNCED', updated_at = ? WHERE operation_id = ?;",
        [now, operationId]
      );
      this.driver.execute(
        'UPDATE local_sales SET synced_at = ? WHERE id = ?;',
        [now, operationId]
      );
    });
  }

  public markOutboxFailed(operationId: string, errorMessage: string) {
    this.driver.execute(
      `UPDATE outbox_operations 
       SET status = 'FAILED', attempts = attempts + 1, last_error = ?, updated_at = ? 
       WHERE operation_id = ?;`,
      [errorMessage, Date.now(), operationId]
    );
  }

  public markSalesAsSynced(syncedSaleIds: string[]) {
    for (const id of syncedSaleIds) {
      this.markOutboxSuccess(id);
    }
  }

  public getMeta(): LocalSyncMeta {
    const metaRows = this.driver.query<{ value: string }>(
      "SELECT value FROM sync_metadata WHERE key = 'lastSyncAt';"
    );
    const lastSyncAt = metaRows.length > 0 ? Number(metaRows[0].value) : 0;
    return {
      lastSyncAt,
      totalLocalProducts: this.productsList.length,
      pendingSalesCount: this.getPendingOutboxCount(),
    };
  }

  public seedDemoProductsIfEmpty(tenantId: string) {
    const countRows = this.driver.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM local_products;'
    );
    if (countRows.length > 0 && Number(countRows[0].count) > 0) {
      this.loadProductsIntoCache();
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
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    this.upsertDeltaProducts(demoItems, Date.now());
  }

  public recordCashMovement(movement: CashMovement) {
    this.driver.execute(
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

  public openCashSession(session: CashSession) {
    this.driver.execute(
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

  public closeCashSession(
    sessionId: string,
    finalAmount: number,
    calculatedAmount: number,
    difference: number,
    notes?: string
  ) {
    this.driver.execute(
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
}

export const localDb = new LocalDatabase();
