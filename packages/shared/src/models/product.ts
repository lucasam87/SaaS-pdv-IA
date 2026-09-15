export type ProductUnit = 'UN' | 'KG' | 'CX' | 'PCT' | 'L' | 'M';

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  barcode: string; // EAN principal
  additionalBarcodes?: string[]; // Outros códigos de barra do mesmo produto
  costPrice: number; // Preço de custo
  sellingPrice: number; // Preço de venda no balcão
  minStock: number; // Estoque mínimo para disparo de compras
  currentStock: number; // Saldo em estoque
  unit: ProductUnit;
  category?: string;
  ncm?: string; // Classificação fiscal básica para cupom
  isActive: boolean;
  createdAt: number;
  updatedAt: number; // Timestamp crítico para a sincronização delta
}

export interface ProductLot {
  id: string;
  tenantId: string;
  productId: string;
  lotNumber: string;
  expirationDate: string; // Formato ISO YYYY-MM-DD
  quantity: number;
  createdAt: number;
}

export type StockMovementType =
  | 'SALE'
  | 'PURCHASE_XML'
  | 'MANUAL_IN'
  | 'MANUAL_OUT'
  | 'EXPIRY_LOSS'
  | 'DAMAGE'
  | 'ADJUSTMENT';

export interface StockMovement {
  id: string;
  tenantId: string;
  productId: string;
  lotId?: string;
  type: StockMovementType;
  quantity: number; // Positivo para entrada, negativo para saída
  balanceAfter: number;
  reason?: string;
  userId: string;
  userName: string;
  createdAt: number;
}
