import { useEffect, useState } from "react";
import FocusTrap from "focus-trap-react";

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
    <div
      className="modal-bg country-modal-bg open"
      id="list-name-modal"
      onClick={(e) => e.target === e.currentTarget && allowCancel && close()}
    >
      <FocusTrap
        active={open}
        focusTrapOptions={{
          escapeDeactivates: false,
          allowOutsideClick: true,
          initialFocus: false,
        }}
      >
        <div
          className="modal country-modal"
          role="dialog"
          aria-modal="true"
          aria-hidden="false"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="modal-header">
            <span className="modal-title" id="list-name-modal-title">
              {title}
            </span>
          </div>
          <div className="country-modal-body list-name-modal-body">
            <input
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
                <button type="button" className="country-save-btn list-name-secondary-btn" onClick={close}>
                  Cancel
                </button>
              ) : null}
              <button type="button" className="country-save-btn" id="list-name-save-btn" onClick={submit}>
                Save
              </button>
            </div>
          </div>
        </div>
      </FocusTrap>
    </div>
  );
}
