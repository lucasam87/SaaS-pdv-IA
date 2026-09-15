import React, { useState } from 'react';
import { Lock, Unlock, X } from 'lucide-react';
import { CashSession } from '@pdv/shared';

interface CashSessionModalProps {
  currentSession: CashSession | null;
  onOpenSession: (initialAmount: number) => void;
  onCloseSession: (finalReported: number, notes?: string) => void;
  onSangria: (amount: number, reason: string) => void;
  onSuprimento: (amount: number, reason: string) => void;
  onClose: () => void;
}

export const CashSessionModal: React.FC<CashSessionModalProps> = ({
  currentSession,
  onOpenSession,
  onCloseSession,
  onSangria,
  onSuprimento,
  onClose,
}) => {
  const [mode, setMode] = useState<'AUTO' | 'SANGRIA' | 'SUPRIMENTO'>(
    currentSession?.status === 'OPEN' ? 'AUTO' : 'AUTO'
  );
  const [amountStr, setAmountStr] = useState('');
  const [reasonStr, setReasonStr] = useState('');

  const numAmount = parseFloat(amountStr.replace(',', '.')) || 0;

  const handleAction = () => {
    if (currentSession?.status !== 'OPEN') {
      // Abrindo o Caixa
      onOpenSession(numAmount);
      onClose();
    } else if (mode === 'SANGRIA') {
      if (numAmount <= 0 || !reasonStr.trim()) return;
      onSangria(numAmount, reasonStr.trim());
      onClose();
    } else if (mode === 'SUPRIMENTO') {
      if (numAmount <= 0 || !reasonStr.trim()) return;
      onSuprimento(numAmount, reasonStr.trim());
      onClose();
    } else {
      // Fechando o Caixa
      onCloseSession(numAmount, reasonStr.trim() || undefined);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border-2 border-slate-700 w-full max-w-md rounded-3xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-150">
        {/* Topo do Modal */}
        <div className="bg-slate-800/90 px-6 py-4 border-b border-slate-700/80 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {currentSession?.status === 'OPEN' ? (
              <Lock className="w-5 h-5 text-amber-400" />
            ) : (
              <Unlock className="w-5 h-5 text-emerald-400" />
            )}
            <h2 className="text-base font-bold text-slate-100">
              {currentSession?.status === 'OPEN' ? 'Gestão da Sessão de Caixa' : 'Abertura de Caixa'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg bg-slate-700/50 hover:bg-slate-700 text-slate-400 hover:text-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Seletor de Ação quando o caixa já está aberto */}
          {currentSession?.status === 'OPEN' && (
            <div className="grid grid-cols-3 gap-1.5 p-1 bg-slate-950 rounded-xl border border-slate-800">
              <button
                onClick={() => setMode('AUTO')}
                className={`py-2 text-xs font-bold rounded-lg transition-all ${
                  mode === 'AUTO' ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Fechar Caixa
              </button>
              <button
                onClick={() => setMode('SANGRIA')}
                className={`py-2 text-xs font-bold rounded-lg transition-all ${
                  mode === 'SANGRIA' ? 'bg-rose-900/60 text-rose-200 border border-rose-700/60' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Sangria
              </button>
              <button
                onClick={() => setMode('SUPRIMENTO')}
                className={`py-2 text-xs font-bold rounded-lg transition-all ${
                  mode === 'SUPRIMENTO' ? 'bg-emerald-900/60 text-emerald-200 border border-emerald-700/60' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Suprimento
              </button>
            </div>
          )}

          {/* Campo de Valor */}
          <div>
            <label className="text-xs font-semibold text-slate-400 block mb-1.5">
              {currentSession?.status !== 'OPEN'
                ? 'Fundo de Troco Inicial (R$):'
                : mode === 'SANGRIA'
                ? 'Valor a Retirar da Gaveta (R$):'
                : mode === 'SUPRIMENTO'
                ? 'Valor a Adicionar ao Troco (R$):'
                : 'Valor Contado na Gaveta (Fechamento Cego):'}
            </label>
            <div className="relative flex items-center">
              <span className="absolute left-4 font-mono font-bold text-slate-400">R$</span>
              <input
                type="text"
                autoFocus
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder="0,00"
                className="w-full bg-slate-950 border-2 border-slate-700 text-2xl font-mono font-bold text-slate-100 pl-12 pr-4 py-2.5 rounded-xl focus:border-emerald-500 outline-none"
              />
            </div>
          </div>

          {/* Campo de Motivo (para sangria/suprimento ou observações) */}
          {(mode === 'SANGRIA' || mode === 'SUPRIMENTO' || currentSession?.status === 'OPEN') && (
            <div>
              <label className="text-xs font-semibold text-slate-400 block mb-1">
                {mode === 'SANGRIA' || mode === 'SUPRIMENTO' ? 'Motivo (Obrigatório):' : 'Observações:'}
              </label>
              <input
                type="text"
                value={reasonStr}
                onChange={(e) => setReasonStr(e.target.value)}
                placeholder={
                  mode === 'SANGRIA'
                    ? 'Ex: Pagamento entregador de pão'
                    : mode === 'SUPRIMENTO'
                    ? 'Ex: Troco de moedas do banco'
                    : 'Ex: Tudo conferido'
                }
                className="w-full bg-slate-950 border border-slate-700 text-sm text-slate-200 px-3.5 py-2 rounded-xl focus:border-emerald-500 outline-none"
              />
            </div>
          )}

          {/* Botões */}
          <div className="flex gap-3 pt-2">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl border border-slate-700 text-xs transition-all"
            >
              Cancelar
            </button>
            <button
              onClick={handleAction}
              className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-600/30 transition-all"
            >
              {currentSession?.status !== 'OPEN'
                ? 'Abrir Caixa'
                : mode === 'SANGRIA'
                ? 'Confirmar Sangria'
                : mode === 'SUPRIMENTO'
                ? 'Confirmar Suprimento'
                : 'Concluir Fechamento'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
