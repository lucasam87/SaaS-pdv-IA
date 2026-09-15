import { Sale, TenantSettings } from '@pdv/shared';

export interface PrinterReceiptOptions {
  storeName: string;
  storeCnpj?: string;
  settings: TenantSettings;
  cutPaper?: boolean;
  extraFeedLines?: number;
}

export class ThermalPrinterService {
  /**
   * Sanitiza strings removendo bytes de controle não autorizados
   * para prevenir injeção maliciosa de comandos ESC/POS (ex: \x1b, \x1d).
   */
  public static sanitizeText(input: string): string {
    if (!input) return '';
    // Remove caracteres de controle ASCII exceto quebra de linha (\n) e carriage return (\r)
    // eslint-disable-next-line no-control-regex
    return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  }

  /**
   * Gera a representação em texto do comprovante formatado para bobinas térmicas.
   */
  public static formatReceiptText(sale: Sale, options: PrinterReceiptOptions): string {
    const width = options.settings.receiptWidthMm === 58 ? 32 : 48;
    const divider = '-'.repeat(width);
    const doubleDivider = '='.repeat(width);

    const padLine = (left: string, right: string) => {
      const sanitizedLeft = this.sanitizeText(left);
      const sanitizedRight = this.sanitizeText(right);
      const space = width - sanitizedLeft.length - sanitizedRight.length;
      if (space <= 0) return sanitizedLeft + ' ' + sanitizedRight;
      return sanitizedLeft + ' '.repeat(space) + sanitizedRight;
    };

    const center = (text: string) => {
      const sanitized = this.sanitizeText(text);
      const padding = Math.max(0, Math.floor((width - sanitized.length) / 2));
      return ' '.repeat(padding) + sanitized;
    };

    const dateStr = new Date(sale.createdAt).toLocaleString('pt-BR');
    const storeName = this.sanitizeText(options.storeName);
    const storeCnpj = options.storeCnpj ? this.sanitizeText(options.storeCnpj) : undefined;
    const userName = this.sanitizeText(sale.userName);
    const customerName = sale.customerName ? this.sanitizeText(sale.customerName) : undefined;

    const lines: string[] = [
      center(storeName.toUpperCase()),
      storeCnpj ? center(`CNPJ: ${storeCnpj}`) : '',
      center('COMPROVANTE DE VENDA'),
      center('(NAO E DOCUMENTO FISCAL)'),
      doubleDivider,
      padLine(`VENDA: #${sale.saleNumber}`, dateStr),
      padLine(`OPERADOR: ${userName}`, ''),
      customerName ? padLine(`CLIENTE: ${customerName}`, '') : '',
      divider,
      padLine('ITEM / QTD x UNIT', 'TOTAL'),
      divider,
    ];

    sale.items.forEach((item, index) => {
      const prodName = this.sanitizeText(item.productName);
      lines.push(`${index + 1}. ${prodName}`);
      const left = `   ${item.quantity} un x R$ ${item.unitPrice.toFixed(2)}`;
      const right = `R$ ${item.totalPrice.toFixed(2)}`;
      lines.push(padLine(left, right));
    });

    lines.push(divider);
    lines.push(padLine('SUBTOTAL:', `R$ ${sale.subtotal.toFixed(2)}`));
    if (sale.discount > 0) {
      lines.push(padLine('DESCONTO:', `- R$ ${sale.discount.toFixed(2)}`));
    }
    lines.push(padLine('TOTAL A PAGAR:', `R$ ${sale.total.toFixed(2)}`));
    lines.push(divider);

    lines.push('FORMA DE PAGAMENTO:');
    sale.payments.forEach((p) => {
      lines.push(padLine(`  ${p.method}:`, `R$ ${p.amount.toFixed(2)}`));
      if (p.changeAmount && p.changeAmount > 0) {
        lines.push(padLine('  TROCO:', `R$ ${p.changeAmount.toFixed(2)}`));
      }
    });

    lines.push(doubleDivider);
    if (options.settings.receiptFooter) {
      const footerLines = options.settings.receiptFooter.split('\n');
      for (const fl of footerLines) {
        lines.push(center(this.sanitizeText(fl)));
      }
    } else {
      lines.push(center('OBRIGADO PELA PREFERENCIA!'));
      lines.push(center('VOLTE SEMPRE!'));
    }

    const extraFeed = options.extraFeedLines ?? (options.cutPaper === false ? 6 : 3);
    lines.push('\n'.repeat(extraFeed));

    return lines.filter((l) => l !== undefined && l !== null).join('\n');
  }

  /**
   * Converte a string formatada em bytes ESC/POS com comando de corte opcional.
   */
  public static toEscPosBytes(text: string, options?: { cutPaper?: boolean }): Uint8Array {
    const encoder = new TextEncoder();
    const sanitizedText = this.sanitizeText(text);
    const textBytes = encoder.encode(sanitizedText);

    // ESC @ (Inicializa impressora)
    const initCmd = new Uint8Array([0x1b, 0x40]);
    const shouldCut = options?.cutPaper ?? true;
    // GS V 66 0 (Corte de papel total)
    const cutCmd = shouldCut ? new Uint8Array([0x1d, 0x56, 0x42, 0x00]) : new Uint8Array(0);

    const combined = new Uint8Array(initCmd.length + textBytes.length + cutCmd.length);
    combined.set(initCmd, 0);
    combined.set(textBytes, initCmd.length);
    if (shouldCut) {
      combined.set(cutCmd, initCmd.length + textBytes.length);
    }

    return combined;
  }

  /**
   * Dispara a impressão na impressora térmica USB.
   */
  public static async printSaleReceipt(sale: Sale, options: PrinterReceiptOptions): Promise<void> {
    const receipt = this.formatReceiptText(sale, options);
    const escBytes = this.toEscPosBytes(receipt, { cutPaper: options.cutPaper });

    // Verifica se está rodando dentro do Tauri com suporte USB
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof window !== 'undefined' && (window as any).__TAURI__) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { invoke } = (window as any).__TAURI__.core;
        await invoke('print_raw_usb', { data: Array.from(escBytes) });
        console.log('[Printer] Cupom enviado com sucesso para a porta USB da impressora!');
        return;
      } catch (err) {
        console.error('[Printer] Falha no envio USB direto do Tauri:', err);
        throw new Error(`Falha ao comunicar com a impressora USB: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Ambiente de desenvolvimento ou teste: simulação transparente
    console.log('[Simulação de Impressão Térmica ESC/POS]:\n' + receipt);
  }
}
