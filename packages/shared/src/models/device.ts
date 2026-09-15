export interface Device {
  id: string; // ex: "caixa-01", "caixa-02", "gestao-web"
  tenantId: string;
  storeId: string;
  name: string; // "Caixa Principal", "Caixa Balcão 2", "PC Escritório"
  active: boolean;
  createdAt: number;
  lastActiveAt?: number;
}
