import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
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

  const content = (
    <DialogContent
      disablePortal={elevatedStack}
      overlayClassName={
        elevatedStack
          ? "z-[1220] !bg-black/70 !backdrop-blur-sm supports-backdrop-filter:!backdrop-blur-sm"
          : "bg-black/72"
      }
      className={cn(
        "delete-confirm-modal bg-[#131317] border-white/10 text-[#f0ede8]",
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
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      {elevatedStack ? (
        <DialogPortal>
          {/* Stacked above another dialog (e.g. Manage lists): portal to document.body so `fixed` centering is viewport-based, not trapped under the parent dialog’s subtree. */}
          {content}
        </DialogPortal>
      ) : (
        content
      )}
    </Dialog>
  );
}
