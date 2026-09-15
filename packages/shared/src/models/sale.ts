export type PaymentMethod = 'DINHEIRO' | 'PIX' | 'DEBITO' | 'CREDITO' | 'FIADO';

export type SaleStatus = 'COMPLETED' | 'CANCELLED';

export interface SaleItem {
  productId: string;
  productName: string;
  barcode: string;
  quantity: number;
  unitPrice: number;
  unitCost: number;
  discount: number;
  totalPrice: number;
  totalCost: number;
  lotId?: string;
}

export interface SalePayment {
  method: PaymentMethod;
  amount: number;
  changeAmount?: number; // Troco fornecido no caso de dinheiro
}

export interface Sale {
  id: string;
  tenantId: string;
  sessionId: string;
  deviceId: string; // Identificador do terminal (ex: "caixa-01", "caixa-02")
  saleNumber: number; // Sequencial simples da loja
  userId: string;
  userName: string;
  customerName?: string;
  customerPhone?: string;
  
  subtotal: number;
  discount: number;
  total: number;
  totalCost: number;
  
  items: SaleItem[];
  payments: SalePayment[];
  
  status: SaleStatus;
  createdAt: number;
  syncedAt?: number; // Data em que a venda local subiu para o Firebase
  operationId?: string; // Identificador único da operação para idempotência na nuvem
}
