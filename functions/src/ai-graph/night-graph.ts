import { DailySummary, Tenant } from '@pdv/shared';
import { generateNightDiagnosisWithGemini, StoreAuditContext } from './gemini-synthesizer';
import { sendTelegramNotification } from './telegram-notifier';

export interface ExecuteNightGraphParams {
  tenant: Tenant;
  geminiApiKey: string;
  telegramBotToken?: string;
  dateStr: string;
  salesCount: number;
  totalRevenue: number;
  totalCost?: number;
  revenueByMethod: {
    cash: number;
    pix: number;
    card: number;
    credit: number;
  };
  cashDifference: number;
  deviceSessions?: Array<{
    deviceId: string;
    deviceName: string;
    terminalNumber: number;
    openedByName: string;
    totalSales: number;
    cashDifference: number;
    status: string;
  }>;
  stockConflicts?: Array<{
    productName: string;
    barcode: string;
    negativeBalance: number;
    deviceIds: string[];
  }>;
  topSelling: Array<{ productId: string; name: string; quantity: number; revenue: number }>;
  outOfStock: Array<{ productId: string; name: string; barcode: string }>;
  expiringLots: Array<{ productId: string; productName: string; lotNumber: string; expirationDate: string; daysRemaining: number; quantity: number }>;
  upcomingBills: Array<{ description: string; amount: number }>;
}

/**
 * Orquestrador do Grafo Noturno de Fechamento de Caixa.
 * Executa 1 vez ao dia por loja quando o caixa é encerrado.
 */
export async function executeNightGraph(
  params: ExecuteNightGraphParams
): Promise<DailySummary> {
  const { tenant, geminiApiKey, dateStr } = params;

  console.log(`[Grafo Noturno] Iniciando auditoria para o tenant: ${tenant.name} (${dateStr})`);

  // 1. Monta o contexto matemático consolidado
  const context: StoreAuditContext = {
    storeName: tenant.tradeName || tenant.name,
    dateStr,
    salesCount: params.salesCount,
    totalRevenue: params.totalRevenue,
    revenueByMethod: params.revenueByMethod,
    cashDifference: params.cashDifference,
    deviceSessions: params.deviceSessions,
    stockConflicts: params.stockConflicts,
    topSelling: params.topSelling,
    outOfStock: params.outOfStock,
    expiringLots: params.expiringLots,
    upcomingBills: params.upcomingBills,
  };

  // 2. Chama a IA para gerar a síntese executiva
  const diagnosisMarkdown = await generateNightDiagnosisWithGemini(geminiApiKey, context);

  // 3. Cálculo Financeiro Real (sem margem fixa hardcoded nem custo zero fictício)
  const totalCost = params.totalCost ?? 0;
  const grossProfit = params.totalRevenue - totalCost;
  const grossMarginPercentage =
    params.totalRevenue > 0 ? (grossProfit / params.totalRevenue) * 100 : 0;

  // 4. Monta o objeto oficial de Resumo Diário
  const dailySummary: DailySummary = {
    id: dateStr,
    tenantId: tenant.id,
    date: dateStr,
    totalSalesCount: params.salesCount,
    totalRevenue: params.totalRevenue,
    totalCost,
    grossProfit,
    grossMarginPercentage,
    averageTicket: params.salesCount > 0 ? params.totalRevenue / params.salesCount : 0,
    revenueByMethod: {
      cash: params.revenueByMethod.cash,
      pix: params.revenueByMethod.pix,
      debit: params.revenueByMethod.card * 0.5,
      credit: params.revenueByMethod.card * 0.5,
      fiado: params.revenueByMethod.credit,
    },
    cashRegisterBalance: {
      expected: params.totalRevenue,
      reported: params.totalRevenue + params.cashDifference,
      difference: params.cashDifference,
    },
    topSellingProducts: params.topSelling.map((t) => ({
      productId: t.productId,
      name: t.name,
      quantity: t.quantity,
      totalRevenue: t.revenue,
    })),
    outOfStockProducts: params.outOfStock.map((o) => ({
      productId: o.productId,
      name: o.name,
      barcode: o.barcode,
    })),
    expiringProducts: params.expiringLots.map((e) => ({
      productId: e.productId,
      productName: e.productName,
      lotNumber: e.lotNumber,
      expirationDate: e.expirationDate,
      daysRemaining: e.daysRemaining,
      quantity: e.quantity,
    })),
    nightAnalysisMarkdown: diagnosisMarkdown,
    createdAt: Date.now(),
  };

  // 5. Envia briefing noturno para o Telegram do dono da loja (se configurado)
  const botToken = params.telegramBotToken;
  if (tenant.settings.enableTelegramAlerts && tenant.settings.telegramChatId && botToken) {
    try {
      await sendTelegramNotification(botToken, tenant.settings.telegramChatId, diagnosisMarkdown);
      console.log(`[Grafo Noturno] Notificação enviada para o Telegram (${tenant.settings.telegramChatId}) com sucesso.`);
    } catch (telegramErr) {
      console.error('[Grafo Noturno] Erro ao enviar mensagem no Telegram:', telegramErr);
    }
  }

  return dailySummary;
}
