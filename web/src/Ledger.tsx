import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import type { State } from "./types.ts";
import { inr, pctOf } from "./types.ts";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  backgroundColor: "#FFFFFF", foregroundColor: "#0B1431", headerBackgroundColor: "#F4F6FA", headerTextColor: "#0B1431",
  borderColor: "#E2E6EE", rowHoverColor: "#EEF4FF", accentColor: "#2B6DF0",
  fontFamily: "'Inter', system-ui, sans-serif", fontSize: 14, headerFontWeight: 600, wrapperBorderRadius: 0, borderRadius: 6, spacing: 8,
});

const money: Partial<ColDef> = { valueFormatter: (p) => (p.value == null ? "" : inr(p.value)), type: "rightAligned", cellClass: "num", width: 130 };
const COLLECT: Record<string, string> = { pending: "Queued", notified: "Debit in flight", paid: "Received", failed: "Declined" };
const PAYOUT: Record<string, string> = { pending: "Queued", sent: "Sent to RazorpayX", processing: "With the bank", processed: "In the account", failed: "Failed", reversed: "Returned by bank", retained: "Retained by foreman" };
const time = (v: string) => new Date(v).toLocaleTimeString();

export function Ledger({ state }: { state: State }) {
  const [tab, setTab] = useState<"instalments" | "draws" | "payouts" | "heard" | "log">("instalments");
  const name = useMemo(() => new Map(state.members.map((m) => [m.id, m.name])), [state.members]);
  const gross = state.chit?.gross ?? 1;
  const who = (id: string) => (id === "foreman" ? state.members.find((m) => m.is_foreman)?.name ?? "Foreman" : name.get(id) ?? id);

  const instalmentCols: ColDef[] = [
    { field: "month", headerName: "Month", width: 90 },
    { field: "member", headerName: "Ticket", valueFormatter: (p) => who(p.value), width: 190 },
    { field: "amount", headerName: "Instalment", ...money },
    { field: "method", headerName: "How", valueFormatter: (p) => ({ mandate: "Standing mandate", checkout: "Razorpay Checkout", link: "Payment link", simulated: "Simulated" })[p.value as string] ?? p.value, width: 160 },
    { field: "status", headerName: "Status", valueFormatter: (p) => COLLECT[p.value] ?? p.value, width: 150, cellClassRules: { "is-flagged": (p) => p.value === "failed", "is-settled": (p) => p.value === "paid" } },
    { field: "order_id", headerName: "Razorpay order", width: 200 },
    { field: "payment_id", headerName: "Razorpay payment", width: 210 },
    { field: "link_url", headerName: "Pay page", width: 220, cellRenderer: (p: { value: string | null }) => (p.value ? `<a href="${p.value}" target="_blank" rel="noreferrer">${p.value}</a>` : "") },
    { field: "marker", headerName: "Retry-safe marker", width: 260 },
    { field: "error", headerName: "Problem", flex: 1, minWidth: 160 },
  ];
  const drawCols: ColDef[] = [
    { field: "month", headerName: "Month", width: 90 },
    { field: "winner", headerName: "Prized subscriber", valueFormatter: (p) => who(p.value), width: 190 },
    { field: "how", headerName: "Decided by", valueFormatter: (p) => ({ auction: "Auction", foreman: "Foreman's month", lot: "Lot", last: "Last unprized" })[p.value as string] ?? p.value, width: 150 },
    { field: "discount", headerName: "Discount", ...money },
    { headerName: "Discount %", valueGetter: (p) => pctOf(p.data.discount, gross), width: 110, type: "rightAligned" },
    { field: "prize", headerName: "Net chit amount", ...money, width: 150 },
    { field: "commission", headerName: "Commission", ...money },
    { field: "share", headerName: "Share per ticket", ...money, width: 150 },
    { field: "second_best", headerName: "Runner-up stopped at", valueFormatter: (p) => (p.value == null ? "" : pctOf(p.value, gross)), width: 170, type: "rightAligned" },
    { field: "bidders", headerName: "Bidders", valueFormatter: (p) => (JSON.parse(p.value) as string[]).map(who).join(", "), flex: 1, minWidth: 220 },
  ];
  const payoutCols: ColDef[] = [
    { field: "month", headerName: "Month", width: 90 },
    { field: "kind", headerName: "What", valueFormatter: (p) => (p.value === "prize" ? "Prize to subscriber" : "Foreman's commission"), width: 180 },
    { field: "member", headerName: "To", valueFormatter: (p) => who(p.value), width: 190 },
    { field: "amount", headerName: "Amount", ...money },
    { field: "status", headerName: "Status", valueFormatter: (p) => PAYOUT[p.value] ?? p.value, width: 180, cellClassRules: { "is-flagged": (p) => p.value === "failed" || p.value === "reversed", "is-settled": (p) => p.value === "processed" } },
    { field: "payout_id", headerName: "RazorpayX payout", width: 200 },
    { field: "utr", headerName: "UTR", width: 160 },
    { field: "idempotency", headerName: "Idempotency key", width: 200 },
    { field: "error", headerName: "Problem", flex: 1, minWidth: 160 },
  ];
  const heardCols: ColDef[] = [
    { field: "at", headerName: "Received", valueFormatter: (p) => time(p.value), width: 130 },
    { field: "event", headerName: "Event", flex: 1, minWidth: 220 },
    { field: "ref", headerName: "About", width: 220 },
    { field: "outcome", headerName: "What we did", flex: 1, minWidth: 180 },
    { field: "id", headerName: "Razorpay event ID", width: 240 },
  ];
  const log = state.events.map((e) => ({ id: e.id, at: e.at, month: e.month, who: who(e.actor) === e.actor ? (e.actor === "razorpay" ? "Razorpay" : "FOREMAN") : `${who(e.actor)}'s agent`, text: e.text }));
  const logCols: ColDef[] = [
    { field: "at", headerName: "Time", valueFormatter: (p) => time(p.value), width: 120 },
    { field: "month", headerName: "Month", width: 90 },
    { field: "who", headerName: "Who", width: 220 },
    { field: "text", headerName: "What happened", flex: 1, minWidth: 400, wrapText: true, autoHeight: true },
  ];

  const tabs = [
    { id: "instalments" as const, label: `Instalments (${state.collections.length})` },
    { id: "draws" as const, label: `Draws (${state.draws.length})` },
    { id: "payouts" as const, label: `Payouts (${state.payouts.length})` },
    { id: "heard" as const, label: `Webhooks (${state.received.length})` },
    { id: "log" as const, label: `Full log (${log.length})` },
  ];
  const [rows, cols, empty] =
    tab === "instalments" ? [state.collections, instalmentCols, "No instalments yet. Run the first month."]
    : tab === "draws" ? [state.draws, drawCols, "No draws yet."]
    : tab === "payouts" ? [state.payouts, payoutCols, "No payouts yet."]
    : tab === "heard" ? [state.received, heardCols, state.webhooks ? "No webhooks yet." : "Webhooks are off because this server has no public address. Razorpay is asked directly instead."]
    : [log, logCols, "Nothing yet."];

  return (
    <section className="card ledger">
      <div className="tabs" role="tablist">{tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}</div>
      <div className="grid">
        <AgGridReact key={tab} theme={theme} rowData={rows as object[]} columnDefs={cols} getRowId={(p) => String((p.data as { id?: string | number; month?: number }).id ?? (p.data as { month: number }).month)}
          overlayNoRowsTemplate={`<span class="empty">${empty}</span>`} suppressCellFocus domLayout="normal" />
      </div>
    </section>
  );
}
