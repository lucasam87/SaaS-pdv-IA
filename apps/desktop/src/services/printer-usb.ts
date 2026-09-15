import { Sale, TenantSettings } from '@pdv/shared';

export interface PrinterReceiptOptions {
  storeName: string;
  storeCnpj?: string;
  settings: TenantSettings;
}

export class ThermalPrinterService {
  /**
   * Gera a representação em texto do comprovante formatado para bobinas térmicas.
   */
  public static formatReceiptText(sale: Sale, options: PrinterReceiptOptions): string {
    const width = options.settings.receiptWidthMm === 58 ? 32 : 48;
    const divider = '-'.repeat(width);
    const doubleDivider = '='.repeat(width);

    const padLine = (left: string, right: string) => {
      const space = width - left.length - right.length;
      if (space <= 0) return left + ' ' + right;
      return left + ' '.repeat(space) + right;
    };

    const center = (text: string) => {
      const padding = Math.max(0, Math.floor((width - text.length) / 2));
      return ' '.repeat(padding) + text;
    };

    const dateStr = new Date(sale.createdAt).toLocaleString('pt-BR');

    const lines: string[] = [
      center(options.storeName.toUpperCase()),
      options.storeCnpj ? center(`CNPJ: ${options.storeCnpj}`) : '',
      center('COMPROVANTE DE VENDA'),
      center('(NAO E DOCUMENTO FISCAL)'),
      doubleDivider,
      padLine(`VENDA: #${sale.saleNumber}`, dateStr),
      padLine(`OPERADOR: ${sale.userName}`, ''),
      sale.customerName ? padLine(`CLIENTE: ${sale.customerName}`, '') : '',
      divider,
      padLine('ITEM / QTD x UNIT', 'TOTAL'),
      divider,
    ];

    sale.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.productName}`);
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
      lines.push(center(options.settings.receiptFooter));
    } else {
      lines.push(center('OBRIGADO PELA PREFERENCIA!'));
      lines.push(center('VOLTE SEMPRE!'));
    }
    lines.push('\n\n\n'); // Avanço de papel

    return lines.filter(Boolean).join('\n');
  }

  /**
   * Converte a string formatada em bytes ESC/POS com corte automático.
   */
  public static toEscPosBytes(text: string): Uint8Array {
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);

    // ESC @ (Inicializa impressora), GS V 66 0 (Corte total)
    const initCmd = new Uint8Array([0x1b, 0x40]);
    const cutCmd = new Uint8Array([0x1d, 0x56, 0x42, 0x00]);

    const combined = new Uint8Array(initCmd.length + textBytes.length + cutCmd.length);
    combined.set(initCmd, 0);
    combined.set(textBytes, initCmd.length);
    combined.set(cutCmd, initCmd.length + textBytes.length);

    return combined;
  }

  /**
   * Dispara a impressão na impressora térmica USB.
   */
  public static async printSaleReceipt(sale: Sale, options: PrinterReceiptOptions): Promise<void> {
    const receipt = this.formatReceiptText(sale, options);

    // Verifica se está rodando dentro do Tauri
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof window !== 'undefined' && (window as any).__TAURI__) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { invoke } = (window as any).__TAURI__.core;
        await invoke('print_raw_usb', { data: Array.from(this.toEscPosBytes(receipt)) });
        console.log('[Printer] Cupom enviado com sucesso para a porta USB da impressora!');
        return;
      } catch (err) {
        console.warn('[Printer] Falha no envio USB direto do Tauri, fallback visual ativado:', err);
      }
    }

    // Fallback amigável de desenvolvimento (console e simulação)
    console.log('[Simulação de Impressão Térmica ESC/POS]:\n' + receipt);
  }
}
