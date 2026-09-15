export interface TopSellingItem {
  productId: string;
  name: string;
  quantity: number;
  totalRevenue: number;
}

export interface OutOfStockItem {
  productId: string;
  name: string;
  barcode: string;
  lastSaleDate?: number;
}

export interface ExpiringLotItem {
  productId: string;
  productName: string;
  lotNumber: string;
  expirationDate: string;
  daysRemaining: number;
  quantity: number;
}

export interface DailySummary {
  id: string; // Formato YYYY-MM-DD
  tenantId: string;
  date: string; // YYYY-MM-DD
  
  totalSalesCount: number;
  totalRevenue: number;
  totalCost: number;
  grossProfit: number;
  grossMarginPercentage: number;
  averageTicket: number;
  
  revenueByMethod: {
    cash: number;
    pix: number;
    debit: number;
    credit: number;
    fiado: number;
  };
  
  cashRegisterBalance: {
    expected: number;
    reported: number;
    difference: number;
  };
  
  topSellingProducts: TopSellingItem[];
  outOfStockProducts: OutOfStockItem[];
  expiringProducts: ExpiringLotItem[];
  
  nightAnalysisMarkdown: string; // Texto formatado gerado pela IA Gemini
  telegramSentAt?: number;
  createdAt: number;
}
