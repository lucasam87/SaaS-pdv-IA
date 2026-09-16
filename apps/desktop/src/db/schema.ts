import { ISqliteDriver } from './sqlite-driver';

export interface Migration {
  version: number;
  description: string;
  sql: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: migrations, products, sales, stock, sessions, outbox',
    sql: [
      `CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS local_products (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        barcode TEXT NOT NULL,
        cost_price REAL NOT NULL,
        selling_price REAL NOT NULL,
        min_stock REAL NOT NULL DEFAULT 0,
        current_stock REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT 'UN',
        category TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_products_barcode ON local_products(barcode);`,
      `CREATE INDEX IF NOT EXISTS idx_products_name ON local_products(name);`,

      `CREATE TABLE IF NOT EXISTS local_sales (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        sale_number INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        customer_name TEXT,
        subtotal REAL NOT NULL,
        discount REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL,
        total_cost REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'COMPLETED',
        created_at INTEGER NOT NULL,
        synced_at INTEGER
      );`,

      `CREATE TABLE IF NOT EXISTS local_sale_items (
        id TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        barcode TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit_price REAL NOT NULL,
        unit_cost REAL NOT NULL,
        discount REAL NOT NULL DEFAULT 0,
        total_price REAL NOT NULL,
        total_cost REAL NOT NULL,
        lot_id TEXT,
        FOREIGN KEY(sale_id) REFERENCES local_sales(id) ON DELETE CASCADE
      );`,
      `CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON local_sale_items(sale_id);`,

      `CREATE TABLE IF NOT EXISTS local_sale_payments (
        id TEXT PRIMARY KEY,
        sale_id TEXT NOT NULL,
        method TEXT NOT NULL,
        amount REAL NOT NULL,
        change_amount REAL NOT NULL DEFAULT 0,
        FOREIGN KEY(sale_id) REFERENCES local_sales(id) ON DELETE CASCADE
      );`,
      `CREATE INDEX IF NOT EXISTS idx_sale_payments_sale_id ON local_sale_payments(sale_id);`,

      `CREATE TABLE IF NOT EXISTS local_stock_movements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        sale_id TEXT,
        quantity REAL NOT NULL,
        previous_stock REAL NOT NULL,
        new_stock REAL NOT NULL,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON local_stock_movements(product_id);`,

      `CREATE TABLE IF NOT EXISTS local_cash_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        terminal_number INTEGER NOT NULL,
        opened_by_user_id TEXT NOT NULL,
        opened_by_name TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        initial_amount REAL NOT NULL,
        final_reported_amount REAL,
        system_calculated_amount REAL,
        difference_amount REAL,
        total_cash_sales REAL NOT NULL DEFAULT 0,
        total_pix_sales REAL NOT NULL DEFAULT 0,
        total_card_sales REAL NOT NULL DEFAULT 0,
        total_credit_sales REAL NOT NULL DEFAULT 0,
        total_sangrias REAL NOT NULL DEFAULT 0,
        total_suprimentos REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'OPEN',
        notes TEXT
      );`,

      `CREATE TABLE IF NOT EXISTS local_cash_movements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        reason TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES local_cash_sessions(id) ON DELETE CASCADE
      );`,

      `CREATE TABLE IF NOT EXISTS outbox_operations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        type TEXT NOT NULL,
        operation_id TEXT UNIQUE NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox_operations(status, created_at);`,

      `CREATE TABLE IF NOT EXISTS sync_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
    ],
  },
  {
    version: 2,
    description: 'Add next_attempt_at, processing_deadline to outbox_operations and queue index',
    sql: [
      `ALTER TABLE outbox_operations ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE outbox_operations ADD COLUMN processing_deadline INTEGER NOT NULL DEFAULT 0;`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_queue ON outbox_operations(status, next_attempt_at, created_at);`,
    ],
  },
];

export async function runMigrations(driver: ISqliteDriver): Promise<void> {
  await driver.execute(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  );`);

  const appliedRows = await driver.query<{ version: number }>(
    'SELECT version FROM _migrations ORDER BY version ASC;'
  );
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      await driver.transaction(async (tx) => {
        for (const statement of migration.sql) {
          await tx.execute(statement);
        }
        await tx.execute(
          'INSERT INTO _migrations (version, description, applied_at) VALUES (?, ?, ?);',
          [migration.version, migration.description, Date.now()]
        );
      });
    }
  }
}

