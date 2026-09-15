import { ExtractedProductDraft, ImportPreviewResult } from '@pdv/shared';

/**
 * Importador de Estoque a partir de PDF do Sistema Antigo com Gemini 1.5 Flash Vision.
 */
export async function extractProductsFromPdfWithGemini(
  pdfBase64: string,
  fileName: string,
  geminiApiKey: string
): Promise<ImportPreviewResult> {
  const prompt = `
Você é um especialista em extração e migração de dados de varejo.
Analise este documento PDF de relatório de estoque/inventário de um sistema antigo.
Extraia TODOS os produtos da tabela e retorne EXCLUSIVAMENTE um array JSON puro (sem marcação de bloco de código markdown) com o seguinte formato para cada produto:

[
  {
    "barcode": "código de barras ou código interno",
    "name": "nome completo do produto",
    "currentStock": número (quantidade em estoque),
    "costPrice": número (preço de custo, se houver, senão 0.0),
    "sellingPrice": número (preço de venda ao consumidor),
    "unit": "UN" ou "KG" ou "CX",
    "category": "categoria se identificável"
  }
]

REGRAS RÍGIDAS:
- Extraia cada linha de produto fielmente.
- Converta vírgulas decimais para ponto (ex: "18,90" -> 18.90).
- Não invente códigos; se não houver código de barras, coloque uma string vazia "".
- Retorne apenas o JSON puro para que possamos fazer JSON.parse() diretamente.
`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: pdfBase64,
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });

    const result = await response.json();
    let rawText = result.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    rawText = rawText.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed: any[] = JSON.parse(rawText);

    let validCount = 0;
    let warningCount = 0;

    const items: ExtractedProductDraft[] = parsed.map((item) => {
      const warnings: string[] = [];
      const currentStock = Number(item.currentStock) || 0;
      const costPrice = Number(item.costPrice) || 0;
      const sellingPrice = Number(item.sellingPrice) || 0;

      if (!item.name || item.name.trim().length < 2) {
        warnings.push('Nome do produto em branco ou inválido');
      }
      if (sellingPrice <= 0) {
        warnings.push('Preço de venda zerado');
      }
      if (!item.barcode) {
        warnings.push('Sem código de barras');
      }

      const isValid = warnings.length === 0;
      if (isValid) validCount++;
      else warningCount++;

      return {
        barcode: item.barcode ? String(item.barcode).trim() : undefined,
        name: String(item.name || 'Produto Sem Nome').trim(),
        currentStock,
        costPrice,
        sellingPrice,
        unit: ['UN', 'KG', 'CX', 'PCT', 'L', 'M'].includes(item.unit) ? item.unit : 'UN',
        category: item.category || 'Geral',
        isValid,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    });

    return {
      jobId: `job_${Date.now()}`,
      sourceType: 'PDF',
      fileName,
      totalFound: items.length,
      validCount,
      warningCount,
      items,
      createdAt: Date.now(),
    };
  } catch (err) {
    console.error('[PDF Importer] Erro na extração com Gemini:', err);
    throw new Error('Falha ao processar e ler o arquivo PDF com a IA Gemini.');
  }
}
