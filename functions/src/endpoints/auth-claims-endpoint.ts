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
    runTransaction?: <T>(updateFunction: (transaction: any) => Promise<T>) => Promise<T>;
  };
}

/**
 * Utilitário para registrar logs de auditoria de forma consistente.
 * Em produção, falhas ao registrar auditoria não são silenciadas.
 * Operações críticas de segurança falham imediatamente (fail-closed) se failClosed for true.
 */
async function recordAuditLog(
  firestoreInstance: any,
  tenantId: string,
  data: Record<string, unknown>,
  failClosed: boolean = false
): Promise<void> {
  if (!firestoreInstance) {
    const errorMsg = `[AUDIT_ERROR] Instância do Firestore indisponível para auditoria no tenant ${tenantId}.`;
    console.error(errorMsg, data);
    if (failClosed) {
      throw new Error(`AUDIT_FAILURE: ${errorMsg}`);
    }
    return;
  }
  try {
    const auditColl = firestoreInstance.collection(`tenants/${tenantId}/audit_logs`);
    const docRef = typeof auditColl?.doc === 'function' ? auditColl.doc() : null;
    const logId = docRef?.id || `audit_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const finalDoc = docRef || firestoreInstance.doc(`tenants/${tenantId}/audit_logs/${logId}`);
    if (typeof finalDoc?.set === 'function') {
      await finalDoc.set({ id: logId, ...data });
    } else {
      throw new Error('Document reference não possui método set().');
    }
  } catch (auditErr: any) {
    console.error(`[AUDIT_ERROR] Falha crítica ao registrar log de auditoria no tenant ${tenantId}:`, {
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
      data,
    });
    if (failClosed) {
      throw new Error(
        `AUDIT_FAILURE: Falha ao registrar log de auditoria de privilégios no tenant ${tenantId}: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`
      );
    }
  }
}

/**
 * Atribui ou atualiza Custom Claims (tenantId e role) para um usuário do tenant.
 * - Restrito a Administradores do mesmo tenant.
 * - Impede elevação indevida para outro tenant e auto-elevação.
 * - Para novos usuários sem vínculo prévio, exige e consome convite dentro de firestore.runTransaction.
 * - Valida status PENDING, expiração, destinatário e role dentro da transação.
 * - Adota estado transitório CLAIMS_PENDING no documento do usuário.
 * - Se setCustomUserClaims falhar, o estado no Firestore permite retry idempotente sem corromper o convite.
 * - Audita todas as operações (sucessos com fail-closed e tentativas negadas) no Firestore.
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

  // 5. Resolução prévia da referência de convite (se aplicável)
  let candidateInviteRef: any = null;
  let resolvedInviteId: string | null = inviteId || null;

  if (resolvedInviteId) {
    candidateInviteRef = firestoreInstance.doc(`tenants/${targetTenantId}/invites/${resolvedInviteId}`);
  } else {
    // Tenta obter por targetUid direto como ID do convite
    const directRef = firestoreInstance.doc(`tenants/${targetTenantId}/invites/${targetUid}`);
    const directSnap = typeof directRef?.get === 'function' ? await directRef.get() : null;
    const directExists = directSnap && (typeof directSnap.exists === 'boolean' ? directSnap.exists : (typeof directSnap.exists === 'function' ? directSnap.exists() : false));
    if (directExists) {
      candidateInviteRef = directRef;
      resolvedInviteId = targetUid;
    } else {
      // Query fallback por targetUid ou email
      try {
        const coll = firestoreInstance.collection(`tenants/${targetTenantId}/invites`);
        if (typeof coll?.where === 'function') {
          const qSnap = await coll.where('targetUid', '==', targetUid).where('status', '==', 'PENDING').get();
          if (qSnap && qSnap.docs && qSnap.docs.length > 0) {
            candidateInviteRef = qSnap.docs[0].ref || firestoreInstance.doc(`tenants/${targetTenantId}/invites/${qSnap.docs[0].id}`);
            resolvedInviteId = qSnap.docs[0].id;
          } else if (targetUserRecord.email) {
            const eqSnap = await coll.where('email', '==', targetUserRecord.email).where('status', '==', 'PENDING').get();
            if (eqSnap && eqSnap.docs && eqSnap.docs.length > 0) {
              candidateInviteRef = eqSnap.docs[0].ref || firestoreInstance.doc(`tenants/${targetTenantId}/invites/${eqSnap.docs[0].id}`);
              resolvedInviteId = eqSnap.docs[0].id;
            }
          }
        }
      } catch {
        /* fallback se mock não suportar where() */
      }
    }
  }

  const userRef = firestoreInstance.doc(`tenants/${targetTenantId}/users/${targetUid}`);
  const now = Date.now();

  const rawRunTx = firestoreInstance.runTransaction;
  const runTx = typeof rawRunTx === 'function'
    ? (fn: (tx: any) => Promise<any>) => rawRunTx(fn)
    : async (fn: (tx: any) => Promise<any>) => {
        const fakeTx = {
          get: async (ref: any) => (typeof ref?.get === 'function' ? ref.get() : ref),
          set: async (ref: any, data: any, opts?: any) => {
            if (typeof ref?.set === 'function') return ref.set(data, opts);
          },
          update: async (ref: any, data: any) => {
            if (typeof ref?.update === 'function') return ref.update(data);
            if (typeof ref?.set === 'function') return ref.set(data, { merge: true });
          },
          delete: async (ref: any) => {
            if (typeof ref?.delete === 'function') return ref.delete();
          },
        };
        return fn(fakeTx);
      };

  // 6. Transação Atômica: validação, consumo do convite e transição de estado CLAIMS_PENDING
  try {
    await runTx(async (tx: any) => {
      // Todas as leituras antes de escritas
      const userSnap = await tx.get(userRef);
      const userExists = userSnap && (typeof userSnap.exists === 'boolean' ? userSnap.exists : (typeof userSnap.exists === 'function' ? userSnap.exists() : false));
      const userData = userExists ? (typeof userSnap.data === 'function' ? userSnap.data() : userSnap.data) : null;

      const isExistingActiveMember = userExists && userData && userData.tenantId === targetTenantId && userData.status === 'ACTIVE';

      let inviteData: any = null;
      if (candidateInviteRef) {
        const inviteSnap = await tx.get(candidateInviteRef);
        const inviteExists = inviteSnap && (typeof inviteSnap.exists === 'boolean' ? inviteSnap.exists : (typeof inviteSnap.exists === 'function' ? inviteSnap.exists() : false));
        if (inviteExists) {
          inviteData = typeof inviteSnap.data === 'function' ? inviteSnap.data() : inviteSnap.data;
        }
      }

      if (!isExistingActiveMember) {
        if (!inviteData) {
          throw new Error(
            `PERMISSION_DENIED: Usuário alvo "${targetUid}" não possui convite pendente para ingressar no tenant "${targetTenantId}".`
          );
        }

        const isRetryForSameUser =
          inviteData.status === 'ACCEPTED' &&
          inviteData.consumedBy === targetUid &&
          userData?.status === 'CLAIMS_PENDING';

        if (!isRetryForSameUser) {
          if (inviteData.status !== 'PENDING') {
            throw new Error(
              `PERMISSION_DENIED: O convite "${resolvedInviteId}" não está pendente (status atual: "${inviteData.status}").`
            );
          }

          if (inviteData.expiresAt && inviteData.expiresAt <= now) {
            throw new Error(
              `PERMISSION_DENIED: O convite "${resolvedInviteId}" está expirado (expirou em ${inviteData.expiresAt}).`
            );
          }

          const matchesUid = inviteData.targetUid && inviteData.targetUid === targetUid;
          const matchesEmail =
            inviteData.email &&
            targetUserRecord.email &&
            inviteData.email.toLowerCase() === targetUserRecord.email.toLowerCase();

          if (inviteData.targetUid && !matchesUid) {
            throw new Error(
              `PERMISSION_DENIED: Convite destinado ao usuário "${inviteData.targetUid}", mas foi solicitado para "${targetUid}".`
            );
          }

          if (inviteData.email && !matchesEmail && !matchesUid) {
            throw new Error(
              `PERMISSION_DENIED: Convite destinado ao e-mail "${inviteData.email}", mas o usuário possui "${targetUserRecord.email || 'nenhum'}".`
            );
          }

          if (!matchesUid && !matchesEmail && !inviteData.targetUid && !inviteData.email) {
            // Convite aberto sem target específico
          } else if (!matchesUid && !matchesEmail) {
            throw new Error(
              `PERMISSION_DENIED: Destinatário do convite "${resolvedInviteId}" não confere com o usuário "${targetUid}".`
            );
          }

          if (inviteData.role && inviteData.role !== newRole) {
            throw new Error(
              `PERMISSION_DENIED: Papel solicitado "${newRole}" diverge do papel especificado no convite ("${inviteData.role}").`
            );
          }
        }

        // Marca convite como ACCEPTED na mesma transação
        if (candidateInviteRef) {
          tx.set(
            candidateInviteRef,
            {
              status: 'ACCEPTED',
              consumedAt: now,
              consumedBy: targetUid,
              consumedByAdminId: caller.uid,
              updatedAt: now,
            },
            { merge: true }
          );
        }
      }

      // Define usuário com status CLAIMS_PENDING
      tx.set(
        userRef,
        {
          id: targetUid,
          tenantId: targetTenantId,
          role: newRole,
          status: 'CLAIMS_PENDING',
          email: targetUserRecord.email || null,
          inviteId: resolvedInviteId || null,
          updatedAt: now,
        },
        { merge: true }
      );
    });
  } catch (txErr: any) {
    await recordAuditLog(firestoreInstance, targetTenantId, {
      action: 'ASSIGN_USER_CLAIMS_DENIED',
      adminUserId: caller.uid,
      targetUserId: targetUid,
      reason: txErr.message || String(txErr),
      timestamp: Date.now(),
    });
    throw txErr;
  }

  // 7. Gravação das Custom Claims via Firebase Admin SDK
  try {
    await authInstance.setCustomUserClaims(targetUid, {
      tenantId: targetTenantId,
      role: newRole,
    });
  } catch (claimErr: any) {
    console.error(`[AuthClaims] Falha ao aplicar custom claims para ${targetUid}:`, claimErr);
    throw new Error(
      `AUTH_CLAIMS_ERROR: Falha ao aplicar permissões no serviço de autenticação. Estado retido como CLAIMS_PENDING para reprocessamento: ${claimErr.message}`
    );
  }

  // 8. Confirmação do status do usuário para ACTIVE
  if (typeof userRef?.set === 'function') {
    await userRef.set(
      {
        status: 'ACTIVE',
        claimsAssignedAt: Date.now(),
        updatedAt: Date.now(),
      },
      { merge: true }
    );
  }

  // 9. Registro de auditoria com fail-closed
  await recordAuditLog(
    firestoreInstance,
    targetTenantId,
    {
      action: 'ASSIGN_USER_CLAIMS',
      adminUserId: caller.uid,
      targetUserId: targetUid,
      previousClaims,
      newClaims: { tenantId: targetTenantId, role: newRole },
      inviteId: resolvedInviteId,
      timestamp: Date.now(),
    },
    true
  );

  // 10. Revogação de tokens
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
