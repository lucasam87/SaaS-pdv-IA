import { Product, Sale } from '@pdv/shared';

export interface LocalSyncMeta {
  lastSyncAt: number;
  totalLocalProducts: number;
  pendingSalesCount: number;
}

const STORAGE_PRODUCTS_KEY = 'pdv_local_products_v1';
const STORAGE_PENDING_SALES_KEY = 'pdv_pending_sales_v1';
const STORAGE_SYNC_META_KEY = 'pdv_sync_meta_v1';

class LocalDatabase {
  private productsByBarcode: Map<string, Product> = new Map();
  private productsList: Product[] = [];
  private pendingSalesQueue: Sale[] = [];
  private lastSyncAt: number = 0;

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const rawProducts = localStorage.getItem(STORAGE_PRODUCTS_KEY);
      if (rawProducts) {
        this.productsList = JSON.parse(rawProducts);
        this.rebuildIndex();
      }

      const rawSales = localStorage.getItem(STORAGE_PENDING_SALES_KEY);
      if (rawSales) {
        this.pendingSalesQueue = JSON.parse(rawSales);
      }

      const rawMeta = localStorage.getItem(STORAGE_SYNC_META_KEY);
      if (rawMeta) {
        const meta: LocalSyncMeta = JSON.parse(rawMeta);
        this.lastSyncAt = meta.lastSyncAt;
      }
    } catch (err) {
      console.error('[LocalDB] Erro ao carregar dados do armazenamento local:', err);
    }
  }

  private saveToStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_PRODUCTS_KEY, JSON.stringify(this.productsList));
      localStorage.setItem(STORAGE_PENDING_SALES_KEY, JSON.stringify(this.pendingSalesQueue));
      localStorage.setItem(
        STORAGE_SYNC_META_KEY,
        JSON.stringify({
          lastSyncAt: this.lastSyncAt,
          totalLocalProducts: this.productsList.length,
          pendingSalesCount: this.pendingSalesQueue.length,
        })
      );
    } catch (err) {
      console.error('[LocalDB] Erro ao persistir dados locais:', err);
    }
  }

  private rebuildIndex() {
    this.productsByBarcode.clear();
    for (const p of this.productsList) {
      if (p.barcode) {
        this.productsByBarcode.set(p.barcode.trim(), p);
      }
      if (p.additionalBarcodes && p.additionalBarcodes.length > 0) {
        for (const extraCode of p.additionalBarcodes) {
          this.productsByBarcode.set(extraCode.trim(), p);
        }
      }
    }
  }

  /**
   * Busca instantânea por código de barras (< 1ms).
   */
  public findByBarcode(barcode: string): Product | undefined {
    return this.productsByBarcode.get(barcode.trim());
  }

  /**
   * Busca rápida por nome ou código de barras com limite de resultados.
   */
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
   * Atualização Delta (Apenas Mudanças).
   * Insere novos produtos e atualiza os existentes.
   */
  public upsertDeltaProducts(incomingProducts: Product[], syncTimestamp: number) {
    const incomingMap = new Map(incomingProducts.map((p) => [p.id, p]));

    // Atualiza existentes
    this.productsList = this.productsList.map((existing) => {
      const updated = incomingMap.get(existing.id);
      if (updated) {
        incomingMap.delete(existing.id);
        return updated;
      }
      return existing;
    });

    // Adiciona os novos
    for (const newProduct of incomingMap.values()) {
      this.productsList.push(newProduct);
    }

    this.lastSyncAt = syncTimestamp;
    this.rebuildIndex();
    this.saveToStorage();
  }

  /**
   * Salva venda localmente e deduz o estoque local instantaneamente.
   */
  public recordLocalSale(sale: Sale) {
    // 1. Deduz estoque local
    for (const item of sale.items) {
      const product = this.productsList.find((p) => p.id === item.productId);
      if (product) {
        product.currentStock -= item.quantity;
      }
    }

    // 2. Coloca na fila de sincronização
    this.pendingSalesQueue.push(sale);
    this.saveToStorage();
  }

  public getPendingSales(): Sale[] {
    return [...this.pendingSalesQueue];
  }

  public markSalesAsSynced(syncedSaleIds: string[]) {
    const idSet = new Set(syncedSaleIds);
    this.pendingSalesQueue = this.pendingSalesQueue.filter((s) => !idSet.has(s.id));
    this.saveToStorage();
  }

  public getMeta(): LocalSyncMeta {
    return {
      lastSyncAt: this.lastSyncAt,
      totalLocalProducts: this.productsList.length,
      pendingSalesCount: this.pendingSalesQueue.length,
    };
  }

  /**
   * Popula produtos de teste para demonstração inicial caso esteja vazio.
   */
  public seedDemoProductsIfEmpty(tenantId: string) {
    if (this.productsList.length > 0) return;

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
        currentStock: 5, // Estoque baixo para alerta!
        unit: 'UN',
        category: 'Limpeza',
        isActive: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    this.upsertDeltaProducts(demoItems, Date.now());
  }
}

export const localDb = new LocalDatabase();
