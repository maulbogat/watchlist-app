import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/shadcn-utils";

export interface SharedCreatedModalProps {
  open: boolean;
  elevatedStack?: boolean;
  onClose: () => void;
}

export function SharedCreatedModal({ open, elevatedStack = false, onClose }: SharedCreatedModalProps) {
  if (!open) return null;

  const blockOutsideDismiss = elevatedStack;

  const content = (
    <DialogContent
      disablePortal={elevatedStack}
      {...(elevatedStack ? { overlayClassName: "z-[1220]" } : {})}
      className={cn(
        "lists-modal max-h-[85vh] overflow-y-auto bg-[#131317] text-[#f0ede8] sm:max-w-[520px]",
        elevatedStack && "z-[1230]"
      )}
      id="shared-modal"
      onEscapeKeyDown={(e) => {
        e.preventDefault();
        onClose();
      }}
      onPointerDownOutside={(e) => {
        if (blockOutsideDismiss) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (blockOutsideDismiss) {
          e.preventDefault();
          return;
        }
        onClose();
      }}
    >
      <DialogHeader className="modal-header">
        <DialogTitle className="modal-title font-title tracking-widest">Shared list created</DialogTitle>
        <DialogDescription className="text-[0.95rem] leading-snug text-[var(--muted)]">
          To add someone to this list, use the <strong>Invite someone</strong> form below and select this list.
        </DialogDescription>
      </DialogHeader>
      <div className="shared-modal-body" id="shared-modal-body">
        <p className="lists-modal-description text-[0.9rem]">
          They must already be allowed to use the app. They will receive an email with a link to accept access and join
          this list.
        </p>
      </div>
    </DialogContent>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      {elevatedStack ? (
        <DialogPortal>
          {/* Shown right after creating a shared list from Manage lists: portal to body so this layer is not nested under #lists-modal DOM. */}
          {content}
        </DialogPortal>
      ) : (
        content
      )}
    </Dialog>
  );
}
