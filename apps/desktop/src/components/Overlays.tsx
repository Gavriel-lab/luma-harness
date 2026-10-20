import { useEffect, useRef } from 'react';
import { AlertTriangle, Download, RotateCcw, X } from 'lucide-react';
import type { RecoveryNotice as RecoveryState } from '../ui/useAppStore';
import { useModalFocus } from '../ui/useModalFocus';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function RecoveryNotice({
  recovery,
  backupUsable,
  persistError,
  onDismiss,
  onDiscard,
  onRestore,
  onExport,
}: {
  recovery: RecoveryState | null;
  backupUsable: boolean;
  persistError: string | null;
  onDismiss: () => void;
  onDiscard: () => void;
  onRestore: () => void;
  onExport: () => void;
}) {
  if (!recovery) return null;
  const { unreadable, rawPreserved } = recovery;

  return (
    <div className="notice" role="alertdialog" aria-label="本地数据恢复提示">
      <p className="notice__title">
        <AlertTriangle size={15} aria-hidden />
        {recovery.discarded ? '已用空白小屋替换损坏数据' : '本地数据读不出来'}
      </p>
      <p className="notice__body">
        原因：{recovery.reason}
        {recovery.discarded
          ? '。原始内容已经被替换，无法恢复。'
          : unreadable
            ? '。程序读不到这个文件，也没有可保存的原文，因此不会覆盖它。请先自行导出或修复。'
            : '。原始文本已经保留在下方，程序不会自动清空任何东西。'}
      </p>

      {!unreadable && <pre className="notice__raw">{recovery.raw}</pre>}

      {persistError && <p className="notice__body">上一次操作未完成：{persistError}</p>}

      <div className="notice__actions">
        <button className="btn" onClick={onDismiss} disabled={unreadable}>
          保留示例数据继续
        </button>
        <button className="btn" onClick={onExport}>
          <Download size={14} aria-hidden /> 导出原文
        </button>
        {!recovery.discarded && (
          <button className="btn" onClick={onRestore} disabled={!backupUsable || unreadable} title={
            unreadable ? '无法读取原文时不允许覆盖' : !backupUsable ? '没有通过校验的有效副本' : !rawPreserved ? '先安全保存原文，再恢复有效副本' : undefined
          }>
            <RotateCcw size={14} aria-hidden /> 恢复最近有效副本
          </button>
        )}
        {!recovery.discarded && (
          <button className="btn btn--danger" onClick={onDiscard} disabled={unreadable} title={unreadable ? '无法读取原文时不允许覆盖' : undefined}>
            丢弃损坏数据，从空白开始
          </button>
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: ConfirmRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useModalFocus('.dialog', !!request);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [request, onCancel]);

  if (!request) return null;

  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="panel dialog" role="alertdialog" aria-modal="true" aria-label={request.title}>
        <h2 className="dialog__title">{request.title}</h2>
        <p className="dialog__body">{request.body}</p>
        <div className="dialog__actions">
          <button className="btn" onClick={onCancel} autoFocus>
            <X size={14} aria-hidden /> 取消
          </button>
          <button
            ref={confirmRef}
            className={`btn ${request.danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
