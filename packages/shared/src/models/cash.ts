export type CashSessionStatus = 'OPEN' | 'CLOSED';

export interface CashSession {
  id: string;
  tenantId: string;
  terminalNumber: number;
  deviceId: string; // ex: "caixa-01", "caixa-02"
  openedByUserId: string;
  openedByName: string;
  openedAt: number;
  closedAt?: number;
  closedByUserId?: string;
  closedByName?: string;
  
  initialAmount: number; // Fundo de troco inicial
  finalReportedAmount?: number; // Valor contado e informado pelo operador no fechamento
  systemCalculatedAmount?: number; // Valor apurado matematicamente pelo sistema
  differenceAmount?: number; // Sobra (+) ou Falta (-) de dinheiro no caixa
  
  totalCashSales: number;
  totalPixSales: number;
  totalCardSales: number;
  totalCreditSales: number; // Vendas a prazo / Fiado
  totalSangrias: number;
  totalSuprimentos: number;
  
  status: CashSessionStatus;
  notes?: string;
}

export type CashMovementType = 'SANGRIA' | 'SUPRIMENTO';

export interface CashMovement {
  id: string;
  tenantId: string;
  sessionId: string;
  type: CashMovementType;
  amount: number;
  reason: string;
  userId: string;
  userName: string;
  createdAt: number;
}
