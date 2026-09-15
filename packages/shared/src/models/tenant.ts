export type TenantPlan = 'FREE_TRIAL' | 'PRO' | 'ENTERPRISE';
export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';

export interface TenantSettings {
  receiptHeader: string;
  receiptFooter: string;
  receiptWidthMm: 58 | 80;
  maxDiscountPercentageAllowedForCashier: number;
  enableTelegramAlerts: boolean;
  telegramChatId?: string;
  telegramBotToken?: string;
}

export interface Tenant {
  id: string;
  name: string;
  tradeName?: string;
  cnpj?: string;
  phone?: string;
  email: string;
  plan: TenantPlan;
  status: TenantStatus;
  settings: TenantSettings;
  createdAt: number;
  updatedAt: number;
}

export interface Store {
  id: string;
  tenantId: string;
  name: string;
  address?: string;
  phone?: string;
  createdAt: number;
}
