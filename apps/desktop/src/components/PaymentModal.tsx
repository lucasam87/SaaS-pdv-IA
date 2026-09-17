import React, { useState, useEffect, useRef } from 'react';
import { Banknote, QrCode, CreditCard, BookOpen, X, Printer, Loader2 } from 'lucide-react';
import { PaymentMethod, SalePayment } from '@pdv/shared';

interface PaymentModalProps {
  total: number;
  onConfirmPayment: (payments: SalePayment[], customerName?: string) => Promise<void> | void;
  onClose: () => void;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({ total, onConfirmPayment, onClose }) => {
  const [method, setMethod] = useState<PaymentMethod>('DINHEIRO');
  const [cashAmountReceived, setCashAmountReceived] = useState<string>(total.toFixed(2));
  const [customerName, setCustomerName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cashInputRef = useRef<HTMLInputElement>(null);

  const numReceived = parseFloat(cashAmountReceived.replace(',', '.')) || 0;
  const change = Math.max(0, numReceived - total);
  const isValidToFinalize = method === 'DINHEIRO' ? numReceived >= total : true;

  useEffect(() => {
    if (cashInputRef.current && method === 'DINHEIRO') {
      cashInputRef.current.focus();
      cashInputRef.current.select();
    }
  }, [method]);

  const handleFinalize = async () => {
    if (!isValidToFinalize || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const payment: SalePayment = {
        method,
        amount: method === 'DINHEIRO' ? numReceived : total,
        changeAmount: method === 'DINHEIRO' ? change : 0,
      };
      await onConfirmPayment([payment], customerName.trim() || undefined);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Atalhos de teclado inteligentes (suprimidos durante digitação de textos/números)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || (target as any).isContentEditable);

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      // Se o usuário estiver focado em um input de texto/número
      if (isInputFocused) {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleFinalize();
        }
        return; // Não processa atalhos 1 a 5 para não sobrescrever números digitados
      }

      // Atalhos quando fora de inputs
      if (e.key === '1') {
        setMethod('DINHEIRO');
      } else if (e.key === '2') {
        setMethod('PIX');
      } else if (e.key === '3') {
        setMethod('DEBITO');
      } else if (e.key === '4') {
        setMethod('CREDITO');
      } else if (e.key === '5') {
        setMethod('FIADO');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleFinalize();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isValidToFinalize, isSubmitting, method, numReceived, customerName]);

  const setExactAmount = () => setCashAmountReceived(total.toFixed(2));
  const addCash = (amount: number) => {
    const current = parseFloat(cashAmountReceived.replace(',', '.')) || 0;
    setCashAmountReceived((current + amount).toFixed(2));
  };

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border-2 border-slate-700 w-full max-w-xl rounded-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Topo do Modal */}
        <div className="bg-slate-800/90 px-6 py-4 border-b border-slate-700/80 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-100">Finalizar Venda</h2>
            <p className="text-xs text-slate-400">Selecione o meio de pagamento e confirme</p>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="p-1.5 rounded-lg bg-slate-700/50 hover:bg-slate-700 text-slate-400 hover:text-slate-100 transition-colors disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Total Gigante em Destaque */}
          <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 text-center">
            <div className="text-xs uppercase font-semibold text-slate-400">Total a Receber</div>
            <div className="text-4xl font-black font-mono text-emerald-400 mt-1">
              R$ {total.toFixed(2)}
            </div>
          </div>

          {/* Seleção de Formas de Pagamento (Atalhos 1 a 5) */}
          <div className="grid grid-cols-5 gap-2">
            {[
              { id: 'DINHEIRO', label: 'Dinheiro', key: '1', icon: Banknote },
              { id: 'PIX', label: 'PIX', key: '2', icon: QrCode },
              { id: 'DEBITO', label: 'Débito', key: '3', icon: CreditCard },
              { id: 'CREDITO', label: 'Crédito', key: '4', icon: CreditCard },
              { id: 'FIADO', label: 'Fiado', key: '5', icon: BookOpen },
            ].map((p) => {
              const Icon = p.icon;
              const isSelected = method === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setMethod(p.id as PaymentMethod)}
                  disabled={isSubmitting}
                  className={`flex flex-col items-center justify-center p-3 rounded-2xl border-2 transition-all relative ${
                    isSelected
                      ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300 shadow-lg shadow-emerald-500/10'
                      : 'bg-slate-800/60 border-slate-700 hover:bg-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <span className="absolute top-1.5 right-2 text-[10px] font-mono text-slate-500 font-bold">
                    [{p.key}]
                  </span>
                  <Icon className="w-6 h-6 mb-1.5" />
                  <span className="text-xs font-bold">{p.label}</span>
                </button>
              );
            })}
          </div>

          {/* Área de Cálculo de Troco (apenas se for DINHEIRO) */}
          {method === 'DINHEIRO' && (
            <div className="bg-slate-950/80 p-5 rounded-2xl border border-slate-800 space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 block mb-1.5">
                  Valor Entregue pelo Cliente:
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-4 font-mono font-bold text-slate-400">R$</span>
                  <input
                    ref={cashInputRef}
                    type="text"
                    value={cashAmountReceived}
                    onChange={(e) => setCashAmountReceived(e.target.value)}
                    disabled={isSubmitting}
                    className="w-full bg-slate-900 border-2 border-slate-700 text-2xl font-mono font-bold text-slate-100 pl-12 pr-4 py-2.5 rounded-xl focus:border-emerald-500 outline-none"
                  />
                </div>
              </div>

              {/* Botões Rápidos de Cédulas */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={setExactAmount}
                  disabled={isSubmitting}
                  className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold border border-slate-700"
                >
                  Exato
                </button>
                {[10, 20, 50, 100].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => addCash(val)}
                    disabled={isSubmitting}
                    className="flex-1 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-mono font-semibold border border-slate-700"
                  >
                    +{val}
                  </button>
                ))}
              </div>

              {/* Exibição do Troco */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                <span className="text-sm font-semibold text-slate-400">Troco a Devolver:</span>
                <span
                  className={`text-2xl font-mono font-black ${
                    numReceived < total ? 'text-rose-400' : 'text-emerald-400'
                  }`}
                >
                  R$ {change.toFixed(2)}
                </span>
              </div>
            </div>
          )}

          {/* Nome do Cliente (Opcional ou obrigatório se for Fiado) */}
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1">
              Nome do Cliente {method === 'FIADO' ? '(Obrigatório para Caderninho)' : '(Opcional)'}:
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Ex: João da Silva"
              disabled={isSubmitting}
              className="w-full bg-slate-950 border border-slate-700 text-sm text-slate-200 px-3.5 py-2 rounded-xl focus:border-emerald-500 outline-none"
            />
          </div>

          {/* Botões de Ação */}
          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-2xl border border-slate-700 transition-all text-sm disabled:opacity-50"
            >
              Voltar [Esc]
            </button>
            <button
              type="button"
              onClick={handleFinalize}
              disabled={!isValidToFinalize || (method === 'FIADO' && !customerName.trim()) || isSubmitting}
              className={`flex-2 py-3 px-6 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all text-sm ${
                isValidToFinalize && (method !== 'FIADO' || customerName.trim()) && !isSubmitting
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/20 active:scale-[0.98]'
                  : 'bg-slate-800 text-slate-600 border border-slate-800 cursor-not-allowed'
              }`}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Processando Venda...</span>
                </>
              ) : (
                <>
                  <Printer className="w-5 h-5" />
                  <span>Confirmar e Imprimir [Enter]</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
