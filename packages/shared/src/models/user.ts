export type UserRole = 'ADMIN' | 'MANAGER' | 'CASHIER';

export interface User {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  role: UserRole;
  pinCode: string; // 4-6 dígitos para troca rápida de operador no caixa
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}
