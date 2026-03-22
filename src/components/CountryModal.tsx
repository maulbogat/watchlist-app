import { useEffect, useState, useMemo } from "react";
import { COUNTRIES } from "../countries.js";
import type { Country } from "../types/index.js";

function countryByCodeOrFirst(code: string): Country {
  const hit = COUNTRIES.find((c) => c.code === code);
  const first = COUNTRIES[0];
  if (hit) return hit;
  if (first) return first;
  throw new Error("COUNTRIES is empty");
}

interface CountryModalProps {
  open: boolean;
  initialCode?: string;
  allowCancel?: boolean;
  onSave: (code: string, name: string) => void | Promise<void>;
  onCancel?: () => void;
}

export function CountryModal({
  open,
  initialCode = "IL",
  allowCancel = false,
  onSave,
  onCancel,
}: CountryModalProps) {
  const [selected, setSelected] = useState<Country>(() => countryByCodeOrFirst(initialCode));
  const [search, setSearch] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    if (open) {
      const s = countryByCodeOrFirst(initialCode);
      setSelected(s);
      setSearch(s.name);
      setDropdownOpen(false);
    }
  }, [open, initialCode]);

  const list = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? COUNTRIES.filter((c) => c.searchKey.includes(q)) : COUNTRIES;
  }, [search]);

  useEffect(() => {
    if (!open || !dropdownOpen) return;
    function onDoc(e: MouseEvent) {
      const t = e.target;
      if (t instanceof Element && (t.closest("#country-search") || t.closest("#country-dropdown"))) return;
      setDropdownOpen(false);
    }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open, dropdownOpen]);

  if (!open) return null;

  async function handleSave() {
    await onSave(selected.code, selected.name);
  }

  return (
    <div
      className="modal-bg country-modal-bg open"
      id="country-modal"
      role="dialog"
      aria-modal="true"
      aria-hidden="false"
      onClick={(e) => allowCancel && e.target === e.currentTarget && onCancel?.()}
    >
      <div className="modal country-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Where are you watching from?</span>
        </div>
        <div className="country-modal-body">
          <div className="country-picker-wrap">
            <input
              type="text"
              id="country-search"
              className="country-search"
              placeholder="Search countries..."
              autoComplete="off"
              aria-haspopup="listbox"
              aria-expanded={dropdownOpen}
              aria-controls="country-dropdown-list"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setDropdownOpen(true);
              }}
              onFocus={() => setDropdownOpen(true)}
              autoFocus
            />
            <div
              className={`country-dropdown${dropdownOpen ? " open" : ""}`}
              id="country-dropdown"
              role="listbox"
              aria-hidden={!dropdownOpen}
            >
              <div className="country-dropdown-list" id="country-dropdown-list">
                {list.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    className="country-dropdown-item"
                    role="option"
                    data-code={c.code}
                    aria-selected={c.code === selected.code}
                    onClick={() => {
                      setSelected(c);
                      setSearch(c.name);
                      setDropdownOpen(true);
                    }}
                  >
                    {c.flag} {c.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {allowCancel ? (
              <button type="button" className="country-save-btn list-name-secondary-btn" onClick={() => onCancel?.()}>
                Cancel
              </button>
            ) : null}
            <button type="button" className="country-save-btn" id="country-save-btn" onClick={handleSave}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
