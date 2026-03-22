export interface DeleteConfirmModalProps {
  open: boolean;
  message: string;
  title?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmModal({
  open,
  title = "Delete list?",
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: DeleteConfirmModalProps) {
  if (!open) return null;

  return (
    <div
      className="modal-bg open"
      id="delete-confirm-modal"
      role="dialog"
      aria-modal="true"
      aria-hidden="false"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="modal delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" id="delete-confirm-title">
            {title}
          </span>
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel}>
            &#x2715;
          </button>
        </div>
        <div className="delete-confirm-body">
          <p id="delete-confirm-message">{message}</p>
          <div className="delete-confirm-actions">
            <button type="button" className="delete-confirm-cancel" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="delete-confirm-delete" onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
