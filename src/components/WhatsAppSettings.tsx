import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { displayListName } from "../lib/utils.js";
import { useAppStore } from "../store/useAppStore.js";
import type { ListMode, PersonalList, SharedList } from "../types/index.js";
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
      const { defaultAddListId, defaultListType } = await resolveWhatsAppListPayload(uid, connectListChoice);
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
        throw new Error(data.error === "invalid_code" ? "Invalid or expired code." : "Verification failed.");
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="modal max-w-md bg-[#131317] border-white/10 text-[#f0ede8]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-lg tracking-tight">WhatsApp integration</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <p className="text-white/70">
            Send an IMDb link from WhatsApp to add titles to your chosen list. Numbers must be verified once.
          </p>

          {error ? <p className="text-red-400 text-sm">{error}</p> : null}

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-white/50 mb-2">
              Connected numbers
            </h3>
            {loading ? (
              <p className="text-white/50">Loading…</p>
            ) : phones.length === 0 ? (
              <p className="text-white/50">No numbers linked yet.</p>
            ) : (
              <ul className="space-y-3">
                {phones.map((p) => (
                  <li
                    key={p}
                    className="flex flex-col gap-2 rounded-lg border border-white/10 bg-black/20 p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="font-medium tabular-nums">{formatPhoneDisplay(p)}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={rowChoices[p] || "p:personal"}
                        onValueChange={(v) => void onRowListChange(p, v)}
                      >
                        <SelectTrigger className="w-[min(100%,220px)] border-white/15 bg-black/30 text-[#f0ede8]">
                          <SelectValue placeholder="Default list" />
                        </SelectTrigger>
                        <SelectContent className="z-[1300]">
                          {listOptions.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="border-white/20 text-[#f0ede8]"
                        onClick={() => void onRemove(p)}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!connectOpen ? (
            <Button
              type="button"
              variant="secondary"
              className="w-full"
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
            </Button>
          ) : (
            <div className="rounded-lg border border-white/10 bg-black/25 p-3 space-y-3">
              {!awaitingCode ? (
                <>
                  <div>
                    <label className="block text-xs text-white/50 mb-1">Phone (E.164)</label>
                    <Input
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="+972501234567"
                      className="border-white/15 bg-black/30 text-[#f0ede8]"
                      autoComplete="tel"
                    />
                    <p className="text-xs text-white/45 mt-1">
                      Include country code; spaces are optional. Example: +1 650 555 0100
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-white/50 mb-1">Default list for adds</label>
                    <Select value={connectListChoice} onValueChange={setConnectListChoice}>
                      <SelectTrigger className="w-full border-white/15 bg-black/30 text-[#f0ede8]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="z-[1300]">
                        {listOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" className="flex-1" onClick={() => void sendCode()}>
                      Send verification code
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setConnectOpen(false);
                        setAwaitingCode(false);
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-white/80">Enter the 6-digit code sent to your WhatsApp.</p>
                  <Input
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    placeholder="000000"
                    className="border-white/15 bg-black/30 text-[#f0ede8] tracking-widest"
                    inputMode="numeric"
                  />
                  <div className="flex gap-2">
                    <Button type="button" className="flex-1" onClick={() => void verifyCode()}>
                      Verify
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setAwaitingCode(false);
                        setCodeInput("");
                      }}
                    >
                      Back
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
