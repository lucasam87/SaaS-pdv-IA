import React from 'react';

interface ShortcutsBarProps {
  onNewSale: () => void;
  onOpenCashModal: () => void;
  onFinalize: () => void;
  onCancelSale: () => void;
}

export const ShortcutsBar: React.FC<ShortcutsBarProps> = ({
  onNewSale,
  onOpenCashModal,
  onFinalize,
  onCancelSale,
}) => {
  return (
    <footer className="bg-slate-900 border-t border-slate-800 px-6 py-2 flex items-center justify-between text-xs select-none">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onNewSale}
          className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700/80 transition-colors"
        >
          <span className="bg-slate-900 text-emerald-400 font-mono font-bold px-1.5 py-0.5 rounded text-[11px]">
            F2
          </span>
          <span>Nova Venda</span>
        </button>

        <button
          onClick={onOpenCashModal}
          className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700/80 transition-colors"
        >
          <span className="bg-slate-900 text-amber-400 font-mono font-bold px-1.5 py-0.5 rounded text-[11px]">
            F8
          </span>
          <span>Caixa / Fechamento</span>
        </button>

        <button
          onClick={onCancelSale}
          className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 px-2.5 py-1 rounded-lg border border-slate-700/80 transition-colors"
        >
          <span className="bg-slate-900 text-rose-400 font-mono font-bold px-1.5 py-0.5 rounded text-[11px]">
            ESC
          </span>
          <span>Cancelar Venda</span>
        </button>
      </div>

      <div>
        <button
          onClick={onFinalize}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-1.5 rounded-lg shadow-md shadow-emerald-600/20 transition-all text-xs"
        >
          <span className="bg-emerald-950 text-emerald-300 font-mono px-1.5 py-0.5 rounded text-[11px]">
            F10
          </span>
          <span>Finalizar Venda</span>
        </button>
      </div>
    </footer>
  );
};
