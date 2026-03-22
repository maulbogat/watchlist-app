import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface ListNameModalProps {
  open: boolean;
  title?: string;
  placeholder?: string;
  initialValue?: string;
  allowCancel?: boolean;
  onSave: (name: string) => void | Promise<void>;
  onCancel?: () => void;
}

export function ListNameModal({
  open,
  title = "List name",
  placeholder = "",
  initialValue = "",
  allowCancel = false,
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

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && allowCancel) close();
      }}
    >
      <DialogContent
        className="modal country-modal bg-[#131317] border-white/10 text-[#f0ede8]"
        id="list-name-modal"
        onEscapeKeyDown={(e) => {
          if (!allowCancel) {
            e.preventDefault();
            return;
          }
          close();
        }}
        onInteractOutside={(e) => {
          if (!allowCancel) {
            e.preventDefault();
            return;
          }
          close();
        }}
      >
        <DialogHeader className="modal-header">
          <DialogTitle className="modal-title font-title tracking-widest" id="list-name-modal-title">
            {title}
          </DialogTitle>
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
    </Dialog>
  );
}
