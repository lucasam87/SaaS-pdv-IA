/**
 * Contrato uniforme e 100% assíncrono para operações com SQLite no PDV.
 * Suporta isolamento estrito, serialização de transações concorrentes e
 * transações aninhadas legítimas via SAVEPOINT.
 */
export interface ISqliteDriver {
  execute(sql: string, params?: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Mutex assíncrono para garantir acesso exclusivo e serializado
 * à conexão do SQLite durante transações independentes concorrentes.
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  public async acquire(): Promise<() => void> {
    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousQueue = this.queue;
    this.queue = this.queue.then(() => lockAcquired);

    await previousQueue;
    return releaseLock;
  }
}

/**
 * Driver contextual para execução de transações e transações aninhadas (SAVEPOINT).
 * Garante que chamadas legítimas aninhadas não travem o mutex e usem SAVEPOINTs isolados.
 */
class TransactionContextDriver implements ISqliteDriver {
  private savepointCounter = 0;

  constructor(
    private parentExecute: (sql: string, params?: unknown[]) => Promise<void>,
    private parentQuery: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
    public readonly depth: number = 1
  ) {}

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.parentExecute(sql, params);
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return await this.parentQuery<T>(sql, params);
  }

  public async transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T> {
    const spName = `sp_${this.depth}_${++this.savepointCounter}`;
    await this.execute(`SAVEPOINT ${spName};`);

    const nestedContext = new TransactionContextDriver(
      this.parentExecute,
      this.parentQuery,
      this.depth + 1
    );

    let result: T;
    try {
      result = await fn(nestedContext);
    } catch (fnErr) {
      let rollbackErr: unknown = null;
      try {
        await this.execute(`ROLLBACK TO ${spName};`);
      } catch (rbErr) {
        rollbackErr = rbErr;
      }

      if (rollbackErr) {
        const fnMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const compositeErr = new Error(`[SqliteDriver] Transação aninhada falhou: ${fnMsg} | Rollback to savepoint também falhou: ${rbMsg}`);
        (compositeErr as any).cause = fnErr;
        (compositeErr as any).rollbackError = rollbackErr;
        throw compositeErr;
      }
      throw fnErr;
    }

    try {
      await this.execute(`RELEASE ${spName};`);
    } catch (releaseErr) {
      let rollbackErr: unknown = null;
      try {
        await this.execute(`ROLLBACK TO ${spName};`);
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      const relMsg = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      if (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`[SqliteDriver] Falha no RELEASE do savepoint: ${relMsg} | Rollback to savepoint falhou: ${rbMsg}`);
      }
      throw new Error(`[SqliteDriver] Falha no RELEASE do savepoint: ${relMsg}`);
    }

    return result;
  }

  public async close(): Promise<void> {
    throw new Error('[SqliteDriver] Não é permitido fechar a conexão no meio de uma transação ativa.');
  }
}

/**
 * Driver para ambiente Node.js utilizando node:sqlite (DatabaseSync) disponível nativamente no Node 22+.
 * Fornece contrato assíncrono rigoroso, serialização com mutex para concorrência
 * e suporte completo a transações aninhadas via SAVEPOINT.
 */
