import { useState, useMemo } from "react";
import type { User } from "firebase/auth";
import { useQueryClient } from "@tanstack/react-query";
import type { ListMode, PersonalList, SharedList } from "../types/index.js";
import {
  createPersonalList,
  createSharedList,
  deletePersonalList,
  deleteSharedList,
  leaveSharedList,
  renamePersonalList,
  renameSharedList,
} from "../firebase.js";
import { displayListName, errorMessage } from "../lib/utils.js";
import { saveLastList } from "../lib/storage.js";
import { useAppStore } from "../store/useAppStore.js";
import { invalidateUserListQueries } from "../hooks/useWatchlist.js";
import { setBookmarkletCookieWithMode } from "../lib/bookmarkletCookie.js";
import { ListNameModal } from "./modals/ListNameModal.js";
import { DeleteConfirmModal } from "./modals/DeleteConfirmModal.js";
import { SharedCreatedModal } from "./modals/SharedCreatedModal.js";
import { useNavigate } from "react-router-dom";

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

type ListNameKind = "personal" | "shared" | null;

type EditingRow = {
  type: "personal" | "shared";
  id: string;
  draft: string;
  original?: string;
};

type DeleteTarget = {
  type: "personal" | "shared";
  id: string;
  name: string;
  count?: number;
  isLeave?: boolean;
  isSharedDelete?: boolean;
};

interface ManageListsModalProps {
  user: User;
  open: boolean;
  onClose: () => void;
  personalLists: PersonalList[];
  sharedLists: SharedList[];
}

