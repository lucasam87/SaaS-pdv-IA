import React from 'react';
import { Store, User, Wifi, WifiOff, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { CashSession } from '@pdv/shared';

export interface HeaderOutboxStats {
  pending: number;
  processing: number;
  failed: number;
  synced: number;
}

interface HeaderProps {
  storeName: string;
  deviceId: string;
  deviceName: string;
  currentUser: { name: string; role: string };
  currentSession: CashSession | null;
  isOnline: boolean;
  outboxStats?: HeaderOutboxStats;
  pendingSyncCount: number;
  onSyncNow: () => void;
  onOpenCashModal: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  storeName,
  deviceId,
  deviceName,
  currentUser,
  currentSession,
  isOnline,
  outboxStats,
  pendingSyncCount,
  onSyncNow,
  onOpenCashModal,
}) => {
  const pendingCount = outboxStats ? outboxStats.pending : pendingSyncCount;
  const failedCount = outboxStats ? outboxStats.failed : 0;
  const syncedCount = outboxStats ? outboxStats.synced : 0;

  return (
    <header className="bg-slate-900 border-b border-slate-800 px-6 py-3 flex items-center justify-between shadow-md select-none">
      {/* Identificação da Loja */}
      <div className="flex items-center gap-3">
        <div className="bg-emerald-600/20 p-2 rounded-lg border border-emerald-500/30 text-emerald-400">
          <Store className="w-5 h-5" />
        </div>
        <div>
          <h1 className="font-bold text-lg text-slate-100 leading-tight">{storeName}</h1>
          <p className="text-xs text-slate-400 font-medium">
            {deviceName} <span className="font-mono text-emerald-400">[{deviceId}]</span>
          </p>
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

        {/* Indicador de Sincronização e Conexão Real */}
        <div className="flex items-center gap-2.5 bg-slate-800/80 px-3 py-1.5 rounded-lg border border-slate-700/60 text-xs">
          {isOnline ? (
            <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <Wifi className="w-3.5 h-3.5" /> Rede Ativa
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-amber-400 font-medium">
              <WifiOff className="w-3.5 h-3.5" /> Modo Offline
            </span>
          )}

          {/* Contagem Real de Sincronizadas / Confirmadas */}
          {syncedCount > 0 && (
            <span
              title="Vendas confirmadas e sincronizadas com a nuvem"
              className="flex items-center gap-1 text-emerald-400/90 font-mono text-[11px] bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20"
            >
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              {syncedCount} confirmada(s)
            </span>
          )}

          {/* Contagem Real de Falhas */}
          {failedCount > 0 && (
            <span
              title="Operações que falharam na sincronização remota"
              className="flex items-center gap-1 text-rose-400 font-mono text-[11px] bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20"
            >
              <AlertCircle className="w-3 h-3 text-rose-400" />
              {failedCount} falha(s)
            </span>
          )}

          {/* Contagem Real de Pendentes na Outbox */}
          {pendingCount > 0 ? (
            <button
              onClick={onSyncNow}
              title="Vendas aguardando integração ou confirmação do backend"
              className="flex items-center gap-1 bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded font-mono text-[11px] border border-amber-500/30 hover:bg-amber-500/30 transition-all"
            >
              <RefreshCw className="w-3 h-3" />
              {pendingCount} pendente(s)
            </button>
          ) : (
            outboxStats && (
              <span className="text-slate-400 font-mono text-[11px]">
                0 pendente(s)
              </span>
            )
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
