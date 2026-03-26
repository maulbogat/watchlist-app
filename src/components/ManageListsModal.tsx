import { useLayoutEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ListMode, PersonalList, SharedList } from "../types/index.js";
import {
  createPersonalList,
  createSharedList,
  deletePersonalList,
  deleteSharedList,
  getIdTokenForApi,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

type PendingInvite = {
  inviteId: string;
  invitedEmail: string;
  listId: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  usedAt: string | null;
};

const INVITE_LIST_NONE = "__none__";

interface ManageListsModalProps {
  open: boolean;
  onClose: () => void;
  personalLists: PersonalList[];
  sharedLists: SharedList[];
}

export function ManageListsModal({ open, onClose, personalLists, sharedLists }: ManageListsModalProps) {
  const queryClient = useQueryClient();
  const currentUser = useAppStore((s) => s.currentUser);
  const currentListMode = useAppStore((s) => s.currentListMode);
  const setCurrentListMode = useAppStore((s) => s.setCurrentListMode);

  const [listNameKind, setListNameKind] = useState<ListNameKind>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteListChoice, setInviteListChoice] = useState<string>(INVITE_LIST_NONE);

  if (!currentUser?.uid) return null;
  const signedInUser = currentUser;
  const uid = signedInUser.uid;
  const syncListsMutation = useMutation({
    mutationFn: async (): Promise<void> => {},
    onSuccess: async () => {
      await invalidateUserListQueries(queryClient, uid);
      await setBookmarkletCookieWithMode(signedInUser, useAppStore.getState().currentListMode);
    },
  });

  async function refreshListsAndCookie() {
    await syncListsMutation.mutateAsync();
  }

  function sameListId(mode: ListMode, listId: string): boolean {
    return Boolean(mode && typeof mode === "object" && mode.listId === listId);
  }

  async function afterListStructureChange(maybeResetListId: string | null): Promise<void> {
    await refreshListsAndCookie();
    const mode = useAppStore.getState().currentListMode;
    if (maybeResetListId && sameListId(mode, maybeResetListId)) {
      setCurrentListMode("personal");
      saveLastList(signedInUser, "personal");
      await syncListsMutation.mutateAsync();
    }
  }

  const invitesQ = useQuery({
    queryKey: ["pending-invites", uid],
    queryFn: async (): Promise<PendingInvite[]> => {
      const token = await getIdTokenForApi();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/invites", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as { ok?: boolean; invites?: PendingInvite[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to load invites");
      return Array.isArray(data.invites) ? data.invites : [];
    },
    enabled: open && Boolean(uid),
  });

  const sendInviteMutation = useMutation({
    mutationFn: async (payload: { invitedEmail: string; listId: string | null }) => {
      const token = await getIdTokenForApi();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "send", ...payload }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to send invite");
    },
    onSuccess: async () => {
      setInviteEmail("");
      setInviteListChoice(INVITE_LIST_NONE);
      await queryClient.invalidateQueries({ queryKey: ["pending-invites", uid] });
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: async (inviteId: string) => {
      const token = await getIdTokenForApi();
      if (!token) throw new Error("Not signed in");
      const res = await fetch("/api/invites", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inviteId }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to revoke");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["pending-invites", uid] });
    },
  });

  const inviteListOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: INVITE_LIST_NONE, label: "None" }];
    for (const l of sharedLists) {
      opts.push({
        value: l.id,
        label: displayListName(l.name) || "Shared list",
      });
    }
    return opts;
  }, [sharedLists]);

  function listLabelForInvite(listId: string | null): string {
    if (!listId) return "(app only)";
    const hit = sharedLists.find((l) => l.id === listId);
    return hit ? displayListName(hit.name) || "Shared list" : listId;
  }

  function resolveInviteListId(): string | null {
    const v = inviteListChoice.trim();
    if (!v || v === INVITE_LIST_NONE) return null;
    return v;
  }

  return (
    <>
      {open ? (
        <Dialog
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) onClose();
          }}
        >
          <DialogContent
            className="lists-modal z-[1201] max-h-[85vh] overflow-y-auto bg-[#131317] text-[#f0ede8] sm:max-w-[520px]"
            id="lists-modal"
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              onClose();
            }}
          >
            <DialogHeader className="modal-header">
              <DialogTitle className="modal-title font-title tracking-widest">Manage lists</DialogTitle>
              <DialogDescription className="sr-only">
                Manage personal and shared lists, invite people by email, or create new lists.
              </DialogDescription>
            </DialogHeader>
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
                          <Input
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
                                await renamePersonalList(currentUser.uid, l.id, newName);
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
                        <Button
                          type="button"
                          variant="ghost"
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
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
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
                        </Button>
                      </div>
                    </li>
                  ))}
                  {sharedLists.map((l) => {
                    const isOwner = !!(l.ownerId && String(l.ownerId) === String(currentUser.uid));
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
                            <Input
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
                          <Button
                            type="button"
                            variant="ghost"
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
                          </Button>
                          {isOwner ? (
                            <Button
                              type="button"
                              variant="destructive"
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
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
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
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="lists-modal-create-buttons">
                  <Button
                    type="button"
                    variant="outline"
                    className="lists-modal-new-personal"
                    id="lists-new-personal-btn"
                    onClick={() => setListNameKind("personal")}
                  >
                    + New personal list
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="lists-modal-btn"
                    id="lists-create-btn"
                    onClick={() => setListNameKind("shared")}
                  >
                    + Create new shared list
                  </Button>
                </div>
              </section>

              <section className="lists-modal-section lists-modal-section--divider">
                <h3 className="lists-modal-section-title">Invite someone</h3>
                <div className="lists-modal-invite-form flex flex-col gap-3">
                  <div>
                    <label className="lists-modal-list-item-label" htmlFor="invite-email-input">
                      Email
                    </label>
                    <Input
                      id="invite-email-input"
                      type="email"
                      className="lists-modal-input mt-1"
                      placeholder="friend@example.com"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="lists-modal-list-item-label" htmlFor="invite-list-select">
                      Include list
                    </label>
                    <Select value={inviteListChoice} onValueChange={setInviteListChoice}>
                      <SelectTrigger
                        id="invite-list-select"
                        className="lists-modal-select-trigger mt-1 w-full border border-[var(--border)] bg-[#1c1c22] text-[#f0ede8]"
                      >
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent className="border border-[var(--border)] bg-[#1c1c22] text-[#f0ede8]">
                        {inviteListOptions.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="lists-modal-description mt-1 text-xs opacity-80">
                      Optional — invite them to the app only, or also add them to a shared list you belong to.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="lists-modal-btn"
                    disabled={sendInviteMutation.isPending}
                    onClick={() => {
                      const em = inviteEmail.trim();
                      if (!em) {
                        window.alert("Enter an email address.");
                        return;
                      }
                      const listId = resolveInviteListId();
                      sendInviteMutation.mutate(
                        { invitedEmail: em, listId },
                        {
                          onError: (err: Error) => window.alert(err.message || "Failed to send invite"),
                          onSuccess: () => window.alert("Invitation sent."),
                        }
                      );
                    }}
                  >
                    {sendInviteMutation.isPending ? "Sending…" : "Send invite"}
                  </Button>
                </div>

                <h4 className="lists-modal-section-subtitle mt-6 font-title text-sm uppercase tracking-widest text-[var(--muted)]">
                  Pending invites
                </h4>
                {invitesQ.isLoading ? (
                  <p className="lists-modal-description">Loading…</p>
                ) : invitesQ.isError ? (
                  <p className="lists-modal-description text-[#e85a5a]">{errorMessage(invitesQ.error)}</p>
                ) : !invitesQ.data?.length ? (
                  <p className="lists-modal-description">No pending invites.</p>
                ) : (
                  <ul className="lists-modal-list mt-2">
                    {invitesQ.data.map((inv) => (
                      <li key={inv.inviteId} className="lists-modal-list-item">
                        <span className="lists-modal-list-item-name min-w-0 flex-1">
                          <span className="lists-modal-list-item-name-text break-all text-sm">
                            {inv.invitedEmail} → {listLabelForInvite(inv.listId)}
                          </span>
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          className="lists-modal-list-item-action shrink-0"
                          disabled={revokeInviteMutation.isPending}
                          onClick={() =>
                            revokeInviteMutation.mutate(inv.inviteId, {
                              onError: (e: Error) => window.alert(e.message || "Revoke failed"),
                            })
                          }
                        >
                          Revoke
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}

      <ListNameModal
        open={listNameKind != null}
        elevatedStack
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
              const listId = await createPersonalList(currentUser.uid, name);
              const mode = { type: "personal", listId, name };
              setCurrentListMode(mode);
              saveLastList(currentUser, mode);
              await refreshListsAndCookie();
            } else {
              const listId = await createSharedList(currentUser.uid, name);
              const mode = { type: "shared", listId, name };
              setCurrentListMode(mode);
              saveLastList(currentUser, mode);
              await refreshListsAndCookie();
              setShareUrl(`${window.location.origin}/join/${listId}`);
            }
          } catch (err: unknown) {
            window.alert(`Failed to create: ${errorMessage(err)}`);
          }
        }}
      />

      <DeleteConfirmModal
        elevatedStack
        open={deleteTarget != null}
        title={deleteTarget?.isLeave ? "Leave list?" : "Delete list?"}
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
              await leaveSharedList(currentUser.uid, t.id);
            } else if (t.type === "personal") {
              await deletePersonalList(currentUser.uid, t.id);
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
        elevatedStack
        open={shareUrl != null}
        shareUrl={shareUrl || ""}
        onClose={() => setShareUrl(null)}
      />
    </>
  );
}
