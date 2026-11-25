"use client";

import { useCallback, useEffect, useRef } from "react";
import { useDispatch, useSelector } from "react-redux";
import { getSessionUser } from "@/lib/client-session";
import { fetchAccountCart, mergeGuestCart, setCartSyncReady } from "@/lib/cart-sync";
import { replaceCartItems, setCartOwner, setCartSyncStatus, store, type RootState } from "@/lib/store";

// Keeps the browser copy and the authenticated CartLine rows aligned. A guest
// cart is merged once; an account-owned cart is replaced by the latest server
// copy on startup, login and focus.
export function CartSynchronizer() {
  const dispatch = useDispatch();
  const status = useSelector((state: RootState) => state.cart.cartSyncStatus);
  const running = useRef(false);
  const rerun = useRef(false);

  const synchronize = useCallback(async (refreshSession = false) => {
    if (running.current) { rerun.current = true; return; }
    running.current = true;
    setCartSyncReady(null);
    dispatch(setCartSyncStatus("syncing"));
    try {
      const user = await getSessionUser({ refresh: refreshSession });
      const current = store.getState().cart;
      if (!user) {
        if (current.cartOwnerId) {
          dispatch(replaceCartItems([]));
          dispatch(setCartOwner(null));
        }
        dispatch(setCartSyncStatus("idle"));
        return;
      }
      const guestItems = current.cartOwnerId === null ? current.items : [];
      const items = current.cartOwnerId === null ? await mergeGuestCart(guestItems) : await fetchAccountCart();
      dispatch(replaceCartItems(items));
      dispatch(setCartOwner(user.id));
      setCartSyncReady(user.id);
      dispatch(setCartSyncStatus("idle"));
    } catch (reason) {
      console.error("[celebra] account cart could not be synchronized", reason);
      dispatch(setCartSyncStatus("error"));
    } finally {
      running.current = false;
      if (rerun.current) { rerun.current = false; void synchronize(true); }
    }
  }, [dispatch]);

  useEffect(() => {
    void synchronize(true);
    const onFocus = () => { void synchronize(false); };
    const onSessionChange = () => { void synchronize(true); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("celebra-session-change", onSessionChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("celebra-session-change", onSessionChange);
      setCartSyncReady(null);
    };
  }, [synchronize]);

  if (status === "idle") return null;
  return <div className={`fixed bottom-4 left-1/2 z-[70] -translate-x-1/2 rounded-full px-4 py-2.5 text-xs font-bold shadow-xl ${status === "error" ? "bg-[#b9384d] text-white" : "bg-[#182443] text-white"}`} role={status === "error" ? "alert" : "status"} aria-live="polite">
    {status === "error" ? "No hemos podido sincronizar la cesta. Recarga la página para intentarlo de nuevo." : "Sincronizando tu cesta con tu cuenta…"}
  </div>;
}
