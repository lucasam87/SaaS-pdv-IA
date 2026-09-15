export interface DeviceCashSessionSummary {
  deviceId: string;
  deviceName: string;
  terminalNumber: number;
  openedByName: string;
  totalSales: number;
  cashDifference: number;
  status: string;
}

export interface StockConflictItem {
  productName: string;
  barcode: string;
  negativeBalance: number;
  deviceIds: string[];
}

export interface StoreAuditContext {
  storeName: string;
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
  deviceSessions?: DeviceCashSessionSummary[];
  stockConflicts?: StockConflictItem[];
  topSelling: Array<{ name: string; quantity: number; revenue: number }>;
  outOfStock: Array<{ name: string }>;
  expiringLots: Array<{ productName: string; daysRemaining: number; quantity: number }>;
  upcomingBills: Array<{ description: string; amount: number }>;
}

/**
 * Síntese da IA Gerente usando Gemini 1.5 Flash.
 * Transforma números matemáticos exatos em um resumo executivo acionável para o lojista.
 */
export async function generateNightDiagnosisWithGemini(
  apiKey: string,
  context: StoreAuditContext
): Promise<string> {
  const prompt = `
Você é o "Gerente Inteligente" da loja "${context.storeName}". 
O caixa acabou de ser fechado na data de ${context.dateStr}.
Sua missão é analisar os números matemáticos consolidados abaixo e redigir um briefing executivo, amigável e direto ao ponto para o dono da loja ler no celular (Telegram).

DADOS CONSOLIDADOS DO DIA:
- Faturamento Total: R$ ${context.totalRevenue.toFixed(2)} (${context.salesCount} vendas)
- Formas de Pagamento:
  * Dinheiro: R$ ${context.revenueByMethod.cash.toFixed(2)}
  * PIX: R$ ${context.revenueByMethod.pix.toFixed(2)}
  * Cartão (Débito/Crédito): R$ ${context.revenueByMethod.card.toFixed(2)}
  * Fiado/Caderninho: R$ ${context.revenueByMethod.credit.toFixed(2)}
- Auditoria Consolidada de Gavetas: ${
    context.cashDifference === 0
      ? '100% CORRETO (Sem diferença de caixa)'
      : context.cashDifference > 0
      ? `SOBRA de R$ ${context.cashDifference.toFixed(2)}`
      : `FALTA de R$ ${Math.abs(context.cashDifference).toFixed(2)}`
  }
${
  context.deviceSessions && context.deviceSessions.length > 0
    ? `- Detalhamento por Terminal:\n${context.deviceSessions
        .map(
          (d) =>
            `  * [${d.deviceName || d.deviceId}]: R$ ${d.totalSales.toFixed(2)} em vendas | Diferença de gaveta: ${
              d.cashDifference === 0
                ? 'Correto (R$ 0,00)'
                : d.cashDifference > 0
                ? `+R$ ${d.cashDifference.toFixed(2)} (Sobra)`
                : `-R$ ${Math.abs(d.cashDifference).toFixed(2)} (Falta)`
            } (Operador: ${d.openedByName})`
        )
        .join('\n')}`
    : ''
}
${
  context.stockConflicts && context.stockConflicts.length > 0
    ? `- ⚠️ Conflitos Operacionais de Estoque Offline (vendas simultâneas permitidas):\n${context.stockConflicts
        .map(
          (c) =>
            `  * ${c.productName} (EAN: ${c.barcode}): Saldo atual ficou em ${c.negativeBalance} un devido a vendas offline nos terminais [${c.deviceIds.join(', ')}]`
        )
        .join('\n')}`
    : ''
}
- Produtos Mais Vendidos: ${context.topSelling.map((p) => `${p.name} (${p.quantity} un)`).join(', ') || 'Nenhum'}
- Produtos que ACABARAM (Estoque Zero): ${context.outOfStock.map((p) => p.name).join(', ') || 'Nenhum'}
- Produtos Perto de Vencer (Próximos 30-60 dias): ${
    context.expiringLots.map((l) => `${l.productName} (${l.quantity} un vencem em ${l.daysRemaining} dias)`).join(', ') || 'Nenhum'
  }
- Boletos que vencem amanhã/próximos dias: ${
    context.upcomingBills.map((b) => `${b.description}: R$ ${b.amount.toFixed(2)}`).join(', ') || 'Nenhum'
  }

INSTRUÇÕES DE RESPOSTA:
1. Comece com uma saudação calorosa de fechamento do dia.
2. Destaque o faturamento total da loja e o detalhamento por caixa/terminal (mostrando como foi cada gaveta).
3. Se houver divergência de gaveta (falta ou sobra) em algum terminal, aponte com clareza e respeito qual terminal teve a diferença.
4. Se houver conflitos operacionais de estoque (saldo negativo por venda offline simultânea), avise como ocorrência operacional para conferência de prateleira, sem pânico.
5. Indique o que comprar amanhã com base nos itens que acabaram.
6. Se houver itens perto de vencer, dê uma sugestão prática de desconto no balcão para evitar prejuízo.
7. Use emojis moderados e formatação elegante em Markdown do Telegram (use *negrito* e listas).
8. Seja direto, fale como um consultor de varejo parceiro do comerciante.
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1000,
        },
      }),
    });

    const result = await response.json();
    if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
      return result.candidates[0].content.parts[0].text;
    }

    throw new Error('Formato de resposta inesperado do Gemini API');
  } catch (err) {
    console.error('[Gemini] Erro ao sintetizar análise noturna:', err);
    // Fallback determinístico caso a API falhe ou não tenha chave configurada
    return `
🏪 *FECHAMENTO DO DIA — ${context.storeName}* (${context.dateStr})

💰 *COMO FOI O DIA:*
• Faturamento: R$ ${context.totalRevenue.toFixed(2)} (${context.salesCount} vendas)
• PIX: R$ ${context.revenueByMethod.pix.toFixed(2)} | Cartão: R$ ${context.revenueByMethod.card.toFixed(2)} | Dinheiro: R$ ${context.revenueByMethod.cash.toFixed(2)}
• Gaveta: ${context.cashDifference === 0 ? 'Fechou 100% correto!' : `Diferença de R$ ${context.cashDifference.toFixed(2)}`}

📦 *ESTOQUE E COMPRAS:*
• Itens que esgotaram: ${context.outOfStock.map((p) => p.name).join(', ') || 'Nenhum'}
• Itens perto de vencer: ${context.expiringLots.map((l) => l.productName).join(', ') || 'Nenhum'}

Tenha um ótimo descanso!
`.trim();
  }
}
