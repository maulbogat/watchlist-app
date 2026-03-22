import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent
        className="modal delete-confirm-modal bg-[#131317] border-white/10 text-[#f0ede8]"
        id="delete-confirm-modal"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
        onInteractOutside={() => {
          onCancel();
        }}
      >
        <DialogHeader className="modal-header">
          <DialogTitle className="modal-title font-title tracking-widest" id="delete-confirm-title">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="delete-confirm-body">
          <p id="delete-confirm-message">{message}</p>
          <div className="delete-confirm-actions">
            <Button type="button" variant="outline" className="delete-confirm-cancel" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" className="delete-confirm-delete" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
