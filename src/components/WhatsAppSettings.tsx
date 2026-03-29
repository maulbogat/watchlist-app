import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { displayListName } from "../lib/utils.js";
import { useAppStore } from "../store/useAppStore.js";
import type { ListMode, PersonalList, SharedList } from "../types/index.js";
import { VisuallyHidden } from "radix-ui";
import {
  auth,
  getPhoneIndexDefaultsForNumber,
  getUserPhoneNumbers,
  removeUserPhoneNumber,
  resolveWhatsAppListPayload,
  setWhatsAppDefaultListForPhone,
  whatsappListChoiceKeyForTargets,
} from "../firebase.js";

function formatPhoneDisplay(digits: string): string {
  const d = String(digits || "").replace(/\D/g, "");
  if (!d) return "";
  return `+${d}`;
}

const waSelectContentClass =
  "lists-modal-select-popover--no-check z-[5000] border border-white/10 bg-[#1c1c22] text-[#f0ede8] [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";

function listModeToChoiceKey(mode: ListMode): string {
  if (mode === "personal") return "p:personal";
  if (typeof mode === "object" && mode.type === "personal") return `p:${mode.listId}`;
  if (typeof mode === "object" && mode.type === "shared") return `s:${mode.listId}`;
  return "p:personal";
}

interface WhatsAppSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  uid: string;
  personalLists: PersonalList[];
  sharedLists: SharedList[];
}

