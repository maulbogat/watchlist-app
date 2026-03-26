import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/shadcn-utils";

export interface ListNameModalProps {
  open: boolean;
  title?: string;
  placeholder?: string;
  initialValue?: string;
  allowCancel?: boolean;
  /** Stack above parent dialogs (e.g. Manage lists panel is z-[1201]). */
  elevatedStack?: boolean;
  onSave: (name: string) => void | Promise<void>;
  onCancel?: () => void;
}

export function ListNameModal({
  open,
  title = "List name",
  placeholder = "",
  initialValue = "",
  allowCancel = false,
  elevatedStack = false,
  onSave,
  onCancel,
}: ListNameModalProps) {
  const [val, setVal] = useState(initialValue);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (open) {
      setVal(initialValue ?? "");
      setErr(false);
    }
  }, [open, initialValue]);

  if (!open) return null;

  function close() {
    onCancel?.();
  }

  async function submit() {
    const raw = val.trim();
    if (!raw) {
      setErr(true);
      return;
    }
    try {
      await onSave(raw);
    } catch (e) {
      console.error(e);
    }
  }

  /** Stacked on another dialog (e.g. Manage lists): ignore outside dismiss so the opening click/pointer-up does not instantly close this modal. */
  const blockOutsideDismiss = Boolean(elevatedStack && allowCancel);

  const content = (
    <DialogContent
      disablePortal={elevatedStack}
      {...(elevatedStack ? { overlayClassName: "z-[1220]" } : {})}
      className={cn(
        "lists-modal max-h-[85vh] overflow-y-auto bg-[#131317] text-[#f0ede8] sm:max-w-[420px]",
        elevatedStack && "z-[1230]"
      )}
      id="list-name-modal"
      onEscapeKeyDown={(e) => {
        if (!allowCancel) {
          e.preventDefault();
          return;
        }
        close();
      }}
      onPointerDownOutside={(e) => {
        if (blockOutsideDismiss) e.preventDefault();
      }}
      onInteractOutside={(e) => {
        if (!allowCancel) {
          e.preventDefault();
          return;
        }
        if (blockOutsideDismiss) {
          e.preventDefault();
          return;
        }
        close();
      }}
    >
      <DialogHeader className="modal-header">
        <DialogTitle className="modal-title font-title tracking-widest">{title}</DialogTitle>
        <DialogDescription className="text-[0.9rem] leading-snug text-[var(--muted)]">
          Enter a name for this list, then save.
        </DialogDescription>
      </DialogHeader>
      <div className="country-modal-body list-name-modal-body">
        <Input
          type="text"
          id="list-name-input"
          className="country-search list-name-input"
          placeholder={placeholder}
          maxLength={120}
          autoComplete="off"
          value={val}
          onChange={(e) => {
            setVal(e.target.value);
            setErr(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus
        />
        <p className="list-name-error" id="list-name-error" hidden={!err} role="alert">
          {err ? "Enter a name." : ""}
        </p>
        <div className="list-name-modal-actions">
          {allowCancel ? (
            <Button type="button" variant="outline" className="country-save-btn list-name-secondary-btn" onClick={close}>
              Cancel
            </Button>
          ) : null}
          <Button type="button" className="country-save-btn" id="list-name-save-btn" onClick={submit}>
            Save
          </Button>
        </div>
      </div>
    </DialogContent>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && allowCancel) close();
      }}
    >
      {elevatedStack ? (
        <DialogPortal>
          {/* Opened from Manage lists while that dialog is mounted: portal to document.body so overlay/content are not under #lists-modal (avoids broken `fixed` centering). */}
          {content}
        </DialogPortal>
      ) : (
        content
      )}
    </Dialog>
  );
}
