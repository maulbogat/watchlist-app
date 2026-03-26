import { saveLastList } from "../lib/storage.js";
import { displayListName } from "../lib/utils.js";
import { logEvent } from "../lib/axiom-logger.js";
import { useAppStore } from "../store/useAppStore.js";
import { getCurrentListLabel, getCurrentListValue } from "../data/lists.js";
import type { ListMode, PersonalList, SharedList } from "../types/index.js";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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

  const currentVal = getCurrentListValue(currentListMode, personalLists);
  const label = getCurrentListLabel(currentListMode, personalLists, sharedLists);

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

  function selectValue(val: string) {
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
    void logEvent({
      type: "user.action",
      action: "list.switch",
      listType: typeof mode === "object" ? mode.type : "personal",
      listId: typeof mode === "object" ? mode.listId : "personal",
      uid: currentUser?.uid ?? null,
    }).catch(() => {});
  }

  return (
    <div className="custom-dropdown" id="list-selector" data-open="false">
      <div className="list-controls-pair">
        <Select value={currentVal} onValueChange={selectValue}>
          <SelectTrigger className="custom-dropdown-trigger" id="list-selector-trigger" title="Switch list">
            <SelectValue>
              <span className="custom-dropdown-value">{label}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            className="custom-dropdown-content min-w-[180px] border border-[var(--border)] bg-[var(--surface2)] text-[var(--text)] shadow-[0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.08]"
            id="list-selector-panel"
            position="popper"
            side="bottom"
            align="start"
            sideOffset={8}
            avoidCollisions={false}
          >
            {items.map(({ value, label: itemLabel, icon }) => (
              <SelectItem key={value} value={value} className="custom-dropdown-item">
                <span className="custom-dropdown-item-with-icon">
                  {icon}
                  <span className="custom-dropdown-item-text">{itemLabel}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          className="list-settings-btn"
          id="list-settings-btn"
          title="Manage lists"
          aria-label="Manage lists"
          onClick={() => onManageLists?.()}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
            />
          </svg>
        </Button>
      </div>
    </div>
  );
}

