export type SignalType = 'STOCK_NEGATIVE_CONFLICT' | 'HIGH_RUPTURE_RISK' | 'EXPIRATION_ALERT';

export interface StockNegativeConflictPayload {
  productId: string;
  productName: string;
  barcode: string;
  negativeBalance: number;
  saleIds: string[];
  deviceIds: string[];
  occurredAt: number;
}

export interface SystemSignal {
  id: string;
  tenantId: string;
  type: SignalType;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: StockNegativeConflictPayload | any;
  createdAt: number;
  resolvedAt?: number;
}
