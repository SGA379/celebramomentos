import { NextRequest, NextResponse } from "next/server";
import { requireCustomer } from "@/lib/server/auth";
import { mergeCustomerCart } from "@/lib/server/cart";
import { handleApiError } from "@/lib/server/http";
import { cartSyncSchema } from "@/lib/server/validation";
import type { CartItem } from "@/lib/store";

export const dynamic = "force-dynamic";

// Called once after login when the browser still has a guest cart. The server
// owns the merge, so another customer's lines can never be included.
export async function POST(request: NextRequest) {
  const { error, customer } = await requireCustomer();
  if (error) return error;
  try {
    const input = cartSyncSchema.parse(await request.json());
    const items = input.items.map((item) => ({
      id: item.id || "",
      quantity: item.quantity,
      productId: item.productId || null,
      product: item.product ?? null,
      productPriceCents: item.productPriceCents ?? null,
      productName: item.productName ?? null,
      card: item.card as CartItem["card"],
    }));
    return NextResponse.json(await mergeCustomerCart(customer.id, items));
  } catch (reason) {
    return handleApiError(reason);
  }
}
