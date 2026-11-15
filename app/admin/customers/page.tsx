"use client";

import { useEffect, useState } from "react";
import { AdminPageHeader, AdminShell } from "@/components/admin";
import { BrandLoader } from "@/components/loading";
import { StatusBadge, Toast } from "@/components/site";
import { LoadingButton } from "@/components/loading-button";

type Customer = { id: string; name: string; email: string; orders: number; createdAt: string };

const initials = (name: string, email: string) => (name || email).trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "?";
const joined = (value: string) => (value && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");

export default function AdminCustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");

  const load = async () => {
    const response = await fetch("/api/admin/customers", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Unable to load customers");
    setCustomers(body.customers || []);
  };
  const reload = () => { setLoaded(false); setLoadFailed(false); void load().catch((reason) => { setToast(reason instanceof Error ? reason.message : "Unable to load customers"); setLoadFailed(true); }).finally(() => setLoaded(true)); };
  // Loaded once when the page opens (and again from Retry).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, []);

  const remove = async (customer: Customer) => {
    if (!window.confirm(`Delete customer ${customer.name}?`)) return;
    const response = await fetch(`/api/admin/customers?id=${customer.id}`, { method: "DELETE" });
    if (!response.ok) { const body = await response.json(); setToast(body.error || "Unable to delete customer"); return; }
    await load();
    setToast("Customer deleted");
  };

  const filtered = customers.filter((customer) => `${customer.name} ${customer.email}`.toLowerCase().includes(query.toLowerCase()));

  return <AdminShell>
    <AdminPageHeader eyebrow="RELATIONSHIPS" title="Customers" body="Review customer accounts stored in the database." action={<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customers" aria-label="Search customers" className="w-full rounded-full border border-[#e4e7ee] bg-white px-4 py-2.5 text-xs outline-none transition focus:border-[#182443] md:w-64" />} />
    <section className="mt-8 overflow-hidden rounded-2xl border border-[#e4e7ee] bg-white">
      <div className="border-b border-[#e4e7ee] p-5 text-sm font-black">{loaded && !loadFailed ? `${filtered.length} customers` : "Customers"}</div>
      {!loaded ? <BrandLoader compact label="Loading customers…" />
        : loadFailed ? <div role="alert" className="p-12 text-center"><p className="font-black text-[#c94758]">Unable to load customers</p><button type="button" onClick={reload} className="mt-3 rounded-full border border-[#dfd3cc] px-4 py-2 text-xs font-black">Retry</button></div>
        : filtered.length === 0 ? <p className="p-12 text-center text-sm font-black text-[#737b90]">{query ? "No customers match your search" : "No customers yet"}</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left">
          <thead><tr className="border-b border-[#e4e7ee] bg-[#fafbfc] text-[10px] uppercase tracking-[.14em] text-[#9297a4]"><th className="px-5 py-3">Customer</th><th className="px-5 py-3">Orders</th><th className="px-5 py-3">Joined</th><th className="px-5 py-3">Status</th><th className="px-5 py-3 text-right">Actions</th></tr></thead>
          <tbody>{filtered.map((customer) => <tr key={customer.id} className="border-b border-[#eef0f4] text-sm transition hover:bg-[#fafbfc]">
            <td className="px-5 py-4"><div className="flex items-center gap-3">
              <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#182443] text-xs font-black text-[#f6c667]">{initials(customer.name, customer.email)}</span>
              <span className="min-w-0"><span className="block truncate font-black">{customer.name}</span><span className="block truncate text-xs text-[#737b90]">{customer.email}</span></span>
            </div></td>
            <td className="px-5 py-4"><span className={`inline-flex min-w-[2rem] justify-center rounded-full px-2.5 py-1 text-xs font-black ${customer.orders > 0 ? "bg-[#fff0e8] text-[#c94758]" : "bg-[#eef0f4] text-[#9297a4]"}`}>{customer.orders}</span></td>
            <td className="whitespace-nowrap px-5 py-4 text-xs text-[#59627b]">{joined(customer.createdAt)}</td>
            <td className="whitespace-nowrap px-5 py-4"><StatusBadge tone="green">Active</StatusBadge></td>
            <td className="px-5 py-4"><div className="flex justify-end"><LoadingButton onClick={() => remove(customer)} loadingLabel="Deleting…" className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#f3c6c2] px-3.5 py-1.5 text-xs font-black text-[#c94758] transition hover:bg-[#fff0e8] disabled:cursor-wait disabled:opacity-60">Delete</LoadingButton></div></td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    {toast && <Toast message={toast} onClose={() => setToast("")} />}
  </AdminShell>;
}
