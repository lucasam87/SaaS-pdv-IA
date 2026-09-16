import * as admin from 'firebase-admin';
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { UserRole, TenantPrivateSecrets } from '@pdv/shared';
import { verifyAuthToken, AuthenticatedUserContext } from './sale-endpoint';

if (admin.apps.length === 0) {
  admin.initializeApp();
}

/**
 * Validação rigorosa de autorização independente das Firestore Rules.
 * Garante que o chamador possui papel de ADMIN e pertence ao tenant solicitado.
 */
export function assertTenantAdmin(auth: AuthenticatedUserContext, targetTenantId: string): void {
  if (auth.tenantId !== targetTenantId) {
    throw new Error(
      `PERMISSION_DENIED: Usuário pertence ao tenant "${auth.tenantId}", acesso negado ao tenant "${targetTenantId}".`
    );
  }
  if (auth.role !== 'ADMIN') {
    throw new Error(
      `PERMISSION_DENIED: Operação restrita a administradores. Papel atual: "${auth.role || 'SEM_PAPEL'}".`
    );
  }
}

/**
 * Atribui ou atualiza Custom Claims (tenantId e role) para um usuário do tenant.
 * - Restrito a Administradores do mesmo tenant.
 * - Impede elevação indevida para outro tenant.
 * - Revoga tokens antigos imediatamente para garantir atualização da sessão.
 */
export async function assignUserClaims(
  caller: AuthenticatedUserContext,
  targetUid: string,
  targetTenantId: string,
  newRole: UserRole
): Promise<{ success: boolean; targetUid: string; tenantId: string; role: UserRole }> {
  // 1. Validação independente de autorização
  assertTenantAdmin(caller, targetTenantId);

  const validRoles: UserRole[] = ['ADMIN', 'MANAGER', 'CASHIER'];
  if (!validRoles.includes(newRole)) {
    throw new Error(`INVALID_ARGUMENT: Papel "${newRole}" inválido. Permitidos: ${validRoles.join(', ')}.`);
  }

  // 2. Gravação das Custom Claims via Firebase Admin SDK
  await admin.auth().setCustomUserClaims(targetUid, {
    tenantId: targetTenantId,
    role: newRole,
  });

  // 3. Atualização do documento do usuário no Firestore
  const userRef = admin.firestore().doc(`tenants/${targetTenantId}/users/${targetUid}`);
  await userRef.set(
    {
      id: targetUid,
      tenantId: targetTenantId,
      role: newRole,
      updatedAt: Date.now(),
    },
    { merge: true }
  );

  // 4. Revogação de tokens para forçar refresh e aplicar novas claims
  await admin.auth().revokeRefreshTokens(targetUid);

  return {
    success: true,
    targetUid,
    tenantId: targetTenantId,
    role: newRole,
  };
}

/**
 * Endpoint Callable para gerenciamento de Custom Claims de usuários.
 */
export const setUserClaims = onCall<{ targetUid: string; targetTenantId: string; role: UserRole }>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Requer autenticação.');
    }

    const caller: AuthenticatedUserContext = {
      uid: request.auth.uid,
      tenantId: (request.auth.token.tenantId as string) || request.auth.uid,
      role: (request.auth.token.role as string) || undefined,
    };

    const { targetUid, targetTenantId, role } = request.data;
    if (!targetUid || !targetTenantId || !role) {
      throw new HttpsError('invalid-argument', 'targetUid, targetTenantId e role são obrigatórios.');
    }

    try {
      return await assignUserClaims(caller, targetUid, targetTenantId, role);
    } catch (err: any) {
      if (err.message?.startsWith('PERMISSION_DENIED')) {
        throw new HttpsError('permission-denied', err.message);
      }
      if (err.message?.startsWith('INVALID_ARGUMENT')) {
        throw new HttpsError('invalid-argument', err.message);
      }
      throw new HttpsError('internal', err.message || 'Erro ao atribuir claims.');
    }
  }
);

/**
 * Bootstrap de Novo Tenant: Criação da loja e atribuição da claim de ADMIN ao fundador.
 */
