// Pending-order durability — see specs/live-trading-readiness.md §8.2.
//
// If the process dies between rest.placeOrder() returning and the trade
// being journaled, a real fill can exist on the exchange with no local
// record at all — reconcilePositions() surfaces it only as a generic
// "unaccounted-for position" (correctly refusing to guess what it was), with
// no way to tell it apart from some other manual activity on the account.
// Persisting a minimal record of what was ABOUT to be sent, before sending
// it, means a startup check can specifically identify "this was our own
// order that we lost track of" and say so — a much more actionable message
// than a generic unaccounted-for warning.
//
// Deliberately minimal: this does NOT attempt to reconstruct a full journal
// TradeRecord (which needs signal context — confidence, indicators, reason —
// that was never part of what's captured here) or auto-inject anything into
// the journal. Auto-fabricating trade metadata that was never actually
// observed is exactly the anti-pattern the rest of this effort has been
// removing; a specific, correct diagnostic is the right scope here.

import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface PendingOrder {
  orderLinkId: string;
  symbol: string; // Bybit format, e.g. "BTCUSDT"
  intent: "buy" | "sell";
  expectedQty: number;
  timestamp: number;
}

const PENDING_ORDERS_FILE = "pending-orders.json";

function pendingOrdersPath(): string {
  return join(process.cwd(), PENDING_ORDERS_FILE);
}

function loadPendingOrders(): PendingOrder[] {
  try {
    const path = pendingOrdersPath();
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function savePendingOrders(orders: PendingOrder[]): void {
  const live = pendingOrdersPath();
  const tmp = `${live}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(orders, null, 2));
    renameSync(tmp, live); // atomic on POSIX filesystems
  } catch (err) {
    console.warn(`[pending-orders] Failed to persist: ${(err as Error).message}`);
  }
}

/** Call before sending the order to the exchange. */
export function recordPendingOrder(order: PendingOrder): void {
  const orders = loadPendingOrders();
  orders.push(order);
  savePendingOrders(orders);
}

/** Call once the order's outcome (fill or confirmed rejection) is known. */
export function clearPendingOrder(orderLinkId: string): void {
  const orders = loadPendingOrders();
  const next = orders.filter(o => o.orderLinkId !== orderLinkId);
  if (next.length !== orders.length) savePendingOrders(next);
  if (next.length === 0 && existsSync(pendingOrdersPath())) {
    try { unlinkSync(pendingOrdersPath()); } catch { /* best-effort cleanup */ }
  }
}

/** All currently-pending orders — call at startup to cross-reference against order history. */
export function getPendingOrders(): PendingOrder[] {
  return loadPendingOrders();
}
