"use client";

// Small building blocks shared by the admin pages (orders, products, print orders): a details modal, print
// shop badges, image thumbnails and table rows that open a record when clicked.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { podProviderLabel } from "@/lib/products";

// A details dialog: centred on wide screens, a full-width sheet on phones. Its body scrolls; Escape, the
// backdrop and the Close button close it. The page behind does not scroll while it is open.
export function AdminModal({ eyebrow, title, subtitle, onClose, children, wide = true }: { eyebrow: string; title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") close.current(); };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; };
  }, []);
  return <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
    <button type="button" tabIndex={-1} className="absolute inset-0 bg-[#182443]/30" onClick={onClose} aria-label="Close" />
    <section role="dialog" aria-modal="true" aria-labelledby={titleId} className={`relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-[24px] bg-white shadow-2xl sm:rounded-[24px] ${wide ? "max-w-[920px]" : "max-w-[560px]"}`}>
      <header className="flex items-start justify-between gap-4 border-b border-[#eef0f4] px-5 py-4 sm:px-7 sm:py-5">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-widest text-[#ee5264]">{eyebrow}</p>
          <h2 id={titleId} className="mt-1 break-words text-xl font-black sm:text-2xl">{title}</h2>
          {subtitle && <div className="mt-1 text-xs text-[#737b90]">{subtitle}</div>}
        </div>
        <button ref={closeRef} type="button" onClick={onClose} className="shrink-0 rounded-full border border-[#e4e7ee] px-3 py-1.5 text-xs font-black text-[#59627b] hover:border-[#182443]">Close</button>
      </header>
      <div className="overflow-y-auto overscroll-contain px-5 py-5 sm:px-7 sm:py-6">{children}</div>
    </section>
  </div>;
}

// Props for a table row that opens its record: click, or Enter / Space when the row has focus. Buttons and
// links inside the row keep working on their own (wrap them in stopRowClick).
export function clickableRow(onOpen: () => void) {
  return {
    onClick: onOpen,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      onOpen();
    },
    tabIndex: 0,
  };
}

// For a cell holding its own actions: clicks and key presses there never open the row.
export const stopRowClick = { onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(), onKeyDown: (event: { stopPropagation: () => void }) => event.stopPropagation() };

const PROVIDER_TONE: Record<string, string> = {
  PRODIGI: "bg-[#eaf0ff] text-[#3451a3]",
  PRINTFUL: "bg-[#fff0e8] text-[#c94758]",
  GELATO: "bg-[#e8f5ed] text-[#24714b]",
  PRINTEERS: "bg-[#f2ecff] text-[#6b3fb0]",
};

// The print shops of a record as badges; "Not Assigned" when there is none.
export function ProviderBadges({ providers }: { providers: (string | null | undefined)[] }) {
  const list = Array.from(new Set(providers.filter((value): value is string => Boolean(value))));
  if (!list.length) return <span className="inline-flex whitespace-nowrap rounded-full bg-[#eef0f4] px-2.5 py-1 text-[10px] font-black text-[#9297a4]">Not Assigned</span>;
  return <span className="inline-flex flex-wrap gap-1">{list.map((provider) => <span key={provider} className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-[10px] font-black ${PROVIDER_TONE[provider] || "bg-[#eef0f4] text-[#59627b]"}`}>{podProviderLabel(provider)}</span>)}</span>;
}

// The choices a customer made (size, colour, model…) as small labels.
export function OptionChips({ options }: { options: { name: string; value: string }[] }) {
  if (!options.length) return null;
  return <span className="flex flex-wrap gap-1.5">{options.map((option) => <span key={`${option.name}:${option.value}`} className="rounded-full bg-[#f4eee9] px-2.5 py-1 text-[10px] font-bold text-[#59627b]"><span className="capitalize text-[#9297a4]">{option.name.replace(/[_-]+/g, " ")}:</span> {option.value}</span>)}</span>;
}

// A small preview of a Cloudinary image (print files can be very large); other links as they are.
export function previewUrl(url: string) {
  return url.replace(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)/, "$1c_limit,w_480,h_480,f_auto,q_auto/");
}

// A thumbnail that opens the full file in a new tab. PDFs show a label; an image that cannot be loaded says so.
export function Thumb({ url, label, detail, size = "md" }: { url: string; label: string; detail?: string; size?: "sm" | "md" | "lg" }) {
  const pdf = /\.pdf($|\?)/i.test(url);
  const [failed, setFailed] = useState(false);
  const height = size === "sm" ? "h-24" : size === "lg" ? "h-56" : "h-36";
  return <a href={url} target="_blank" rel="noreferrer" className="group block min-w-0" title="Open the full file">
    <span className={`flex ${height} items-center justify-center overflow-hidden rounded-lg border border-[#e4e7ee] bg-[repeating-conic-gradient(#f3f4f6_0_25%,#fff_0_50%)] bg-[length:16px_16px]`}>
      {pdf ? <span className="text-xs font-black text-[#59627b]">PDF</span>
        : failed ? <span className="px-2 text-center text-[11px] font-bold text-[#9297a4]">Image unavailable</span>
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={previewUrl(url)} alt={label} loading="lazy" onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />}
    </span>
    <span className="mt-1 block text-[11px] font-black text-[#182443] group-hover:text-[#ee5264]">{label}</span>
    {detail && <span className="block text-[11px] text-[#9297a4]">{detail}</span>}
  </a>;
}
