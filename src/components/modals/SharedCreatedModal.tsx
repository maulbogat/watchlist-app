import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface SharedCreatedModalProps {
  open: boolean;
  shareUrl: string;
  onClose: () => void;
}

export function SharedCreatedModal({ open, shareUrl, onClose }: SharedCreatedModalProps) {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="modal shared-modal bg-[#131317] border-white/10 text-[#f0ede8]"
        id="shared-modal"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        onInteractOutside={() => {
          onClose();
        }}
      >
        <DialogHeader className="modal-header">
          <DialogTitle className="modal-title font-title tracking-widest" id="shared-modal-title">
            Shared list created
          </DialogTitle>
        </DialogHeader>
        <div className="shared-modal-body" id="shared-modal-body">
          <p>Share this link for others to join:</p>
          <p className="share-link" id="share-link-text">
            {shareUrl}
          </p>
          <Button
            type="button"
            variant="outline"
            className="auth-btn"
            id="copy-share-link-btn"
            style={{ marginTop: "0.75rem" }}
            disabled={copied}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                window.alert("Could not copy. Select and copy the link above.");
              }
            }}
          >
            {copied ? "Copied!" : "Copy link"}
          </Button>
          <p style={{ marginTop: "0.75rem", fontSize: "0.85rem", color: "var(--muted)" }}>
            Anyone with the link can join. They must be signed in.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
