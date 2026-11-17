import { describe, expect, it } from "vitest";
import { approvedPhoneCase } from "@/lib/pod/printeers/approved";
import { phoneModelKey } from "@/lib/pod/printeers/catalog";

// Group names exactly as Printeers lists them: v1 test (derived from /stock, checked 2026-11-17) and
// v2 production product groups (checked 2026-11-05).
const V1 = {
  hard: "Hard case · Back printed · Transparent",
  wallet: "Wallet case · Fully printed · White",
  soft: "Soft case · Back printed · Transparent",
  others: [
    "Hard case · Back printed · Black", "Hard case · Back printed · White", "Hard case · Fully printed · White", "Hard case · Front printed · Transparent",
    "Hybrid case · Back printed · Transparent", "Tough case · Fully printed · Black", "Tough case with MagSafe · Fully printed · Black",
    "Soft case · Back printed · Black", "Soft case · Back printed · White", "Soft case · Front printed · Transparent",
    "Wallet case · Front printed · Black", "Bumper case · Back printed · Transparent", "Crossbody case · Back printed · Transparent",
    "Biodegradable case · Back printed · Black", "Card case · Back printed · Transparent",
  ],
};
const V2 = {
  hard: "Phone Hard cases (back printed, transparent)",
  wallet: "Phone Wallet case (fully printed)",
  soft: "Phone Soft cases (back printed, transparent)",
  others: [
    "Phone Hard cases (back printed, black)", "Phone Hard cases (white, back printed)", "Phone Hard cases (fully printed)",
    "Phone Hybrid cases (back printed, transparent)", "Phone Hybrid cases with MagSafe (back printed, transparent)",
    "Phone Tough cases (fully printed, black insert)", "Phone Tough cases with MagSafe (fully printed, black insert)",
    "Phone Soft cases (back printed, black)", "Phone Soft cases (back printed, white)", "Phone Wallet cases (front printed, black)",
    "Phone Bumper cases (back printed, transparent)", "Phone Crossbody cases (back printed, transparent)",
    "iPad Soft cases (back printed, transparent)", "AirPods Soft cases (front printed, transparent)", "MacBook Hard cases (front printed, transparent)",
  ],
};

describe("client-approved Printeers phone cases", () => {
  it.each([["v1 test", V1], ["v2 production", V2]])("recognises exactly the three approved groups (%s)", (_, catalog) => {
    expect(approvedPhoneCase(catalog.hard)).toBe("hard");
    expect(approvedPhoneCase(catalog.wallet)).toBe("wallet");
    expect(approvedPhoneCase(catalog.soft)).toBe("soft");
    for (const name of catalog.others) expect(approvedPhoneCase(name), name).toBeNull();
  });

  it("never treats a black, white, fully printed or MagSafe hard case as the transparent hard case", () => {
    expect(approvedPhoneCase("Phone Hard cases (back printed, black)")).toBeNull();
    expect(approvedPhoneCase("Hard case · Back printed · White")).toBeNull();
    expect(approvedPhoneCase("Phone Hybrid cases with MagSafe (back printed, transparent)")).toBeNull();
    expect(approvedPhoneCase("")).toBeNull();
    expect(approvedPhoneCase(null)).toBeNull();
  });
});

describe("phone model de-duplication", () => {
  it("treats the same phones written two ways as one model", () => {
    expect(phoneModelKey("Apple iPhone 6 / iPhone 6s")).toBe(phoneModelKey("Apple iPhone 6 / 6s"));
    expect(phoneModelKey("Apple iPhone X / iPhone Xs")).toBe(phoneModelKey("Apple iPhone X / Xs"));
    expect(phoneModelKey("Samsung Galaxy A72 / Galaxy A72 5G")).toBe(phoneModelKey("Samsung Galaxy A72 / A72 5G"));
  });

  it("keeps different phones apart", () => {
    expect(phoneModelKey("Apple iPhone 13")).not.toBe(phoneModelKey("Xiaomi 13"));
    expect(phoneModelKey("Apple iPhone 6 / 6s")).not.toBe(phoneModelKey("Apple iPhone 6 Plus / 6s Plus"));
    expect(phoneModelKey("Google Pixel 9")).not.toBe(phoneModelKey("Google Pixel 9 Pro"));
  });
});
