import { useState, useRef, useEffect } from "react";
import { saveLastList } from "../lib/storage.js";
import { displayListName } from "../lib/utils.js";
import { useAppStore } from "../store/useAppStore.js";
import { getCurrentListLabel, getCurrentListValue } from "../data/lists.js";
import type { ListMode, PersonalList, SharedList } from "../types/index.js";

const iconPerson = (
  <svg className="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
    />
  </svg>
);

const iconGroup = (
  <svg className="custom-dropdown-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"
    />
  </svg>
);

interface ListSelectorProps {
  personalLists: PersonalList[];
  sharedLists: SharedList[];
  onManageLists?: () => void;
}

export function ListSelector({ personalLists, sharedLists, onManageLists }: ListSelectorProps) {
  const currentUser = useAppStore((s) => s.currentUser);
  const currentListMode = useAppStore((s) => s.currentListMode);
  const setCurrentListMode = useAppStore((s) => s.setCurrentListMode);
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const currentVal = getCurrentListValue(currentListMode, personalLists);
  const label = getCurrentListLabel(currentListMode, personalLists, sharedLists);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (!wrapRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  const items = [
    ...personalLists.map((l) => ({
      value: l.id,
      label: displayListName(l.name),
      icon: iconPerson,
    })),
    ...sharedLists.map((l) => ({
      value: l.id,
      label: displayListName(l.name),
      icon: iconGroup,
    })),
  ];

  useEffect(() => {
    if (!open) return;
    const currentIndex = items.findIndex((item) => item.value === currentVal);
    setFocusedIndex(currentIndex >= 0 ? currentIndex : items.length > 0 ? 0 : -1);
  }, [open, items, currentVal]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((idx) => (idx < 0 ? 0 : (idx + 1) % items.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((idx) => (idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setFocusedIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setFocusedIndex(items.length - 1);
        return;
      }
      if (e.key === "Enter" || e.key === " ") {
        if (focusedIndex < 0) return;
        e.preventDefault();
        const item = items[focusedIndex];
        if (item) selectValue(item.value);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, items, focusedIndex]);

  useEffect(() => {
    if (!open || focusedIndex < 0) return;
    itemRefs.current[focusedIndex]?.focus();
  }, [open, focusedIndex]);

  function selectValue(val: string) {
    setOpen(false);
    const personalList = personalLists.find((l) => l.id === val);
    const sharedList = sharedLists.find((l) => l.id === val);
    let mode: ListMode = "personal";
    if (personalList) {
      mode =
        val === "personal"
          ? "personal"
          : { type: "personal", listId: val, name: personalList.name };
    } else if (sharedList) {
      mode = { type: "shared", listId: sharedList.id, name: sharedList.name };
    }
    setCurrentListMode(mode);
    saveLastList(currentUser, mode);
  }

  return (
    <div
      className="custom-dropdown"
      id="list-selector"
      ref={wrapRef}
      data-open={open ? "true" : "false"}
    >
      <div className="list-controls-pair">
        <button
          type="button"
          className="custom-dropdown-trigger"
          id="list-selector-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Switch list"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
          }}
        >
          <span className="custom-dropdown-value">{label}</span>
          <svg className="custom-dropdown-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="M7 10l5 5 5-5z" />
          </svg>
        </button>
        <button
          type="button"
          className="list-settings-btn"
          id="list-settings-btn"
          title="Manage lists"
          aria-label="Manage lists"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
            onManageLists?.();
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
            />
          </svg>
        </button>
      </div>
      <div
        className="custom-dropdown-panel"
        id="list-selector-panel"
        role="listbox"
        aria-hidden={!open}
      >
        {items.map(({ value, label: itemLabel, icon }) => (
          <div
            key={value}
            className="custom-dropdown-item"
            role="option"
            data-value={value}
            aria-selected={value === currentVal}
            tabIndex={focusedIndex >= 0 && items[focusedIndex]?.value === value ? 0 : -1}
            ref={(el) => {
              const idx = items.findIndex((item) => item.value === value);
              if (idx >= 0) itemRefs.current[idx] = el;
            }}
            onFocus={() => {
              const idx = items.findIndex((item) => item.value === value);
              if (idx >= 0) setFocusedIndex(idx);
            }}
            onClick={(e) => {
              e.stopPropagation();
              selectValue(value);
            }}
          >
            {icon}
            <span className="custom-dropdown-item-text">{itemLabel}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface CopyInviteButtonProps {
  currentListMode: ListMode;
}

export function CopyInviteButton({ currentListMode }: CopyInviteButtonProps) {
  const [copied, setCopied] = useState(false);
  const isShared =
    currentListMode &&
    typeof currentListMode === "object" &&
    currentListMode.type === "shared";

  if (!isShared) return null;

  const listId = currentListMode.listId;
  const shareUrl = `${window.location.origin}/join/${listId}`;

  return (
    <button
      type="button"
      id="copy-invite-btn"
      className="copy-invite-btn"
      title="Copy invite link"
      disabled={copied}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(shareUrl);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.alert(`Could not copy. The link is:\n${shareUrl}`);
        }
      }}
    >
      <svg className="copy-invite-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          fill="currentColor"
          d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"
        />
      </svg>
      <span className="copy-invite-text">{copied ? "Copied!" : "Copy invite link"}</span>
    </button>
  );
}
