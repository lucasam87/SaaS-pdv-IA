import React, { useState, useEffect, useRef } from 'react';
import { Banknote, QrCode, CreditCard, BookOpen, Check, X, Printer } from 'lucide-react';
import { PaymentMethod, SalePayment } from '@pdv/shared';

interface PaymentModalProps {
  total: number;
  onConfirmPayment: (payments: SalePayment[], customerName?: string) => void;
  onClose: () => void;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({ total, onConfirmPayment, onClose }) => {
  const [method, setMethod] = useState<PaymentMethod>('DINHEIRO');
  const [cashAmountReceived, setCashAmountReceived] = useState<string>(total.toFixed(2));
  const [customerName, setCustomerName] = useState('');
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

  // Atalhos de teclado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === '1') {
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
        if (isValidToFinalize) {
          handleFinalize();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isValidToFinalize, method, numReceived, customerName]);

  const handleFinalize = () => {
    const payment: SalePayment = {
      method,
      amount: total,
      changeAmount: method === 'DINHEIRO' ? change : 0,
    };
    onConfirmPayment([payment], customerName.trim() || undefined);
  };

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
            className="p-1.5 rounded-lg bg-slate-700/50 hover:bg-slate-700 text-slate-400 hover:text-slate-100 transition-colors"
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
            ].map((opt) => {
              const Icon = opt.icon;
              const isSelected = method === opt.id;
              return (
                <button
                  key={opt.id}
                  onClick={() => setMethod(opt.id as PaymentMethod)}
                  className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all ${
                    isSelected
                      ? 'bg-emerald-600 border-emerald-400 text-white shadow-lg shadow-emerald-600/30'
                      : 'bg-slate-800/80 border-slate-700 text-slate-300 hover:bg-slate-700/50'
                  }`}
                >
                  <div className="text-[10px] font-mono opacity-60 font-bold mb-1">[{opt.key}]</div>
                  <Icon className="w-5 h-5 mb-1" />
                  <span className="text-xs font-bold">{opt.label}</span>
                </button>
              );
            })}
          </div>

          {/* Painel Específico: Dinheiro e Troco */}
          {method === 'DINHEIRO' && (
            <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80 space-y-4">
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
                    className="w-full bg-slate-900 border-2 border-slate-700 text-2xl font-mono font-black text-slate-100 pl-12 pr-4 py-2.5 rounded-xl focus:border-emerald-500 outline-none"
                  />
                </div>
              </div>

              {/* Botões de Cédulas Rápidas */}
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={setExactAmount}
                  className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg border border-slate-700"
                >
                  Exato
                </button>
                {[10, 20, 50, 100].map((val) => (
                  <button
                    key={val}
                    onClick={() => addCash(val)}
                    className="px-2.5 py-1 bg-slate-800/80 hover:bg-slate-700 text-emerald-300 text-xs font-mono font-bold rounded-lg border border-slate-700"
                  >
                    +{val}
                  </button>
                ))}
              </div>

              {/* Destaque do Troco */}
              <div className="bg-slate-900/90 p-3 rounded-xl border border-slate-800 flex justify-between items-center">
                <span className="text-xs font-bold text-slate-400 uppercase">Troco do Cliente:</span>
                <span
                  className={`text-2xl font-mono font-black ${
                    numReceived < total ? 'text-rose-400' : 'text-amber-300'
                  }`}
                >
                  {numReceived < total ? 'Valor insuficiente' : `R$ ${change.toFixed(2)}`}
                </span>
              </div>
            </div>
          )}

          {/* Painel Específico: PIX */}
          {method === 'PIX' && (
            <div className="bg-slate-950/60 p-6 rounded-2xl border border-slate-800/80 text-center space-y-3">
              <div className="w-24 h-24 mx-auto bg-white p-2 rounded-xl flex items-center justify-center shadow-inner">
                <QrCode className="w-20 h-20 text-slate-950" />
              </div>
              <div className="text-xs text-slate-300 font-medium">
                QR Code Dinâmico gerado no valor de <strong className="text-emerald-400">R$ {total.toFixed(2)}</strong>
              </div>
              <p className="text-[11px] text-slate-500">Aguardando confirmação do cliente ou tecle ENTER para confirmar</p>
            </div>
          )}

          {/* Painel Específico: Fiado */}
          {method === 'FIADO' && (
            <div className="bg-slate-950/60 p-4 rounded-2xl border border-slate-800/80 space-y-3">
              <label className="text-xs font-semibold text-slate-400 block">
                Nome ou Apelido do Cliente (Caderninho):
              </label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Ex: Seu Zé da Padaria"
                className="w-full bg-slate-900 border-2 border-slate-700 text-sm font-semibold text-slate-100 px-4 py-2.5 rounded-xl focus:border-emerald-500 outline-none"
              />
            </div>
          )}

          {/* Botões de Ação Final */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl border border-slate-700 text-sm transition-all"
            >
              [ESC] Voltar
            </button>
            <button
              onClick={handleFinalize}
              disabled={!isValidToFinalize}
              className={`flex-1 py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-lg ${
                isValidToFinalize
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30'
                  : 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
              }`}
            >
              <Check className="w-4 h-4" />
              <Printer className="w-4 h-4" />
              [ENTER] Concluir & Imprimir
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