export async function bootstrapTenantOwner(
  callerUid: string,
  tenantId: string,
  name: string,
  tradeName?: string
): Promise<{ success: boolean; tenantId: string }> {
  const tenantDocRef = admin.firestore().doc(`tenants/${tenantId}`);
  const existing = await tenantDocRef.get();
  if (existing.exists) {
    throw new Error(`ALREADY_EXISTS: O tenant "${tenantId}" já existe.`);
  }

  // Atribui claims de ADMIN e tenantId ao dono
  await admin.auth().setCustomUserClaims(callerUid, {
    tenantId,
    role: 'ADMIN',
  });

  // Cria documento público do tenant SEM qualquer segredo
  const now = Date.now();
  await tenantDocRef.set({
    id: tenantId,
    name,
    tradeName: tradeName || name,
    plan: 'PRO',
    status: 'ACTIVE',
    settings: {
      receiptHeader: name,
      receiptFooter: 'Obrigado pela preferência!',
      receiptWidthMm: 80,
      maxDiscountPercentageAllowedForCashier: 5,
      enableTelegramAlerts: false,
    },
    createdAt: now,
    updatedAt: now,
  });

  // Cria o registro do usuário admin
  await admin.firestore().doc(`tenants/${tenantId}/users/${callerUid}`).set({
    id: callerUid,
    tenantId,
    name: tradeName || name,
    role: 'ADMIN',
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return { success: true, tenantId };
}

/**
 * Gerenciamento Seguro de Segredos:
 * Grava chaves de API exclusivamente no documento privado /tenants/{tenantId}/private_config/secrets,
 * garantindo que nunca vazem para o documento raiz do tenant acessível pelos caixas.
 */
export async function saveTenantSecrets(
  caller: AuthenticatedUserContext,
  targetTenantId: string,
  secrets: { telegramBotToken?: string; geminiApiKey?: string }
): Promise<{ success: boolean }> {
  assertTenantAdmin(caller, targetTenantId);

  const secretsRef = admin.firestore().doc(`tenants/${targetTenantId}/private_config/secrets`);
  const data: TenantPrivateSecrets = {
    telegramBotToken: secrets.telegramBotToken?.trim() || undefined,
    geminiApiKey: secrets.geminiApiKey?.trim() || undefined,
    updatedAt: Date.now(),
  };

  await secretsRef.set(data, { merge: true });
  return { success: true };
}

/**
 * Utilitário interno para backend (Cloud Functions, Grafo Noturno, etc.):
 * Lê com segurança os segredos armazenados na coleção privada.
 */
export async function getTenantSecrets(tenantId: string): Promise<TenantPrivateSecrets | null> {
  const secretsDoc = await admin
    .firestore()
    .doc(`tenants/${tenantId}/private_config/secrets`)
    .get();

  if (!secretsDoc.exists) {
    return null;
  }

  return secretsDoc.data() as TenantPrivateSecrets;
}

/**
 * Endpoint REST para atualização segura de segredos do tenant.
 */
export const apiSetTenantSecrets = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'METHOD_NOT_ALLOWED: Apenas POST é permitido.' });
    return;
  }

  try {
    const authContext = await verifyAuthToken(req.headers.authorization);
    const { tenantId, telegramBotToken, geminiApiKey } = req.body || {};

    if (!tenantId) {
      res.status(400).json({ success: false, error: 'INVALID_PAYLOAD: tenantId é obrigatório.' });
      return;
    }

    await saveTenantSecrets(authContext, tenantId, { telegramBotToken, geminiApiKey });
    res.status(200).json({ success: true, message: 'Segredos atualizados com sucesso no cofre privado.' });
  } catch (err: any) {
    const errMsg = err.message || String(err);
    if (errMsg.startsWith('UNAUTHENTICATED')) {
      res.status(401).json({ success: false, error: errMsg });
    } else if (errMsg.startsWith('PERMISSION_DENIED')) {
      res.status(403).json({ success: false, error: errMsg });
    } else {
      res.status(500).json({ success: false, error: errMsg });
    }
  }
});
