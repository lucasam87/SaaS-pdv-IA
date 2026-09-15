import { DailySummary, Tenant } from '@pdv/shared';
import { generateNightDiagnosisWithGemini, StoreAuditContext } from './gemini-synthesizer';
import { sendTelegramNotification } from './telegram-notifier';

export interface ExecuteNightGraphParams {
  tenant: Tenant;
  geminiApiKey: string;
  dateStr: string;
  salesCount: number;
  totalRevenue: number;
  revenueByMethod: {
    cash: number;
    pix: number;
    card: number;
    credit: number;
  };
  cashDifference: number;
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
    topSelling: params.topSelling,
    outOfStock: params.outOfStock,
    expiringLots: params.expiringLots,
    upcomingBills: params.upcomingBills,
  };

  // 2. Chama o Gemini 1.5 Flash para gerar a síntese executiva
  const diagnosisMarkdown = await generateNightDiagnosisWithGemini(geminiApiKey, context);

  // 3. Monta o objeto oficial de Resumo Diário
  const dailySummary: DailySummary = {
    id: dateStr,
    tenantId: tenant.id,
    date: dateStr,
    totalSalesCount: params.salesCount,
    totalRevenue: params.totalRevenue,
    totalCost: 0,
    grossProfit: params.totalRevenue * 0.35, // Estimativa de margem
    grossMarginPercentage: 35.0,
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
    expiringProducts: params.expiringLots,
    nightAnalysisMarkdown: diagnosisMarkdown,
    createdAt: Date.now(),
  };

  // 4. Se o lojista configurou o Telegram, despacha a notificação
  if (
    tenant.settings.enableTelegramAlerts &&
    tenant.settings.telegramBotToken &&
    tenant.settings.telegramChatId
  ) {
    console.log(`[Grafo Noturno] Enviando resumo para o Telegram Chat: ${tenant.settings.telegramChatId}`);
    const sent = await sendTelegramNotification(
      tenant.settings.telegramBotToken,
      tenant.settings.telegramChatId,
      diagnosisMarkdown
    );
    if (sent) {
      dailySummary.telegramSentAt = Date.now();
    }
  }

  console.log(`[Grafo Noturno] Auditoria concluída com sucesso!`);
  return dailySummary;
}