export function WhatsAppSettings({
  open,
  onOpenChange,
  uid,
  personalLists,
  sharedLists,
}: WhatsAppSettingsProps) {
  const currentListMode = useAppStore((s) => s.currentListMode);

  const [phones, setPhones] = useState<string[]>([]);
  const [rowChoices, setRowChoices] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [connectOpen, setConnectOpen] = useState(false);
  const [phoneInput, setPhoneInput] = useState("");
  const [connectListChoice, setConnectListChoice] = useState("p:personal");
  const [codeInput, setCodeInput] = useState("");
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [pendingPhoneDigits, setPendingPhoneDigits] = useState("");

  const listOptions = useMemo(() => {
    const o: { value: string; label: string }[] = [];
    for (const pl of personalLists) {
      o.push({
        value: `p:${pl.id}`,
        label: displayListName(pl.name) || "Personal list",
      });
    }
    for (const sl of sharedLists) {
      o.push({
        value: `s:${sl.id}`,
        label: displayListName(sl.name) || "Shared list",
      });
    }
    return o;
  }, [personalLists, sharedLists]);

  const loadPhonesAndChoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getUserPhoneNumbers(uid);
      setPhones(list);
      const next: Record<string, string> = {};
      await Promise.all(
        list.map(async (p) => {
          const row = await getPhoneIndexDefaultsForNumber(uid, p);
          if (!row) {
            next[p] = "p:personal";
            return;
          }
          next[p] = await whatsappListChoiceKeyForTargets(
            uid,
            row.defaultAddListId,
            row.defaultListType,
            personalLists,
            sharedLists
          );
        })
      );
      setRowChoices(next);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not load linked numbers.");
    } finally {
      setLoading(false);
    }
  }, [uid, personalLists, sharedLists]);

  useEffect(() => {
    if (!open) return;
    void loadPhonesAndChoices();
  }, [open, loadPhonesAndChoices]);

  useEffect(() => {
    if (!open || !connectOpen) return;
    setConnectListChoice(listModeToChoiceKey(currentListMode));
  }, [open, connectOpen, currentListMode]);

  async function getBearer(): Promise<string> {
    const u = auth.currentUser;
    if (!u) throw new Error("Sign in required.");
    return u.getIdToken();
  }

  async function sendCode() {
    setError(null);
    const digits = phoneInput.replace(/\D/g, "");
    if (digits.length < 8) {
      setError("Enter a full number in E.164 form (e.g. +972501234567).");
      return;
    }
    try {
      const token = await getBearer();
      const { defaultAddListId, defaultListType } = await resolveWhatsAppListPayload(
        uid,
        connectListChoice
      );
      const res = await fetch("/api/whatsapp-verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          phone: digits,
          defaultAddListId,
          defaultListType,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      setPendingPhoneDigits(digits);
      setAwaitingCode(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not send code.");
    }
  }

  async function verifyCode() {
    setError(null);
    const code = codeInput.replace(/\D/g, "").slice(0, 6);
    if (code.length !== 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    try {
      const token = await getBearer();
      const res = await fetch("/api/whatsapp-verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          phone: pendingPhoneDigits || phoneInput.replace(/\D/g, ""),
          code,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        verified?: boolean;
        error?: string;
      };
      if (!data.ok || !data.verified) {
        throw new Error(
          data.error === "invalid_code" ? "Invalid or expired code." : "Verification failed."
        );
      }
      setConnectOpen(false);
      setAwaitingCode(false);
      setCodeInput("");
      setPhoneInput("");
      setPendingPhoneDigits("");
      await loadPhonesAndChoices();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Verification failed.");
    }
  }

  async function onRemove(phoneDigits: string) {
    if (!window.confirm("Remove this number from WhatsApp watchlist adds?")) return;
    setError(null);
    try {
      await removeUserPhoneNumber(uid, phoneDigits);
      await loadPhonesAndChoices();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not remove.");
    }
  }

  async function onRowListChange(phoneDigits: string, choice: string) {
    setRowChoices((prev) => ({ ...prev, [phoneDigits]: choice }));
    setError(null);
    try {
      const { defaultAddListId, defaultListType } = await resolveWhatsAppListPayload(uid, choice);
      await setWhatsAppDefaultListForPhone(uid, phoneDigits, defaultAddListId, defaultListType);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not update default list.");
      await loadPhonesAndChoices();
    }
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
            className="lists-modal z-[1201] max-h-[85vh] overflow-y-auto bg-[#131317] text-[#f0ede8] sm:max-w-[520px]"
            id="whatsapp-settings-modal"
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              onOpenChange(false);
            }}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <DialogHeader className="modal-header">
              <DialogTitle className="modal-title font-title tracking-widest">
                WhatsApp integration
              </DialogTitle>
              <DialogDescription asChild>
                <VisuallyHidden.Root>
                  Connect a phone number to add watchlist titles by sending IMDb links on WhatsApp.
                </VisuallyHidden.Root>
              </DialogDescription>
            </DialogHeader>

            <div className="lists-modal-body">
              <p className="lists-modal-description">
                Send an IMDb link from WhatsApp to add titles to your chosen list. Numbers must be
                verified once.
              </p>

              {error ? (
                <p className="lists-modal-description text-[#e85a5a]" role="alert">
                  {error}
                </p>
              ) : null}

              <section className="lists-modal-section">
                <h3 className="lists-modal-section-title">Connected numbers</h3>
                {loading ? (
                  <p className="lists-modal-description">Loading…</p>
                ) : phones.length === 0 ? (
                  <p className="lists-modal-description">No numbers linked yet.</p>
                ) : (
                  <ul className="lists-modal-list">
                    {phones.map((p) => (
                      <li key={p} className="lists-modal-list-item">
                        <span className="lists-modal-list-item-name min-w-0 flex-1">
                          <span className="lists-modal-list-item-name-text tabular-nums">
                            {formatPhoneDisplay(p)}
                          </span>
                        </span>
                        <div className="lists-modal-list-item-actions lists-modal-wa-row-actions">
                          <Select
                            value={rowChoices[p] || "p:personal"}
                            onValueChange={(v) => void onRowListChange(p, v)}
                          >
                            <SelectTrigger className="lists-modal-select-trigger w-[min(100%,260px)] min-w-0 focus-visible:ring-0">
                              <SelectValue placeholder="Default list" />
                            </SelectTrigger>
                            <SelectContent
                              position="popper"
                              sideOffset={6}
                              collisionPadding={16}
                              className={waSelectContentClass}
                            >
                              {listOptions.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <button
                            type="button"
                            className="lists-modal-list-item-action lists-modal-list-item-action--delete"
                            aria-label={`Remove ${formatPhoneDisplay(p)}`}
                            onClick={() => void onRemove(p)}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {!connectOpen ? (
                <div className="lists-modal-create-buttons lists-modal-create-buttons--full">
                  <button
                    type="button"
                    className="lists-modal-new-personal"
                    onClick={() => {
                      setConnectOpen(true);
                      setAwaitingCode(false);
                      setCodeInput("");
                      setPhoneInput("");
                      setPendingPhoneDigits("");
                      setError(null);
                    }}
                  >
                    + Connect a number
                  </button>
                </div>
              ) : (
                <section className="lists-modal-section">
                  <h3 className="lists-modal-section-title">
                    {!awaitingCode ? "Link a number" : "Enter code"}
                  </h3>
                  {!awaitingCode ? (
                    <>
                      <div className="flex flex-col gap-5">
                        <div>
                          <label
                            className="lists-modal-list-item-label"
                            htmlFor="whatsapp-phone-input"
                          >
                            Phone (E.164)
                          </label>
                          <Input
                            id="whatsapp-phone-input"
                            value={phoneInput}
                            onChange={(e) => setPhoneInput(e.target.value)}
                            placeholder="+972501234567"
                            className="lists-modal-input mt-1.5 focus-visible:ring-0"
                            autoComplete="tel"
                          />
                          <div className="lists-modal-description mt-2.5 space-y-1.5 leading-relaxed">
                            <p className="mb-0">Include country code; spaces are optional.</p>
                            <p className="mb-0">Example: +1 650 555 0100</p>
                          </div>
                        </div>
                        <div>
                          <label
                            className="lists-modal-list-item-label"
                            htmlFor="whatsapp-list-select"
                          >
                            Default list for adds
                          </label>
                          <Select value={connectListChoice} onValueChange={setConnectListChoice}>
                            <SelectTrigger
                              id="whatsapp-list-select"
                              className="lists-modal-select-trigger mt-1.5 w-full min-w-0 focus-visible:ring-0"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent
                              position="popper"
                              sideOffset={6}
                              collisionPadding={16}
                              className={waSelectContentClass}
                            >
                              {listOptions.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="lists-modal-actions-row pt-1">
                          <button
                            type="button"
                            className="lists-modal-btn"
                            onClick={() => void sendCode()}
                          >
                            Send verification code
                          </button>
                          <button
                            type="button"
                            className="lists-modal-list-item-leave"
                            onClick={() => {
                              setConnectOpen(false);
                              setAwaitingCode(false);
                              setError(null);
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="lists-modal-description">
                        Enter the 6-digit code sent to your WhatsApp.
                      </p>
                      <Input
                        id="whatsapp-code-input"
                        value={codeInput}
                        onChange={(e) =>
                          setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))
                        }
                        placeholder="000000"
                        className="lists-modal-input mt-2 tracking-widest focus-visible:ring-0"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                      />
                      <div className="lists-modal-actions-row">
                        <button
                          type="button"
                          className="lists-modal-btn"
                          onClick={() => void verifyCode()}
                        >
                          Verify
                        </button>
                        <button
                          type="button"
                          className="lists-modal-list-item-leave"
                          onClick={() => {
                            setAwaitingCode(false);
                            setCodeInput("");
                          }}
                        >
                          Back
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
