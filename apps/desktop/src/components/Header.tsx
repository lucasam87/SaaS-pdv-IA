import React from 'react';
import { Store, User, Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { CashSession } from '@pdv/shared';

interface HeaderProps {
  storeName: string;
  currentUser: { name: string; role: string };
  currentSession: CashSession | null;
  isOnline: boolean;
  pendingSyncCount: number;
  onSyncNow: () => void;
  onOpenCashModal: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  storeName,
  currentUser,
  currentSession,
  isOnline,
  pendingSyncCount,
  onSyncNow,
  onOpenCashModal,
}) => {
  return (
    <header className="bg-slate-900 border-b border-slate-800 px-6 py-3 flex items-center justify-between shadow-md select-none">
      {/* Identificação da Loja */}
      <div className="flex items-center gap-3">
        <div className="bg-emerald-600/20 p-2 rounded-lg border border-emerald-500/30 text-emerald-400">
          <Store className="w-5 h-5" />
        </div>
        <div>
          <h1 className="font-bold text-lg text-slate-100 leading-tight">{storeName}</h1>
          <p className="text-xs text-slate-400 font-medium">PDV Inteligente • Terminal #01</p>
        </div>
      </div>

      {/* Status do Caixa */}
      <div className="flex items-center gap-4">
        <button
          onClick={onOpenCashModal}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-all ${
            currentSession && currentSession.status === 'OPEN'
              ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300 hover:bg-emerald-900/50'
              : 'bg-rose-950/50 border-rose-500/40 text-rose-300 hover:bg-rose-900/50'
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${currentSession?.status === 'OPEN' ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
          {currentSession?.status === 'OPEN' ? 'CAIXA ABERTO [F8]' : 'CAIXA FECHADO [F8]'}
        </button>

        {/* Indicador de Sincronização e Conexão */}
        <div className="flex items-center gap-2 bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700/60 text-xs">
          {isOnline ? (
            <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <Wifi className="w-3.5 h-3.5" /> Nuvem Conectada
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-amber-400 font-medium">
              <WifiOff className="w-3.5 h-3.5" /> Modo Offline
            </span>
          )}

          {pendingSyncCount > 0 && (
            <button
              onClick={onSyncNow}
              title="Vendas pendentes de subir para o Firebase"
              className="flex items-center gap-1 bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-mono text-[11px] border border-amber-500/30 hover:bg-amber-500/30 transition-all"
            >
              <RefreshCw className="w-3 h-3 animate-spin" />
              {pendingSyncCount} pendente(s)
            </button>
          )}
        </div>

        {/* Usuário / Operador */}
        <div className="flex items-center gap-2 bg-slate-800/60 px-3 py-1.5 rounded-lg border border-slate-700/50 text-xs text-slate-300">
          <User className="w-3.5 h-3.5 text-slate-400" />
          <span className="font-semibold text-slate-200">{currentUser.name}</span>
          <span className="text-[10px] bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded uppercase font-mono">
            {currentUser.role}
          </span>
        </div>
      </div>
    </header>
  );
};
