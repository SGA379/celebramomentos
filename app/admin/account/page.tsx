"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminPageHeader, AdminShell } from "@/components/admin";
import { BrandLoader } from "@/components/loading";
import { Icon } from "@/components/icons";

const field = "mt-2 block w-full rounded-xl border border-[#e4e7ee] bg-[#fafbfc] px-4 py-3 text-sm font-semibold text-[#182443] outline-none focus:border-[#182443] focus:bg-white focus:ring-4 focus:ring-[#182443]/10";
type Account = { id: string; name: string; email: string; createdAt: string; updatedAt: string };

function PasswordField({ label, value, onChange, visible, onToggle, minLength, autoComplete }: { label: string; value: string; onChange: (event: ChangeEvent<HTMLInputElement>) => void; visible: boolean; onToggle: () => void; minLength?: number; autoComplete: string }) {
  return <label className="block text-sm font-black">{label}<span className="relative mt-2 block"><input required type={visible ? "text" : "password"} value={value} minLength={minLength} onChange={onChange} autoComplete={autoComplete} className={`${field} !mt-0 pr-12`} /><button type="button" onClick={onToggle} aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-[#737b90] hover:bg-[#eef0f4] hover:text-[#182443]"><Icon name={visible ? "eyeOff" : "eye"} size={18} /></button></span></label>;
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return body.error || "Unable to complete this action";
}

export default function AdminAccountPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [profile, setProfile] = useState({ name: "", email: "", currentPassword: "" });
  const [password, setPassword] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [loading, setLoading] = useState(true);
  const [savingAction, setSavingAction] = useState<"profile" | "password" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showProfileCurrent, setShowProfileCurrent] = useState(false);
  const [showPasswordCurrent, setShowPasswordCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    void fetch("/api/admin/profile", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const value = (await response.json()).admin as Account;
      setAccount(value);
      setProfile({ name: value.name, email: value.email, currentPassword: "" });
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to load account")).finally(() => setLoading(false));
  }, []);

  const updateProfile = async (event: FormEvent) => {
    event.preventDefault(); setSavingAction("profile"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "update-profile", ...profile }) });
      if (!response.ok) throw new Error(await responseError(response));
      const value = (await response.json()).admin as Account;
      setAccount(value); setProfile({ name: value.name, email: value.email, currentPassword: "" }); window.dispatchEvent(new CustomEvent("admin-profile-updated", { detail: value })); setNotice("Profile updated."); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update profile"); }
    finally { setSavingAction(null); }
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setSavingAction("password"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "change-password", ...password }) });
      if (!response.ok) throw new Error(await responseError(response));
      router.replace("/admin/login?changed=password&returnTo=/admin/account");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to change password"); setSavingAction(null); }
  };

  return <AdminShell><AdminPageHeader eyebrow="ACCOUNT" title="Account settings" body="Manage the single administrator account stored in the database." />{loading ? <section className="mt-8 max-w-[980px] rounded-2xl border border-[#e4e7ee] bg-white"><BrandLoader label="Loading account…" /></section> : <div className="mt-8 max-w-[980px] space-y-6">{error && <p role="alert" className="rounded-xl border border-[#f3c6c2] bg-[#fff0e8] p-4 text-sm font-bold text-[#c94758]">{error}</p>}{notice && <p role="status" className="rounded-xl border border-[#cde5d5] bg-[#effaf1] p-4 text-sm font-bold text-[#277046]">{notice}</p>}<div className="grid gap-6 lg:grid-cols-2"><form onSubmit={updateProfile} className="rounded-2xl border border-[#e4e7ee] bg-white p-6 sm:p-8"><h2 className="text-lg font-black">Admin profile</h2><p className="mt-1 text-sm text-[#737b90]">These values come directly from the authenticated database account.</p><label className="mt-5 block text-sm font-black">Name<input required value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} className={field} /></label><label className="mt-4 block text-sm font-black">Email<input required type="email" maxLength={160} autoComplete="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} className={field} /></label><PasswordField label="Current password" value={profile.currentPassword} onChange={(event) => setProfile({ ...profile, currentPassword: event.target.value })} visible={showProfileCurrent} onToggle={() => setShowProfileCurrent((value) => !value)} autoComplete="current-password" /><button disabled={savingAction !== null} aria-busy={savingAction === "profile"} className="mt-5 rounded-full bg-[#182443] px-5 py-3 text-sm font-black text-white disabled:opacity-60">{savingAction === "profile" ? "Saving…" : "Update profile"}</button></form><form onSubmit={changePassword} className="rounded-2xl border border-[#e4e7ee] bg-white p-6 sm:p-8"><h2 className="text-lg font-black">Security</h2><p className="mt-1 text-sm text-[#737b90]">Use at least 12 characters. You will sign in again after changing your password.</p><div className="mt-5"><PasswordField label="Current password" value={password.currentPassword} onChange={(event) => setPassword({ ...password, currentPassword: event.target.value })} visible={showPasswordCurrent} onToggle={() => setShowPasswordCurrent((value) => !value)} autoComplete="current-password" /></div><div className="mt-4"><PasswordField label="New password" value={password.newPassword} minLength={12} onChange={(event) => setPassword({ ...password, newPassword: event.target.value })} visible={showNew} onToggle={() => setShowNew((value) => !value)} autoComplete="new-password" /></div><div className="mt-4"><PasswordField label="Confirm new password" value={password.confirmPassword} minLength={12} onChange={(event) => setPassword({ ...password, confirmPassword: event.target.value })} visible={showConfirm} onToggle={() => setShowConfirm((value) => !value)} autoComplete="new-password" /></div><button disabled={savingAction !== null} aria-busy={savingAction === "password"} className="mt-5 rounded-full bg-[#182443] px-5 py-3 text-sm font-black text-white disabled:opacity-60">{savingAction === "password" ? "Saving…" : "Change password"}</button></form></div>{account && <div className="text-xs font-semibold text-[#9297a4]"><p>Signed in as {account.name} · {account.email}</p><p className="mt-1">Created {new Date(account.createdAt).toLocaleString()} · Updated {new Date(account.updatedAt).toLocaleString()}</p></div>}</div>}</AdminShell>;
}
