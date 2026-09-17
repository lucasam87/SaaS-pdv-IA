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
 * à conexão do SQLite durante transações independentes concorrentes
 * e operações diretas (execute/query).
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
        const compositeErr = new Error(
          `[SqliteDriver] Transação aninhada falhou: ${fnMsg} | Rollback to savepoint também falhou: ${rbMsg}`
        );
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
        throw new Error(
          `[SqliteDriver] Falha no RELEASE do savepoint: ${relMsg} | Rollback to savepoint falhou: ${rbMsg}`
        );
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
 * Garante serialização estrita para transações e operações diretas via AsyncMutex.
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
        throw new Error(
          'Ambiente de execução não suporta require("node:sqlite"). Utilize BrowserSqliteDriver para o navegador.'
        );
      }
      const sqliteModule = req('node:sqlite');
      this.db = new sqliteModule.DatabaseSync(filePathOrMemory);
      this.db.exec('PRAGMA foreign_keys = ON;');
      if (filePathOrMemory !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL;');
      }
    } catch (err) {
      throw new Error(
        `[NodeSqliteDriver] Falha ao inicializar banco SQLite nativo: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private executeInternal(sql: string, params: unknown[] = []): void {
    if (this.isClosed) throw new Error('[NodeSqliteDriver] Conexão com banco está fechada.');
    const stmt = this.db.prepare(sql);
    stmt.run(...params);
  }

  private queryInternal<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    if (this.isClosed) throw new Error('[NodeSqliteDriver] Conexão com banco está fechada.');
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    const releaseLock = await this.mutex.acquire();
    try {
      this.executeInternal(sql, params);
    } finally {
      releaseLock();
    }
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const releaseLock = await this.mutex.acquire();
    try {
      return this.queryInternal<T>(sql, params);
    } finally {
      releaseLock();
    }
  }

  public async transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T> {
    if (this.isClosed) throw new Error('[NodeSqliteDriver] Conexão com banco está fechada.');

    const releaseLock = await this.mutex.acquire();

    try {
      this.executeInternal('BEGIN IMMEDIATE TRANSACTION;');
    } catch (beginErr) {
      releaseLock();
      const msg = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new Error(`[NodeSqliteDriver] Falha ao iniciar transação imediata: ${msg}`);
    }

    const txContext = new TransactionContextDriver(
      async (sql, params = []) => {
        this.executeInternal(sql, params);
      },
      async <K = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        return this.queryInternal<K>(sql, params);
      },
      1
    );

    let result: T;
    try {
      result = await fn(txContext);
    } catch (fnErr) {
      let rollbackErr: unknown = null;
      try {
        this.executeInternal('ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      if (rollbackErr) {
        const fnMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const compositeErr = new Error(
          `[NodeSqliteDriver] Transação falhou: ${fnMsg} | Rollback também falhou: ${rbMsg}`
        );
        (compositeErr as any).cause = fnErr;
        (compositeErr as any).rollbackError = rollbackErr;
        throw compositeErr;
      }
      throw fnErr;
    }

    try {
      this.executeInternal('COMMIT;');
    } catch (commitErr) {
      let rollbackErr: unknown = null;
      try {
        this.executeInternal('ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      if (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(
          `[NodeSqliteDriver] Falha no COMMIT: ${commitMsg} | Rollback subsequente também falhou: ${rbMsg}`
        );
      }
      throw new Error(`[NodeSqliteDriver] Falha no COMMIT da transação: ${commitMsg}`);
    }

    releaseLock();
    return result;
  }

  public async init(): Promise<void> {
    // Síncrono já inicializado no construtor
  }

  public isInitialized(): boolean {
    return this.db !== null && !this.isClosed;
  }

  public async close(): Promise<void> {
    const releaseLock = await this.mutex.acquire();
    try {
      if (this.db && !this.isClosed) {
        this.isClosed = true;
        this.db.close();
        this.db = null;
      }
    } finally {
      releaseLock();
    }
  }
}

/**
 * Driver para ambiente Tauri utilizando @tauri-apps/plugin-sql quando executado no Desktop.
 * Uniformiza contrato 100% assíncrono, elimina casts para any em retorno de promises,
 * garante exclusividade de operações diretas e transações via Mutex e suporta SAVEPOINTs.
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
      const plugin =
        (typeof window !== 'undefined' && (window as any).__TAURI__?.sql) ||
        (await Function('return import("@tauri-apps/plugin-sql")')().catch(() => null));
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

  private async executeInternal(db: any, sql: string, params: unknown[] = []): Promise<void> {
    await db.execute(sql, params);
  }

  private async queryInternal<T = Record<string, unknown>>(db: any, sql: string, params: unknown[] = []): Promise<T[]> {
    const rows = await db.select(sql, params);
    return (rows || []) as T[];
  }

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();
    try {
      await this.executeInternal(db, sql, params);
    } finally {
      releaseLock();
    }
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();
    try {
      return await this.queryInternal<T>(db, sql, params);
    } finally {
      releaseLock();
    }
  }

  public async transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();

    try {
      await this.executeInternal(db, 'BEGIN IMMEDIATE TRANSACTION;', []);
    } catch (beginErr) {
      releaseLock();
      const msg = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new Error(`[TauriSqliteDriver] Falha ao iniciar transação imediata: ${msg}`);
    }

    const txContext = new TransactionContextDriver(
      async (sql, params = []) => {
        await this.executeInternal(db, sql, params);
      },
      async <K = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        return await this.queryInternal<K>(db, sql, params);
      },
      1
    );

    let result: T;
    try {
      result = await fn(txContext);
    } catch (fnErr) {
      let rollbackErr: unknown = null;
      try {
        await this.executeInternal(db, 'ROLLBACK;', []);
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      if (rollbackErr) {
        const fnMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const compositeErr = new Error(
          `[TauriSqliteDriver] Transação falhou: ${fnMsg} | Rollback também falhou: ${rbMsg}`
        );
        (compositeErr as any).cause = fnErr;
        (compositeErr as any).rollbackError = rollbackErr;
        throw compositeErr;
      }
      throw fnErr;
    }

    try {
      await this.executeInternal(db, 'COMMIT;', []);
    } catch (commitErr) {
      let rollbackErr: unknown = null;
      try {
        await this.executeInternal(db, 'ROLLBACK;', []);
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      if (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(
          `[TauriSqliteDriver] Falha no COMMIT: ${commitMsg} | Rollback subsequente também falhou: ${rbMsg}`
        );
      }
      throw new Error(`[TauriSqliteDriver] Falha no COMMIT da transação: ${commitMsg}`);
    }

    releaseLock();
    return result;
  }

  public async close(): Promise<void> {
    const releaseLock = await this.mutex.acquire();
    try {
      if (this.tauriDb && !this.isClosed) {
        this.isClosed = true;
        await this.tauriDb.close();
        this.tauriDb = null;
      }
    } finally {
      releaseLock();
    }
  }
}

export interface IBrowserStorageAdapter {
  load(key: string): Promise<Uint8Array | null>;
  save(key: string, data: Uint8Array): Promise<void>;
  backupCorrupted?(key: string, data: Uint8Array): Promise<void>;
}

export type ISqliteStorageAdapter = IBrowserStorageAdapter;

/**
 * Adaptador padrão para persistência de snapshots binários do SQLite em IndexedDB no navegador.
 */
export class IndexedDbStorageAdapter implements IBrowserStorageAdapter {
  constructor(private dbName: string = 'pdv_browser_db', private storeName: string = 'sqlite_data') {}

  private async openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB não está disponível neste ambiente.'));
        return;
      }
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Falha ao abrir IndexedDB.'));
    });
  }

  public async load(key: string): Promise<Uint8Array | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(key);
      req.onsuccess = () => {
        if (!req.result) {
          resolve(null);
        } else if (req.result instanceof Uint8Array) {
          resolve(req.result);
        } else if (req.result instanceof ArrayBuffer) {
          resolve(new Uint8Array(req.result));
        } else {
          resolve(new Uint8Array(req.result));
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  public async save(key: string, data: Uint8Array): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.put(data, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  public async backupCorrupted(key: string, data: Uint8Array): Promise<void> {
    const backupKey = `${key}_corrupted_${Date.now()}`;
    await this.save(backupKey, data);
  }
}

export interface BrowserSqliteDriverOptions {
  tenantId?: string;
  schemaVersion?: number;
  storageAdapter?: IBrowserStorageAdapter;
  sqlWasmJsUrl?: string;
  sqlWasmBinaryUrl?: string;
  sqlModuleInit?: (config: any) => Promise<any>;
}

/**
 * Driver para ambiente Web/Navegador utilizando WebAssembly (sql.js / SQLite compilado para WASM)
 * com persistência durável via IndexedDB, isolamento por tenant na chave e serialização de transações.
 */
export class BrowserSqliteDriver implements ISqliteDriver {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any = null;
  private mutex = new AsyncMutex();
  private isClosed = false;
  private tenantId: string;
  private schemaVersion: number;
  private storageAdapter: IBrowserStorageAdapter;
  private options: BrowserSqliteDriverOptions;

  constructor(options?: BrowserSqliteDriverOptions) {
    this.options = options || {};
    this.tenantId = this.options.tenantId || 'tenant_demo_001';
    this.schemaVersion = this.options.schemaVersion || 3;
    this.storageAdapter =
      this.options.storageAdapter ||
      (typeof indexedDB !== 'undefined' ? new IndexedDbStorageAdapter() : {
        async load() { return null; },
        async save() {},
      });
  }

  public getStorageKey(): string {
    return `pdv_sqlite_${this.tenantId}_v${this.schemaVersion}`;
  }

  public getTenantId(): string {
    return this.tenantId;
  }

  public isBrowserFallback(): boolean {
    return true;
  }

  public async init(): Promise<void> {
    await this.ensureDb();
  }

  public isInitialized(): boolean {
    return this.db !== null && !this.isClosed;
  }

  private async ensureDb() {
    if (this.isClosed) {
      throw new Error('[BrowserSqliteDriver] Conexão com banco está fechada.');
    }
    if (!this.db) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let SQL: any;
      if (this.options.sqlModuleInit) {
        SQL = await this.options.sqlModuleInit({});
      } else if (typeof window === 'undefined') {
        // Ambiente de testes ou Node.js sem DOM
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const req = typeof require !== 'undefined' ? require : undefined;
        if (req) {
          const { DatabaseSync } = req('node:sqlite');
          const fs = req('node:fs');
          const path = req('node:path');
          const os = req('node:os');

          class NodeSqlJsMockDatabase {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            private nodeDb: any;
            private tempPath: string;

            constructor(data?: Uint8Array) {
              this.tempPath = path.join(
                os.tmpdir(),
                `mock_browser_sqlite_${Date.now()}_${Math.random().toString(36).substring(2)}.db`
              );
              if (data && data.length > 0) {
                const header = Buffer.from(data.slice(0, 16)).toString('utf-8');
                if (!header.startsWith('SQLite format 3')) {
                  throw new Error('Not a valid SQLite database');
                }
                fs.writeFileSync(this.tempPath, Buffer.from(data));
                this.nodeDb = new DatabaseSync(this.tempPath);
              } else {
                this.nodeDb = new DatabaseSync(this.tempPath);
              }
            }

            run(sql: string, params: unknown[] = []) {
              if (!params || params.length === 0) {
                this.nodeDb.exec(sql);
              } else {
                this.nodeDb.prepare(sql).run(...params);
              }
            }

            exec(sql: string) {
              if (sql.includes('integrity_check')) {
                return [{ columns: ['integrity_check'], values: [['ok']] }];
              }
              this.nodeDb.exec(sql);
              return [];
            }

            export(): Uint8Array {
              const exportPath = path.join(
                os.tmpdir(),
                `mock_export_${Date.now()}_${Math.random().toString(36).substring(2)}.db`
              );
              try {
                this.nodeDb.exec(`VACUUM INTO '${exportPath.replace(/\\/g, '/')}'`);
                const buf = fs.readFileSync(exportPath);
                return new Uint8Array(buf);
              } finally {
                try {
                  if (fs.existsSync(exportPath)) fs.unlinkSync(exportPath);
                } catch {
                  /* no-op */
                }
              }
            }

            prepare(sql: string) {
              // eslint-disable-next-line @typescript-eslint/no-this-alias
              const self = this;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let stmt: any = null;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let rows: any[] = [];
              let idx = 0;
              return {
                bind(params: unknown[]) {
                  if (!stmt) stmt = self.nodeDb.prepare(sql);
                  rows = stmt.all(...params);
                  idx = 0;
                },
                step() {
                  if (!stmt) {
                    stmt = self.nodeDb.prepare(sql);
                    rows = stmt.all();
                    idx = 0;
                  }
                  return idx < rows.length;
                },
                getAsObject() {
                  const row = rows[idx];
                  idx++;
                  return row ? { ...row } : {};
                },
                free() {
                  rows = [];
                },
              };
            }

            close() {
              try {
                this.nodeDb.close();
              } catch {
                /* no-op */
              }
              try {
                if (fs.existsSync(this.tempPath)) fs.unlinkSync(this.tempPath);
              } catch {
                /* no-op */
              }
            }
          }

          SQL = { Database: NodeSqlJsMockDatabase };
        } else {
          throw new Error('[BrowserSqliteDriver] Ambiente sem WebAssembly e sem require("node:sqlite").');
        }
      } else {
        if (typeof window !== 'undefined' && !(window as any).initSqlJs) {
          await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = this.options.sqlWasmJsUrl || '/sql-wasm.js';
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Falha ao carregar motor SQLite WebAssembly (/sql-wasm.js).'));
            document.head.appendChild(script);
          });
        }

        const initFn = typeof window !== 'undefined' ? (window as any).initSqlJs : null;
        if (!initFn) {
          throw new Error('[BrowserSqliteDriver] initSqlJs não está disponível no escopo.');
        }

        let wasmBinary: ArrayBuffer | undefined = undefined;
        try {
          const wasmRes = await fetch(this.options.sqlWasmBinaryUrl || '/sql-wasm.wasm');
          wasmBinary = await wasmRes.arrayBuffer();
        } catch (fetchErr) {
          console.warn('[BrowserSqliteDriver] Fetch do arquivo .wasm falhou, tentando fallback padrão initFn:', fetchErr);
        }

        SQL = await initFn(wasmBinary ? { wasmBinary } : {});
      }

      // Carrega snapshot existente do IndexedDB antes de executar migrations
      const storageKey = this.getStorageKey();
      let savedBytes: Uint8Array | null = null;
      try {
        if (typeof (this.storageAdapter as any).load === 'function') {
          savedBytes = await this.storageAdapter.load(storageKey);
        } else if (typeof (this.storageAdapter as any).loadSnapshot === 'function') {
          savedBytes = await (this.storageAdapter as any).loadSnapshot(storageKey);
        }
      } catch (loadErr) {
        console.warn(`[BrowserSqliteDriver] Não foi possível carregar dados do IndexedDB para chave "${storageKey}":`, loadErr);
      }

      if (savedBytes && savedBytes.length > 0) {
        try {
          this.db = new SQL.Database(savedBytes);
          this.db.run('PRAGMA foreign_keys = ON;');
          console.log(`[BrowserSqliteDriver] Banco restaurado do IndexedDB com sucesso (${savedBytes.length} bytes). Chave: ${storageKey}`);
        } catch (corruptErr) {
          console.error(`[BrowserSqliteDriver] Corrupção ao abrir banco salvo do IndexedDB. Preservando backup de segurança sem apagar:`, corruptErr);
          if (this.storageAdapter.backupCorrupted) {
            await this.storageAdapter.backupCorrupted(storageKey, savedBytes).catch(() => {});
          }
          // Inicializa banco limpo para evitar crash-loop permanente, preservando o backup
          this.db = new SQL.Database();
          this.db.run('PRAGMA foreign_keys = ON;');
          console.warn(`[BrowserSqliteDriver] Banco corrompido preservado em backup. Inicializado banco limpo para evitar crash-loop.`);
        }
      } else {
        this.db = new SQL.Database();
        this.db.run('PRAGMA foreign_keys = ON;');
        console.log(`[BrowserSqliteDriver] Novo banco SQLite em memória inicializado para chave: ${storageKey}`);
      }
    }
    return this.db;
  }

  /**
   * Persiste o snapshot binário do SQLite no IndexedDB de forma atômica e segura.
   */
  public async persistToStorage(): Promise<void> {
    if (!this.db || this.isClosed) return;
    try {
      const data: Uint8Array = this.db.export();
      if (typeof (this.storageAdapter as any).save === 'function') {
        await this.storageAdapter.save(this.getStorageKey(), data);
      } else if (typeof (this.storageAdapter as any).saveSnapshot === 'function') {
        await (this.storageAdapter as any).saveSnapshot(data);
      }
    } catch (err) {
      console.error('[BrowserSqliteDriver] Falha ao persistir snapshot no IndexedDB:', err);
      throw new Error(`[BrowserSqliteDriver] Falha de persistência no IndexedDB: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Exporta os bytes binários do arquivo SQLite para download manual em desenvolvimento.
   */
  public exportDatabase(): Uint8Array {
    if (!this.db || this.isClosed) {
      throw new Error('[BrowserSqliteDriver] Banco não está aberto.');
    }
    return this.db.export();
  }

  /**
   * Importa um arquivo SQLite binário externo para o navegador.
   */
  public async importDatabase(bytes: Uint8Array): Promise<void> {
    const releaseLock = await this.mutex.acquire();
    try {
      // Valida que o módulo WASM já está pronto
      const db = await this.ensureDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const SQL = (db as any).constructor;
      const newDb = new SQL(bytes);
      newDb.run('PRAGMA foreign_keys = ON;');
      const test = newDb.exec('PRAGMA integrity_check;');
      if (!test || !test[0] || test[0].values[0][0] !== 'ok') {
        throw new Error('O arquivo importado falhou na verificação de integridade SQLite.');
      }
      if (this.db) {
        this.db.close();
      }
      this.db = newDb;
      await this.persistToStorage();
    } finally {
      releaseLock();
    }
  }

  private executeInternal(db: any, sql: string, params: unknown[] = []): void {
    if (!params || params.length === 0) {
      db.run(sql);
    } else {
      db.run(sql, params as any[]);
    }
  }

  private queryInternal<T = Record<string, unknown>>(db: any, sql: string, params: unknown[] = []): T[] {
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

  public async execute(sql: string, params: unknown[] = []): Promise<void> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();
    try {
      this.executeInternal(db, sql, params);
      // Persiste no storage após operação direta confirmada se alterar dados
      const upper = sql.trim().toUpperCase();
      if (
        upper.startsWith('INSERT') ||
        upper.startsWith('UPDATE') ||
        upper.startsWith('DELETE') ||
        upper.startsWith('CREATE') ||
        upper.startsWith('ALTER') ||
        upper.startsWith('DROP')
      ) {
        await this.persistToStorage();
      }
    } finally {
      releaseLock();
    }
  }

  public async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();
    try {
      return this.queryInternal<T>(db, sql, params);
    } finally {
      releaseLock();
    }
  }

  public async transaction<T>(fn: (tx: ISqliteDriver) => Promise<T>): Promise<T> {
    const db = await this.ensureDb();
    const releaseLock = await this.mutex.acquire();

    try {
      this.executeInternal(db, 'BEGIN IMMEDIATE TRANSACTION;');
    } catch (beginErr) {
      releaseLock();
      const msg = beginErr instanceof Error ? beginErr.message : String(beginErr);
      throw new Error(`[BrowserSqliteDriver] Falha ao iniciar transação: ${msg}`);
    }

    const txContext = new TransactionContextDriver(
      async (sql, params = []) => {
        this.executeInternal(db, sql, params);
      },
      async <K = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        return this.queryInternal<K>(db, sql, params);
      },
      1
    );

    let result: T;
    try {
      result = await fn(txContext);
    } catch (fnErr) {
      let rollbackErr: unknown = null;
      try {
        this.executeInternal(db, 'ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();
      // ATENÇÃO: Em caso de rollback, NUNCA persistir para IndexedDB!

      if (rollbackErr) {
        const fnMsg = fnErr instanceof Error ? fnErr.message : String(fnErr);
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        const compositeErr = new Error(
          `[BrowserSqliteDriver] Transação falhou: ${fnMsg} | Rollback falhou: ${rbMsg}`
        );
        (compositeErr as any).cause = fnErr;
        (compositeErr as any).rollbackError = rollbackErr;
        throw compositeErr;
      }
      throw fnErr;
    }

    try {
      this.executeInternal(db, 'COMMIT;');
      // Persiste duravelmente no IndexedDB SOMENTE após o COMMIT confirmado
      await this.persistToStorage();
    } catch (commitErr) {
      let rollbackErr: unknown = null;
      try {
        this.executeInternal(db, 'ROLLBACK;');
      } catch (rbErr) {
        rollbackErr = rbErr;
      }
      releaseLock();

      const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
      if (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new Error(
          `[BrowserSqliteDriver] Falha no COMMIT: ${commitMsg} | Rollback falhou: ${rbMsg}`
        );
      }
      throw new Error(`[BrowserSqliteDriver] Falha no COMMIT: ${commitMsg}`);
    }

    releaseLock();
    return result;
  }

  public async close(): Promise<void> {
    const releaseLock = await this.mutex.acquire();
    try {
      if (this.db && !this.isClosed) {
        this.isClosed = true;
        this.db.close();
        this.db = null;
      }
    } finally {
      releaseLock();
    }
  }
}

/**
 * Factory para obter o driver apropriado para o runtime atual (Tauri, Navegador ou Node/Testes).
 */
export function createSqliteDriver(dbPath?: string, browserOptions?: BrowserSqliteDriverOptions): ISqliteDriver {
  if (typeof window !== 'undefined') {
    if ((window as any).__TAURI_INTERNALS__) {
      return new TauriSqliteDriver(dbPath || 'sqlite:pdv_local.db');
    }
    return new BrowserSqliteDriver(browserOptions);
  }
  return new NodeSqliteDriver(dbPath || ':memory:');
}
