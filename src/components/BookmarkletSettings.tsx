import { useLayoutEffect, useMemo, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VisuallyHidden } from "radix-ui";

interface BookmarkletSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BookmarkletSettings({ open, onOpenChange }: BookmarkletSettingsProps) {
  const bookmarkletRef = useRef<HTMLAnchorElement | null>(null);

  const bookmarkletHref = useMemo(() => {
    const scriptUrl = `${window.location.origin}/bookmarklet.js?v=10`;
    return `javascript:(function(){var s=document.createElement('script');s.src='${scriptUrl}';document.body.appendChild(s);})();`;
  }, []);
  const bookmarkletLabel = "Add to Watchlist";

  useLayoutEffect(() => {
    const node = bookmarkletRef.current;
    if (!node) return;
    node.setAttribute("href", bookmarkletHref);
    node.setAttribute("title", bookmarkletLabel);
  }, [bookmarkletHref, bookmarkletLabel]);

  function ensureBookmarkletHref() {
    const node = bookmarkletRef.current;
    if (!node) return;
    node.setAttribute("href", bookmarkletHref);
    node.setAttribute("title", bookmarkletLabel);
  }

  return (
    <>
      {open ? (
        <Dialog
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) onOpenChange(false);
          }}
        >
          <DialogContent
            className="lists-modal z-[1201] max-h-[85vh] overflow-y-auto bg-[#131317] text-[#f0ede8]"
            id="bookmarklet-settings-modal"
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              onOpenChange(false);
            }}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <DialogHeader className="modal-header">
              <DialogTitle className="modal-title font-title tracking-widest">
                Bookmarklet
              </DialogTitle>
              <DialogDescription asChild>
                <VisuallyHidden.Root>
                  Drag the bookmarklet button to your browser bar to add titles from IMDb.
                </VisuallyHidden.Root>
              </DialogDescription>
            </DialogHeader>
            <div className="lists-modal-body">
              <section className="lists-modal-section">
                <h3 className="lists-modal-section-title">Add from IMDb</h3>
                <p className="lists-modal-description">
                  Drag this button to your bookmarks bar, then open any IMDb title page and click it
                  to add the title to your current list (same as the hosted bookmarklet page).
                </p>
                <p className="lists-modal-description">
                  You can also open{" "}
                  <a href="/bookmarklet.html" className="text-[var(--accent)] underline">
                    bookmarklet instructions
                  </a>{" "}
                  in a new tab.
                </p>
                <a
                  ref={bookmarkletRef}
                  id="bookmarklet-settings-drag-btn"
                  className="lists-modal-bookmarklet-btn"
                  draggable="true"
                  onMouseDown={ensureBookmarkletHref}
                  onClick={(e) => e.preventDefault()}
                >
                  Add to Watchlist
                </a>
              </section>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
