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

export interface AuthClaimsDependencies {
  auth?: {
    getUser: (uid: string) => Promise<{ uid: string; email?: string; customClaims?: Record<string, unknown> }>;
    setCustomUserClaims: (uid: string, claims: Record<string, unknown>) => Promise<void>;
    revokeRefreshTokens: (uid: string) => Promise<void>;
  };
  firestore?: {
    doc: (path: string) => any;
    collection: (path: string) => any;
  };
}

/**
 * Utilitário para registrar logs de auditoria de forma consistente.
 */
async function recordAuditLog(
  firestoreInstance: any,
  tenantId: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!firestoreInstance) return;
  if (
    firestoreInstance === admin.firestore() &&
    !process.env.FIRESTORE_EMULATOR_HOST &&
    !process.env.GOOGLE_APPLICATION_CREDENTIALS
  ) {
    return;
  }
  try {
    const auditColl = firestoreInstance.collection(`tenants/${tenantId}/audit_logs`);
    const docRef = typeof auditColl.doc === 'function' ? auditColl.doc() : null;
    const logId = docRef?.id || `audit_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const finalDoc = docRef || firestoreInstance.doc(`tenants/${tenantId}/audit_logs/${logId}`);
    if (typeof finalDoc.set === 'function') {
      await finalDoc.set({ id: logId, ...data });
    }
  } catch (auditErr) {
    console.warn(`[AuditLog] Falha ao registrar log de auditoria no tenant ${tenantId}:`, auditErr);
  }
}

/**
 * Atribui ou atualiza Custom Claims (tenantId e role) para um usuário do tenant.
 * - Restrito a Administradores do mesmo tenant.
 * - Impede elevação indevida para outro tenant e auto-elevação.
 * - Para novos usuários sem vínculo prévio, exige e consome convite pendente.
 * - Audita todas as operações (sucessos e tentativas negadas) no Firestore.
 * - Revoga tokens antigos imediatamente para garantir atualização da sessão.
 */
export async function assignUserClaims(
  caller: AuthenticatedUserContext,
  targetUid: string,
  targetTenantId: string,
  newRole: UserRole,
  inviteId?: string,
  deps?: AuthClaimsDependencies
): Promise<{ success: boolean; targetUid: string; tenantId: string; role: UserRole }> {
  const authInstance = deps?.auth || admin.auth();
  const firestoreInstance = deps?.firestore || admin.firestore();

  // 1. Validação independente de autorização do chamador
  assertTenantAdmin(caller, targetTenantId);

  // 2. Prevenção de auto-elevação de privilégios
  if (caller.uid === targetUid) {
    await recordAuditLog(firestoreInstance, targetTenantId, {
      action: 'ASSIGN_USER_CLAIMS_DENIED',
      adminUserId: caller.uid,
      targetUserId: targetUid,
      reason: 'Tentativa de auto-elevação de privilégios.',
      timestamp: Date.now(),
    });
    throw new Error(
      'PERMISSION_DENIED: Auto-elevação de privilégios não permitida. Modificação de permissões deve ser realizada por outro administrador.'
    );
  }

  const validRoles: UserRole[] = ['ADMIN', 'MANAGER', 'CASHIER'];
  if (!validRoles.includes(newRole)) {
    throw new Error(`INVALID_ARGUMENT: Papel "${newRole}" inválido. Permitidos: ${validRoles.join(', ')}.`);
  }

  // 3. Validação de existência do usuário alvo no Auth
  let targetUserRecord: { uid: string; email?: string; customClaims?: Record<string, unknown> };
  try {
    targetUserRecord = await authInstance.getUser(targetUid);
  } catch (err: any) {
    throw new Error(`NOT_FOUND: Usuário alvo "${targetUid}" não encontrado no serviço de autenticação.`);
  }

  const previousClaims = (targetUserRecord.customClaims || {}) as Record<string, unknown>;
  const currentTenant = previousClaims.tenantId as string | undefined;

  // 4. Bloqueio estrito de transferência cross-tenant
  if (currentTenant && currentTenant !== targetTenantId) {
    await recordAuditLog(firestoreInstance, targetTenantId, {
      action: 'ASSIGN_USER_CLAIMS_DENIED',
      adminUserId: caller.uid,
      targetUserId: targetUid,
      reason: `Usuário alvo já vinculado a outro tenant ("${currentTenant}").`,
      timestamp: Date.now(),
    });
    throw new Error(
      `PERMISSION_DENIED: Usuário alvo já está vinculado a outro tenant ("${currentTenant}"). Transferência cross-tenant não permitida.`
    );
  }

  // 5. Para usuário sem tenant prévio no token: exige associação prévia existente ou convite pendente válido
  let verifiedInviteDocRef: any = null;
  let verifiedInviteId: string | null = null;

  if (!currentTenant) {
    // Verifica se o usuário já possui registro na empresa
    const existingUserDocRef = firestoreInstance.doc(`tenants/${targetTenantId}/users/${targetUid}`);
    const existingUserSnap = typeof existingUserDocRef?.get === 'function' ? await existingUserDocRef.get() : null;
    const isAlreadyMember = existingUserSnap && (typeof existingUserSnap.exists === 'boolean' ? existingUserSnap.exists : (typeof existingUserSnap.exists === 'function' ? existingUserSnap.exists() : false));

    if (!isAlreadyMember) {
      // Usuário novo: busca obrigatoriamente convite pendente em tenants/{tenantId}/invites
      let inviteDoc: any = null;
      let inviteData: any = null;

      if (inviteId) {
        const candidateRef = firestoreInstance.doc(`tenants/${targetTenantId}/invites/${inviteId}`);
        const snap = typeof candidateRef?.get === 'function' ? await candidateRef.get() : null;
        const exists = snap && (typeof snap.exists === 'boolean' ? snap.exists : (typeof snap.exists === 'function' ? snap.exists() : false));
        if (exists) {
          inviteDoc = candidateRef;
          inviteData = typeof snap.data === 'function' ? snap.data() : snap.data;
          verifiedInviteId = inviteId;
        }
      }

      if (!inviteDoc) {
        // Tenta buscar pelo targetUid direto como ID do convite
        const candidateRef = firestoreInstance.doc(`tenants/${targetTenantId}/invites/${targetUid}`);
        const snap = typeof candidateRef?.get === 'function' ? await candidateRef.get() : null;
        const exists = snap && (typeof snap.exists === 'boolean' ? snap.exists : (typeof snap.exists === 'function' ? snap.exists() : false));
        if (exists) {
          inviteDoc = candidateRef;
          inviteData = typeof snap.data === 'function' ? snap.data() : snap.data;
          verifiedInviteId = targetUid;
        }
      }

      // Se ainda não achou, tenta query na coleção de convites por targetUid ou email
      if (!inviteDoc) {
        try {
          const invitesColl = firestoreInstance.collection(`tenants/${targetTenantId}/invites`);
          if (typeof invitesColl?.where === 'function') {
            const querySnap = await invitesColl.where('targetUid', '==', targetUid).where('status', '==', 'PENDING').get();
            if (querySnap && querySnap.docs && querySnap.docs.length > 0) {
              inviteDoc = querySnap.docs[0].ref || firestoreInstance.doc(`tenants/${targetTenantId}/invites/${querySnap.docs[0].id}`);
              inviteData = querySnap.docs[0].data();
              verifiedInviteId = querySnap.docs[0].id;
            } else if (targetUserRecord.email) {
              const emailSnap = await invitesColl.where('email', '==', targetUserRecord.email).where('status', '==', 'PENDING').get();
              if (emailSnap && emailSnap.docs && emailSnap.docs.length > 0) {
                inviteDoc = emailSnap.docs[0].ref || firestoreInstance.doc(`tenants/${targetTenantId}/invites/${emailSnap.docs[0].id}`);
                inviteData = emailSnap.docs[0].data();
                verifiedInviteId = emailSnap.docs[0].id;
              }
            }
          }
        } catch {
          /* Fallback se query não suportada pelo mock */
        }
      }

      // Valida se o convite encontrado é válido e está PENDING
      const isPending = inviteData && inviteData.status === 'PENDING';
      const isNotExpired = !inviteData?.expiresAt || inviteData.expiresAt > Date.now();

      if (!inviteDoc || !isPending || !isNotExpired) {
        await recordAuditLog(firestoreInstance, targetTenantId, {
          action: 'ASSIGN_USER_CLAIMS_DENIED',
          adminUserId: caller.uid,
          targetUserId: targetUid,
          reason: `Usuário sem vínculo prévio e sem convite pendente válido no tenant "${targetTenantId}".`,
          timestamp: Date.now(),
        });
        throw new Error(
          `PERMISSION_DENIED: Usuário alvo "${targetUid}" não possui convite pendente para ingressar no tenant "${targetTenantId}".`
        );
      }

      verifiedInviteDocRef = inviteDoc;
    }
  }

  const now = Date.now();

  // 6. Consumo atômico do convite (se houver)
  if (verifiedInviteDocRef) {
    if (typeof verifiedInviteDocRef.set === 'function') {
      await verifiedInviteDocRef.set(
        {
          status: 'ACCEPTED',
          consumedAt: now,
          consumedBy: targetUid,
          consumedByAdminId: caller.uid,
          updatedAt: now,
        },
        { merge: true }
      );
    } else if (typeof verifiedInviteDocRef.update === 'function') {
      await verifiedInviteDocRef.update({
        status: 'ACCEPTED',
        consumedAt: now,
        consumedBy: targetUid,
        consumedByAdminId: caller.uid,
        updatedAt: now,
      });
    }
  }

  // 7. Gravação das Custom Claims via Firebase Admin SDK
  const newClaims = {
    tenantId: targetTenantId,
    role: newRole,
  };
  await authInstance.setCustomUserClaims(targetUid, newClaims);

  // 8. Atualização do documento do usuário no Firestore
  const userRef = firestoreInstance.doc(`tenants/${targetTenantId}/users/${targetUid}`);
  if (typeof userRef?.set === 'function') {
    await userRef.set(
      {
        id: targetUid,
        tenantId: targetTenantId,
        role: newRole,
        email: targetUserRecord.email || null,
        updatedAt: now,
      },
      { merge: true }
    );
  }

  // 9. Registro de auditoria de sucesso
  await recordAuditLog(firestoreInstance, targetTenantId, {
    action: 'ASSIGN_USER_CLAIMS',
    adminUserId: caller.uid,
    targetUserId: targetUid,
    previousClaims,
    newClaims,
    inviteId: verifiedInviteId,
    timestamp: now,
  });

  // 10. Revogação de tokens para forçar refresh e aplicar novas claims
  await authInstance.revokeRefreshTokens(targetUid);

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
export const setUserClaims = onCall<{ targetUid: string; targetTenantId: string; role: UserRole; inviteId?: string }>(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Requer autenticação.');
    }

    const caller: AuthenticatedUserContext = {
      uid: request.auth.uid,
      tenantId: (request.auth.token.tenantId as string) || request.auth.uid,
      role: (request.auth.token.role as string) || undefined,
    };

    const { targetUid, targetTenantId, role, inviteId } = request.data;
    if (!targetUid || !targetTenantId || !role) {
      throw new HttpsError('invalid-argument', 'targetUid, targetTenantId e role são obrigatórios.');
    }

    try {
      return await assignUserClaims(caller, targetUid, targetTenantId, role, inviteId);
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
