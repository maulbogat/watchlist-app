import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/shadcn-utils";

export interface DeleteConfirmModalProps {
  open: boolean;
  message: string;
  title?: string;
  confirmLabel?: string;
  elevatedStack?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmModal({
  open,
  title = "Delete list?",
  message,
  confirmLabel = "Delete",
  elevatedStack = false,
  onConfirm,
  onCancel,
}: DeleteConfirmModalProps) {
  if (!open) return null;

  const blockOutsideDismiss = elevatedStack;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent
        {...(elevatedStack ? { overlayClassName: "z-[1220]" } : {})}
        className={cn(
          "modal delete-confirm-modal bg-[#131317] border-white/10 text-[#f0ede8]",
          elevatedStack && "z-[1230]"
        )}
        id="delete-confirm-modal"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onCancel();
        }}
        onPointerDownOutside={(e) => {
          if (blockOutsideDismiss) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (blockOutsideDismiss) {
            e.preventDefault();
            return;
          }
          onCancel();
        }}
      >
        <DialogHeader className="modal-header">
          <DialogTitle className="modal-title font-title tracking-widest">{title}</DialogTitle>
          <DialogDescription className="text-[0.95rem] leading-snug text-[#f0ede8]/90">
            {message}
          </DialogDescription>
        </DialogHeader>
        <div className="delete-confirm-body">
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
