"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { LoadingButton } from "@/components/loading-button";

export default function AdminLoginPage() {
  const router = useRouter();
  const [returnTo, setReturnTo] = useState("/admin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("returnTo");
    if (requested?.startsWith("/")) setReturnTo(requested);
  }, []);

  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter key and button can fire together: the ref closes the gap before the state re-renders.
    if (submitting.current) return;
    submitting.current = true;
    setError("");
    setLoading(true);
    let signedIn = false;
    try {
      const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to sign in");
      signedIn = true;
      router.replace(returnTo);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in");
    } finally {
      // After a successful sign-in the button stays busy while the dashboard loads (restored if it never does).
      if (signedIn) setTimeout(() => { submitting.current = false; setLoading(false); }, 8000);
      else { submitting.current = false; setLoading(false); }
    }
  }

  const [show, setShow] = useState(false);
  const input = "mt-2 block w-full rounded-xl border border-[#e4e7ee] bg-[#fafbfc] px-4 py-3.5 text-sm font-semibold text-[#182443] outline-none transition placeholder:font-medium placeholder:text-[#a6abb8] focus:border-[#182443] focus:bg-white focus:ring-4 focus:ring-[#182443]/10";

  return <main className="grid min-h-screen bg-[#fffaf5] lg:grid-cols-[1.05fr_1fr]">
    <aside className="relative hidden overflow-hidden bg-[#182443] p-12 text-white lg:flex lg:flex-col lg:justify-between">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#ee5264]/20 blur-3xl" />
      <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-[#f6c667]/15 blur-3xl" />
      <Link href="/" className="relative flex w-fit items-center gap-3"><img src="/images/logo.png" alt="Celebra Momentos" className="h-12 w-12 rounded-full bg-white object-contain p-0.5" /><span className="text-sm font-black leading-tight">Celebra Momentos<br /><span className="text-[#f6c667]">Admin</span></span></Link>
      <div className="relative max-w-md">
        <p className="text-[10px] font-black uppercase tracking-[.22em] text-[#f6c667]">Private workspace</p>
        <h2 className="mt-4 text-4xl font-black leading-[1.1] tracking-[-.04em]">Run your store with clarity.</h2>
        <p className="mt-5 text-sm leading-7 text-white/70">Products, orders, print fulfillment and customers, all managed in one place.</p>
        <ul className="mt-8 space-y-3 text-sm font-bold text-white/85">{["Orders and print fulfillment", "Products and catalog", "Customers and content"].map((item) => <li key={item} className="flex items-center gap-3"><span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#f6c667] text-[#182443]"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg></span>{item}</li>)}</ul>
      </div>
      <p className="relative text-xs text-white/40">© {new Date().getFullYear()} Celebra Momentos · Authorized staff only</p>
    </aside>
    <section className="flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-[420px]">
        <Link href="/" className="mx-auto mb-8 flex w-fit items-center gap-3 lg:hidden"><img src="/images/logo.png" alt="Celebra Momentos" className="h-11 w-11 rounded-full object-contain" /><span className="text-sm font-black leading-tight text-[#182443]">Celebra<br /><span className="text-[#ee5264]">Admin</span></span></Link>
        <div className="rounded-[28px] border border-[#eadbd3] bg-white p-7 shadow-[0_24px_70px_rgba(24,36,67,.10)] sm:p-9">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#fff0e8] text-[#ee5264]"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg></span>
          <h1 className="mt-5 text-3xl font-black tracking-[-.04em] text-[#182443]">Welcome back</h1>
          <p className="mt-2 text-sm leading-6 text-[#737b90]">Sign in to manage products, orders and website content.</p>
          <form onSubmit={submit} className="mt-7 space-y-5">
            <label className="block text-xs font-black uppercase tracking-[.1em] text-[#59627b]">Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className={input} autoComplete="username" placeholder="admin@example.com" /></label>
            <label className="block text-xs font-black uppercase tracking-[.1em] text-[#59627b]">Password<span className="relative mt-2 block"><input required type={show ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} className={`${input} !mt-0 pr-20`} autoComplete="current-password" placeholder="Your admin password" /><button type="button" onClick={() => setShow((value) => !value)} aria-label={show ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full px-3 py-1.5 text-[11px] font-black normal-case tracking-normal text-[#737b90] transition hover:bg-[#eef0f4] hover:text-[#182443]">{show ? "Hide" : "Show"}</button></span></label>
            {error && <p role="alert" className="rounded-xl border border-[#f3c6c2] bg-[#fff0e8] px-4 py-3 text-xs font-bold text-[#c94758]">{error}</p>}
            <LoadingButton type="submit" loading={loading} loadingLabel="Signing in…" className="flex w-full items-center justify-center gap-2 rounded-full bg-[#182443] px-5 py-4 text-sm font-black text-white shadow-[0_10px_24px_rgba(24,36,67,.25)] transition hover:bg-[#ee5264] hover:shadow-[0_10px_24px_rgba(238,82,100,.3)] disabled:cursor-wait disabled:opacity-60">Sign in<Icon name="arrow" size={16} /></LoadingButton>
          </form>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-[11px] font-bold text-[#9297a4]"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>Secure, encrypted sign-in</p>
        </div>
        <Link href="/" className="mt-6 block text-center text-xs font-bold text-[#737b90] hover:text-[#ee5264]">← Back to storefront</Link>
      </div>
    </section>
  </main>;
}
