export interface ISqliteDriver {
  execute(sql: string, params?: unknown[]): void | Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  transaction<T>(fn: () => Promise<T> | T): Promise<T> | T;
  close(): Promise<void> | void;
}

/**
 * Driver para ambiente Node.js utilizando node:sqlite (DatabaseSync) disponível nativamente no Node 22+.
 * Execução 100% síncrona com suporte transparente a promises e transações aninhadas via SAVEPOINT.
 */
export class NodeSqliteDriver implements ISqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private transactionDepth: number = 0;

  constructor(filePathOrMemory: string = ':memory:') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sqliteModule = require('node:sqlite');
      this.db = new sqliteModule.DatabaseSync(filePathOrMemory);
      this.db.exec('PRAGMA foreign_keys = ON;');
      if (filePathOrMemory !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL;');
      }
    } catch (err) {
      throw new Error(`[NodeSqliteDriver] Falha ao inicializar banco SQLite nativo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public execute(sql: string, params: unknown[] = []): void {
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  public query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  public transaction<T>(fn: () => Promise<T> | T): Promise<T> | T {
    const depth = this.transactionDepth++;
    const savepointName = `sp_${depth}`;

    if (depth === 0) {
      this.execute('BEGIN IMMEDIATE TRANSACTION;');
    } else {
      this.execute(`SAVEPOINT ${savepointName};`);
    }

    try {
      const result = fn();
      if (result && typeof (result as any).then === 'function') {
        return (result as Promise<T>).then(
          (val) => {
            if (depth === 0) {
              this.execute('COMMIT;');
            } else {
              this.execute(`RELEASE ${savepointName};`);
            }
            this.transactionDepth--;
            return val;
          },
          (err) => {
            if (depth === 0) {
              try { this.execute('ROLLBACK;'); } catch { /* no-op */ }
            } else {
              try { this.execute(`ROLLBACK TO ${savepointName};`); } catch { /* no-op */ }
            }
            this.transactionDepth--;
            throw err;
          }
        ) as Promise<T>;
      }

      if (depth === 0) {
        this.execute('COMMIT;');
      } else {
        this.execute(`RELEASE ${savepointName};`);
      }
      this.transactionDepth--;
      return result;
    } catch (err) {
      if (depth === 0) {
        try { this.execute('ROLLBACK;'); } catch { /* no-op */ }
      } else {
        try { this.execute(`ROLLBACK TO ${savepointName};`); } catch { /* no-op */ }
      }
      this.transactionDepth--;
      throw err;
    }
  }

  public close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

/**
 * Driver para ambiente Tauri utilizando @tauri-apps/plugin-sql quando executado no Desktop.
 */
export class TauriSqliteDriver implements ISqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tauriDb: any;
  private dbPath: string;
  private transactionDepth: number = 0;

  constructor(dbPath: string = 'sqlite:pdv_local.db') {
    this.dbPath = dbPath;
  }

  private async ensureDb() {
    if (!this.tauriDb) {
      // Carregamento resiliente do plugin sem quebrar em tempo de build
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin = (window as any).__TAURI__?.sql ||
        (await (Function('return import("@tauri-apps/plugin-sql")')().catch(() => null)));
      if (!plugin) {
        throw new Error('[TauriSqliteDriver] Plugin @tauri-apps/plugin-sql não encontrado no ambiente runtime.');
      }
      this.tauriDb = await plugin.load(this.dbPath);
    }
    return this.tauriDb;
  }

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    const db = await this.ensureDb();
    await db.execute(sql, params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public query(sql: string, params: unknown[] = []): any {
    return this.ensureDb().then((db) => db.select(sql, params)) as any;
  }

  public async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    const depth = this.transactionDepth++;
    const savepointName = `sp_${depth}`;

    try {
      if (depth === 0) {
        await this.execute('BEGIN IMMEDIATE TRANSACTION;');
      } else {
        await this.execute(`SAVEPOINT ${savepointName};`);
      }

      const result = await fn();

      if (depth === 0) {
        await this.execute('COMMIT;');
      } else {
        await this.execute(`RELEASE ${savepointName};`);
      }

      this.transactionDepth--;
      return result;
    } catch (err) {
      if (depth === 0) {
        try { await this.execute('ROLLBACK;'); } catch { /* no-op */ }
      } else {
        try { await this.execute(`ROLLBACK TO ${savepointName};`); } catch { /* no-op */ }
      }
      this.transactionDepth--;
      throw err;
    }
  }

  public async close(): Promise<void> {
    if (this.tauriDb) {
      await this.tauriDb.close();
      this.tauriDb = null;
    }
  }
}

/**
 * Factory para obter o driver apropriado para o runtime atual (Tauri ou Node/Testes).
 */
export function createSqliteDriver(dbPath?: string): ISqliteDriver {
  if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
    return new TauriSqliteDriver(dbPath || 'sqlite:pdv_local.db');
  }
  return new NodeSqliteDriver(dbPath || ':memory:');
}