export function ManageListsModal({ user, open, onClose, personalLists, sharedLists }: ManageListsModalProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentListMode = useAppStore((s) => s.currentListMode);
  const setCurrentListMode = useAppStore((s) => s.setCurrentListMode);

  const [joinInput, setJoinInput] = useState("");
  const [listNameKind, setListNameKind] = useState<ListNameKind>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const bookmarkletHref = useMemo(() => {
    const scriptUrl = `${window.location.origin}/bookmarklet.js?v=9`;
    return `javascript:(function(){var s=document.createElement('script');s.src='${scriptUrl}';document.body.appendChild(s);})();`;
  }, []);

  async function refreshListsAndCookie() {
    await invalidateUserListQueries(queryClient, user.uid);
    await setBookmarkletCookieWithMode(user, useAppStore.getState().currentListMode);
  }

  function sameListId(mode: ListMode, listId: string): boolean {
    return Boolean(mode && typeof mode === "object" && mode.listId === listId);
  }

  async function afterListStructureChange(maybeResetListId: string | null): Promise<void> {
    await refreshListsAndCookie();
    const mode = useAppStore.getState().currentListMode;
    if (maybeResetListId && sameListId(mode, maybeResetListId)) {
      setCurrentListMode("personal");
      saveLastList(user, "personal");
      await invalidateUserListQueries(queryClient, user.uid);
      await setBookmarkletCookieWithMode(user, useAppStore.getState().currentListMode);
    }
  }

  return (
    <>
      {open ? (
      <div
        className="modal-bg open"
        id="lists-modal"
        role="dialog"
        aria-modal="true"
        aria-hidden="false"
        onClick={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="modal lists-modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">Manage lists</span>
            <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
              &#x2715;
            </button>
          </div>
          <div className="lists-modal-body">
            <section className="lists-modal-section">
              <h3 className="lists-modal-section-title">Your lists</h3>
              <ul className="lists-modal-list" id="lists-modal-list">
                {personalLists.map((l) => (
                  <li
                    key={`p-${l.id}`}
                    className="lists-modal-list-item"
                    data-value={l.id}
                    data-type="personal"
                    data-count={String(l.count || 0)}
                  >
                    <span className="lists-modal-list-item-name">
                      {iconPerson}
                      {editing?.type === "personal" && editing.id === l.id ? (
                        <input
                          type="text"
                          className="lists-modal-list-item-edit"
                          value={editing.draft}
                          autoFocus
                          onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                          onBlur={async () => {
                            const { draft, original } = editing;
                            setEditing(null);
                            const newName = draft.trim();
                            if (!newName || newName === original) return;
                            try {
                              await renamePersonalList(user.uid, l.id, newName);
                              await refreshListsAndCookie();
                              if (sameListId(useAppStore.getState().currentListMode, l.id)) {
                                setCurrentListMode({
                                  type: "personal",
                                  listId: l.id,
                                  name: newName,
                                });
                              }
                            } catch (err: unknown) {
                              window.alert(`Failed to rename: ${errorMessage(err)}`);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              e.currentTarget.blur();
                            }
                            if (e.key === "Escape") {
                              setEditing(null);
                            }
                          }}
                        />
                      ) : (
                        <span className="lists-modal-list-item-name-text">{displayListName(l.name)}</span>
                      )}
                    </span>
                    <div className="lists-modal-list-item-actions">
                      <button
                        type="button"
                        className="lists-modal-list-item-action lists-modal-rename-btn"
                        data-list-id={l.id}
                        data-type="personal"
                        onClick={() =>
                          setEditing({
                            type: "personal",
                            id: l.id,
                            draft: displayListName(l.name),
                            original: displayListName(l.name),
                          })
                        }
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className="lists-modal-list-item-action lists-modal-list-item-action--delete lists-modal-delete-btn"
                        data-list-id={l.id}
                        data-type="personal"
                        onClick={() => {
                          if (personalLists.length <= 1) {
                            window.alert("You must have at least one personal list.");
                            return;
                          }
                          setDeleteTarget({
                            type: "personal",
                            id: l.id,
                            name: displayListName(l.name),
                            count: l.count || 0,
                            isLeave: false,
                          });
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
                {sharedLists.map((l) => {
                  const isOwner = !!(user && l.ownerId && String(l.ownerId) === String(user.uid));
                  const count = Array.isArray(l.items) ? l.items.length : 0;
                  return (
                    <li
                      key={`s-${l.id}`}
                      className="lists-modal-list-item"
                      data-value={l.id}
                      data-type="shared"
                      data-count={String(count)}
                    >
                      <span className="lists-modal-list-item-name">
                        {iconGroup}
                        {editing?.type === "shared" && editing.id === l.id ? (
                          <input
                            type="text"
                            className="lists-modal-list-item-edit"
                            value={editing.draft}
                            autoFocus
                            onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                            onBlur={async () => {
                              const snap = editing;
                              setEditing(null);
                              if (!snap) return;
                              const newName = snap.draft.trim();
                              if (!newName || newName === snap.original) return;
                              try {
                                await renameSharedList(l.id, newName);
                                await refreshListsAndCookie();
                                if (sameListId(useAppStore.getState().currentListMode, l.id)) {
                                  setCurrentListMode({
                                    type: "shared",
                                    listId: l.id,
                                    name: newName,
                                  });
                                }
                              } catch (err: unknown) {
                                window.alert(`Failed to rename: ${errorMessage(err)}`);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                e.currentTarget.blur();
                              }
                              if (e.key === "Escape") {
                                setEditing(null);
                              }
                            }}
                          />
                        ) : (
                          <span className="lists-modal-list-item-name-text">{displayListName(l.name)}</span>
                        )}
                      </span>
                      <div className="lists-modal-list-item-actions">
                        <button
                          type="button"
                          className="lists-modal-list-item-action lists-modal-rename-btn"
                          data-list-id={l.id}
                          data-type="shared"
                          onClick={() =>
                            setEditing({
                              type: "shared",
                              id: l.id,
                              draft: displayListName(l.name),
                              original: displayListName(l.name),
                            })
                          }
                        >
                          Rename
                        </button>
                        {isOwner ? (
                          <button
                            type="button"
                            className="lists-modal-list-item-action lists-modal-list-item-action--delete lists-modal-delete-btn"
                            data-list-id={l.id}
                            data-type="shared"
                            onClick={() =>
                              setDeleteTarget({
                                type: "shared",
                                id: l.id,
                                name: displayListName(l.name),
                                count,
                                isLeave: false,
                                isSharedDelete: true,
                              })
                            }
                          >
                            Delete
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="lists-modal-list-item-leave lists-modal-leave-btn"
                            data-list-id={l.id}
                            onClick={() =>
                              setDeleteTarget({
                                type: "shared",
                                id: l.id,
                                name: displayListName(l.name),
                                count,
                                isLeave: true,
                              })
                            }
                          >
                            Leave
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="lists-modal-create-buttons">
                <button
                  type="button"
                  className="lists-modal-new-personal"
                  id="lists-new-personal-btn"
                  onClick={() => setListNameKind("personal")}
                >
                  + New personal list
                </button>
                <button
                  type="button"
                  className="lists-modal-btn"
                  id="lists-create-btn"
                  onClick={() => setListNameKind("shared")}
                >
                  + Create new shared list
                </button>
              </div>
            </section>
            <section className="lists-modal-section">
              <h3 className="lists-modal-section-title">Join with link</h3>
              <div className="lists-modal-join">
                <input
                  type="text"
                  id="lists-join-input"
                  className="lists-modal-input"
                  placeholder="Paste invite link"
                  value={joinInput}
                  onChange={(e) => setJoinInput(e.target.value)}
                />
                <button
                  type="button"
                  className="lists-modal-btn"
                  id="lists-join-btn"
                  onClick={async () => {
                    const url = joinInput.trim();
                    if (!url) {
                      window.alert("Paste the invite link in the field above.");
                      return;
                    }
                    let listId: string | null = null;
                    try {
                      const parsed = new URL(url);
                      const byQuery = parsed.searchParams.get("join");
                      if (byQuery) listId = byQuery;
                      if (!listId) {
                        const byPath = parsed.pathname.match(/\/join\/([a-z0-9]+)/i);
                        listId = byPath?.[1] ?? null;
                      }
                    } catch {
                      const byQueryMatch = url.match(/[?&]join=([a-z0-9]+)/i);
                      if (byQueryMatch?.[1]) listId = byQueryMatch[1];
                      if (!listId) {
                        const byPathMatch = url.match(/\/join\/([a-z0-9]+)/i);
                        listId = byPathMatch?.[1] ?? null;
                      }
                    }
                    if (!listId) {
                      window.alert("Invalid link. Paste the full URL from the person who shared the list.");
                      return;
                    }
                    try {
                      const res = await fetch(`${window.location.origin}/.netlify/functions/join-shared-list`, {
                        method: "POST",
                        credentials: "include",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ listId }),
                      });
                      const data = await res.json();
                      if (data.ok) {
                        setJoinInput("");
                        const mode = { type: "shared", listId, name: data.name || "" };
                        setCurrentListMode(mode);
                        saveLastList(user, mode);
                        await refreshListsAndCookie();
                        navigate(`/list/${listId}`, { replace: true });
                      } else {
                        window.alert(data.error || "Failed to join");
                      }
                    } catch (err: unknown) {
                      window.alert(`Failed to join: ${errorMessage(err)}`);
                    }
                  }}
                >
                  Join
                </button>
              </div>
            </section>
            <section className="lists-modal-section">
              <h3 className="lists-modal-section-title">Add from IMDb</h3>
              <p className="lists-modal-description">
                Drag this button to your bookmarks bar to add titles directly from any IMDb page.
              </p>
              <a
                href={bookmarkletHref}
                id="lists-bookmarklet-btn"
                className="lists-modal-bookmarklet-btn"
                draggable="true"
                onClick={(e) => e.preventDefault()}
              >
                Add to Watchlist
              </a>
            </section>
          </div>
        </div>
      </div>
      ) : null}

      <ListNameModal
        open={listNameKind != null}
        title={listNameKind === "shared" ? "Name your shared list" : "Name your personal list"}
        placeholder={listNameKind === "shared" ? "e.g. Family watchlist" : "e.g. Weekend picks"}
        allowCancel
        onCancel={() => setListNameKind(null)}
        onSave={async (name: string) => {
          const kind = listNameKind;
          setListNameKind(null);
          if (!kind) return;
          try {
            if (kind === "personal") {
              const listId = await createPersonalList(user.uid, name);
              const mode = { type: "personal", listId, name };
              setCurrentListMode(mode);
              saveLastList(user, mode);
              await refreshListsAndCookie();
            } else {
              const listId = await createSharedList(user.uid, name);
              const mode = { type: "shared", listId, name };
              setCurrentListMode(mode);
              saveLastList(user, mode);
              await refreshListsAndCookie();
              setShareUrl(`${window.location.origin}/join/${listId}`);
            }
          } catch (err: unknown) {
            window.alert(`Failed to create: ${errorMessage(err)}`);
          }
        }}
      />

      <DeleteConfirmModal
        open={deleteTarget != null}
        title={
          deleteTarget?.isLeave ? "Leave list?" : "Delete list?"
        }
        message={
          deleteTarget == null
            ? ""
            : deleteTarget.isLeave
              ? `Leave ${deleteTarget.name}? You will lose access but other members are unaffected.`
              : deleteTarget.isSharedDelete
                ? `Delete ${deleteTarget.name}? This will permanently delete the list for all members.`
                : `Delete ${deleteTarget.name}? This will permanently remove all ${deleteTarget.count} titles and cannot be undone.`
        }
        confirmLabel={deleteTarget?.isLeave ? "Leave" : "Delete"}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          const t = deleteTarget;
          setDeleteTarget(null);
          if (!t) return;
          try {
            if (t.isLeave) {
              await leaveSharedList(user.uid, t.id);
            } else if (t.type === "personal") {
              await deletePersonalList(user.uid, t.id);
            } else {
              await deleteSharedList(t.id);
            }
            await afterListStructureChange(t.id);
          } catch (err: unknown) {
            window.alert(`Failed: ${errorMessage(err)}`);
          }
        }}
      />

      <SharedCreatedModal
        open={shareUrl != null}
        shareUrl={shareUrl || ""}
        onClose={() => setShareUrl(null)}
      />
    </>
  );
}