export class NodeSqliteDriver implements ISqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  private mutex = new AsyncMutex();
  private isClosed = false;

  constructor(filePathOrMemory: string = ':memory:') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const req = typeof require !== 'undefined' ? require : undefined;
      if (!req) {
        throw new Error('Ambiente de execução não suporta require("node:sqlite"). Utilize BrowserSqliteDriver para o navegador.');
      }
      const sqliteModule = req('node:sqlite');
      this.db = new sqliteModule.DatabaseSync(filePathOrMemory);
      this.db.exec('PRAGMA foreign_keys = ON;');
      if (filePathOrMemory !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL;');
      }
    } catch (err) {
      throw new Error(`[NodeSqliteDriver] Falha ao inicializar banco SQLite nativo: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    if (this.isClosed) throw new Error('[NodeSqliteDriver] Conexão com banco está fechada.');
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (this.isClosed) throw new Error('[NodeSqliteDriver] Conexão com banco está fechada.');
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  public async transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T> {
    if (this.isClosed) throw new Error('[NodeSqliteDriver] Conexão com banco está fechada.');

    const releaseLock = await this.mutex.acquire();

    try {
      await this.execute('BEGIN IMMEDIATE TRANSACTION;');
    } catch (beginErr) {
      releaseLock();
      const msg = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new Error(`[NodeSqliteDriver] Falha ao iniciar transação imediata: ${msg}`);
    }

    const txContext = new TransactionContextDriver(
      this.execute.bind(this),
      this.query.bind(this),
      1
    );

    let result: T;
    try {
      result = await fn(txContext);
    } catch (fnErr) {
      let rollbackErr: unknown = null;
      try {
        await this.execute('ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      if (rollbackErr) {
        const fnMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const compositeErr = new Error(`[NodeSqliteDriver] Transação falhou: ${fnMsg} | Rollback também falhou: ${rbMsg}`);
        (compositeErr as any).cause = fnErr;
        (compositeErr as any).rollbackError = rollbackErr;
        throw compositeErr;
      }
      throw fnErr;
    }

    try {
      await this.execute('COMMIT;');
    } catch (commitErr) {
      let rollbackErr: unknown = null;
      try {
        await this.execute('ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      if (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`[NodeSqliteDriver] Falha no COMMIT: ${commitMsg} | Rollback subsequente também falhou: ${rbMsg}`);
      }
      throw new Error(`[NodeSqliteDriver] Falha no COMMIT da transação: ${commitMsg}`);
    }

    releaseLock();
    return result;
  }

  public async close(): Promise<void> {
    if (this.db && !this.isClosed) {
      this.isClosed = true;
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Driver para ambiente Tauri utilizando @tauri-apps/plugin-sql quando executado no Desktop.
 * Uniformiza contrato 100% assíncrono, elimina casts para any em retorno de promises,
 * garante exclusividade via Mutex e suporta transações aninhadas via SAVEPOINT.
 */
export class TauriSqliteDriver implements ISqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tauriDb: any = null;
  private dbPath: string;
  private mutex = new AsyncMutex();
  private isClosed = false;

  constructor(dbPath: string = 'sqlite:pdv_local.db') {
    this.dbPath = dbPath;
  }

  private async ensureDb() {
    if (this.isClosed) {
      throw new Error('[TauriSqliteDriver] Conexão com banco está fechada.');
    }
    if (!this.tauriDb) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin = (typeof window !== 'undefined' && (window as any).__TAURI__?.sql) ||
        (await (Function('return import("@tauri-apps/plugin-sql")')().catch(() => null)));
      if (!plugin) {
        throw new Error('[TauriSqliteDriver] Plugin @tauri-apps/plugin-sql não encontrado no ambiente runtime.');
      }
      this.tauriDb = await plugin.load(this.dbPath);
      await this.tauriDb.execute('PRAGMA foreign_keys = ON;');
      if (!this.dbPath.includes(':memory:')) {
        await this.tauriDb.execute('PRAGMA journal_mode = WAL;');
      }
    }
    return this.tauriDb;
  }

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    const db = await this.ensureDb();
    await db.execute(sql, params);
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = await this.ensureDb();
    const rows = await db.select(sql, params);
    return (rows || []) as T[];
  }

  public async transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();

    try {
      await db.execute('BEGIN IMMEDIATE TRANSACTION;', []);
    } catch (beginErr) {
      releaseLock();
      const msg = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new Error(`[TauriSqliteDriver] Falha ao iniciar transação imediata: ${msg}`);
    }

    const txContext = new TransactionContextDriver(
      async (sql, params = []) => { await db.execute(sql, params); },
      async <K = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const rows = await db.select(sql, params);
        return (rows || []) as K[];
      },
      1
    );

    let result: T;
    try {
      result = await fn(txContext);
    } catch (fnErr) {
      let rollbackErr: unknown = null;
      try {
        await db.execute('ROLLBACK;', []);
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      if (rollbackErr) {
        const fnMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const compositeErr = new Error(`[TauriSqliteDriver] Transação falhou: ${fnMsg} | Rollback também falhou: ${rbMsg}`);
        (compositeErr as any).cause = fnErr;
        (compositeErr as any).rollbackError = rollbackErr;
        throw compositeErr;
      }
      throw fnErr;
    }

    try {
      await db.execute('COMMIT;', []);
    } catch (commitErr) {
      let rollbackErr: unknown = null;
      try {
        await db.execute('ROLLBACK;', []);
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      if (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`[TauriSqliteDriver] Falha no COMMIT: ${commitMsg} | Rollback subsequente também falhou: ${rbMsg}`);
      }
      throw new Error(`[TauriSqliteDriver] Falha no COMMIT da transação: ${commitMsg}`);
    }

    releaseLock();
    return result;
  }

  public async close(): Promise<void> {
    if (this.tauriDb && !this.isClosed) {
      this.isClosed = true;
      await this.tauriDb.close();
      this.tauriDb = null;
    }
  }
}

/**
 * Driver para ambiente Web/Navegador utilizando WebAssembly (sql.js / SQLite compilado para WASM).
 * Permite execução 100% offline e local da interface do PDV no navegador durante desenvolvimento,
 * sem requerer Node.js nativo nem o container desktop do Tauri.
 */
export class BrowserSqliteDriver implements ISqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  private mutex = new AsyncMutex();
  private isClosed = false;

  private async ensureDb() {
    if (this.isClosed) {
      throw new Error('[BrowserSqliteDriver] Conexão com banco está fechada.');
    }
    if (!this.db) {
      console.log('[BrowserSqliteDriver] ensureDb starting...');
      if (typeof window !== 'undefined' && !(window as any).initSqlJs) {
        console.log('[BrowserSqliteDriver] Loading /sql-wasm.js script...');
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script');
          script.src = '/sql-wasm.js';
          script.onload = () => resolve();
          script.onerror = () => reject(new Error('Falha ao carregar motor SQLite WebAssembly (/sql-wasm.js).'));
          document.head.appendChild(script);
        });
      }

      const initFn = typeof window !== 'undefined' ? (window as any).initSqlJs : null;
      if (!initFn) {
        throw new Error('[BrowserSqliteDriver] initSqlJs não está disponível no escopo.');
      }

      console.log('[BrowserSqliteDriver] Fetching /sql-wasm.wasm binary...');
      const wasmRes = await fetch('/sql-wasm.wasm');
      const wasmBinary = await wasmRes.arrayBuffer();
      console.log('[BrowserSqliteDriver] WASM binary fetched (' + wasmBinary.byteLength + ' bytes), instantiating SQLite...');

      const SQL = await initFn({
        wasmBinary,
      });
      console.log('[BrowserSqliteDriver] SQLite WASM module initialized, creating database...');
      this.db = new SQL.Database();
      this.db.run('PRAGMA foreign_keys = ON;');
      console.log('[BrowserSqliteDriver] Database successfully created and ready.');
    }
    return this.db;
  }

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    const db = await this.ensureDb();
    if (!params || params.length === 0) {
      db.run(sql);
    } else {
      db.run(sql, params as any[]);
    }
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = await this.ensureDb();
    const stmt = db.prepare(sql);
    if (params && params.length > 0) {
      stmt.bind(params);
    }
    const results: T[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as T);
    }
    stmt.free();
    return results;
  }

  public async transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();

    try {
      db.run('BEGIN IMMEDIATE TRANSACTION;');
    } catch (beginErr) {
      releaseLock();
      const msg = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new Error(`[BrowserSqliteDriver] Falha ao iniciar transação: ${msg}`);
    }

    const txContext = new TransactionContextDriver(
      async (sql, params = []) => {
        if (!params || params.length === 0) {
          db.run(sql);
        } else {
          db.run(sql, params as any[]);
        }
      },
      async <K = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const stmt = db.prepare(sql);
        if (params && params.length > 0) {
          stmt.bind(params);
        }
        const results: K[] = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject() as K);
        }
        stmt.free();
        return results;
      },
      1
    );

    let result: T;
    try {
      result = await fn(txContext);
    } catch (fnErr) {
      let rollbackErr: unknown = null;
      try {
        db.run('ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      if (rollbackErr) {
        const fnMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const compositeErr = new Error(`[BrowserSqliteDriver] Transação falhou: ${fnMsg} | Rollback falhou: ${rbMsg}`);
        (compositeErr as any).cause = fnErr;
        (compositeErr as any).rollbackError = rollbackErr;
        throw compositeErr;
      }
      throw fnErr;
    }

    try {
      db.run('COMMIT;');
    } catch (commitErr) {
      let rollbackErr: unknown = null;
      try {
        db.run('ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      if (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(`[BrowserSqliteDriver] Falha no COMMIT: ${commitMsg} | Rollback falhou: ${rbMsg}`);
      }
      throw new Error(`[BrowserSqliteDriver] Falha no COMMIT: ${commitMsg}`);
    }

    releaseLock();
    return result;
  }

  public async close(): Promise<void> {
    if (this.db && !this.isClosed) {
      this.isClosed = true;
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Factory para obter o driver apropriado para o runtime atual (Tauri, Navegador ou Node/Testes).
 */
export function createSqliteDriver(dbPath?: string): ISqliteDriver {
  if (typeof window !== 'undefined') {
    if ((window as any).__TAURI_INTERNALS__) {
      return new TauriSqliteDriver(dbPath || 'sqlite:pdv_local.db');
    }
    return new BrowserSqliteDriver();
  }
  return new NodeSqliteDriver(dbPath || ':memory:');
}
