import { useState } from "react";

/**
 * @param {{ open: boolean, shareUrl: string, onClose: () => void }} props
 */
export function SharedCreatedModal({ open, shareUrl, onClose }) {
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  return (
    <div
      className="modal-bg open"
      id="shared-modal"
      role="dialog"
      aria-modal="true"
      aria-hidden="false"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal shared-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" id="shared-modal-title">
            Shared list created
          </span>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            &#x2715;
          </button>
        </div>
        <div className="shared-modal-body" id="shared-modal-body">
          <p>Share this link for others to join:</p>
          <p className="share-link" id="share-link-text">
            {shareUrl}
          </p>
          <button
            type="button"
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
          </button>
          <p style={{ marginTop: "0.75rem", fontSize: "0.85rem", color: "var(--muted)" }}>
            Anyone with the link can join. They must be signed in.
          </p>
        </div>
      </div>
    </div>
  );
}
