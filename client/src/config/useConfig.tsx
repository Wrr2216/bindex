import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { AppConfig } from "../types";

/**
 * The instance configuration, loaded once before anything renders. Every name
 * shown in the interface and every optional feature comes from here, so a
 * deployment can call things whatever it likes and switch off the parts it
 * does not use.
 */

const FALLBACK: AppConfig = {
  appName: "Inventory",
  orgName: "",
  tagline: "",
  accentColor: "#0284c7",
  assetCodePrefix: "INV",
  locationCodePrefix: "LOC",
  currency: "USD",
  locale: "en-US",
  terms: {
    item: { singular: "Item", plural: "Items" },
    location: { singular: "Location", plural: "Locations" },
    group: { singular: "Group", plural: "Groups" },
    holder: { singular: "Assignee", plural: "Assignees" },
  },
  features: {
    groups: true,
    holders: true,
    domains: false,
    units: true,
    assignments: true,
    audit: true,
    printing: true,
    vehicleFields: false,
    lookup: true,
    askSearch: false,
    spotCheck: false,
    tracking: false,
    aiCapture: true,
    jobs: false,
    registerReconcile: true,
    consumables: false,
    legacyTags: false,
    offline: false,
    bulkCapture: false,
    aiCondition: true,
    inspections: false,
    valuation: false,
    crew: false,
    custody: false,
  },
  label: { widthMm: 62, heightMm: 25.4 },
  integrations: {
    ninjaone: false,
    registrars: false,
    lookup: false,
    webSearch: false,
    languageModel: false,
  },
};

type ConfigState = {
  config: AppConfig;
  loading: boolean;
  /** Re-read after an administrator saves changes on the settings screen. */
  reload: () => Promise<void>;
};

const ConfigContext = createContext<ConfigState | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(FALLBACK);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setConfig(await api.config());
    } catch {
      // An unreachable server should still render a usable shell; the sign-in
      // screen below will report the real problem.
      setConfig(FALLBACK);
    }
  };

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, []);

  // The document title and the browser chrome colour on mobile both come from
  // the instance configuration, so an installed app looks like the thing it is
  // rather than like the project it was built from.
  useEffect(() => {
    document.title = config.appName;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", config.accentColor);
  }, [config.appName, config.accentColor]);

  return (
    <ConfigContext.Provider value={{ config, loading, reload: load }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig(): ConfigState {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used inside ConfigProvider");
  return ctx;
}

/** Shorthand for the common case of reading names and feature flags. */
export function useTerms() {
  return useConfig().config.terms;
}

export function useFeatures() {
  return useConfig().config.features;
}

/** Format a cent amount in the currency and locale the instance is set to. */
export function useMoney(): (cents: number | null | undefined) => string {
  const { currency, locale } = useConfig().config;
  return (cents) => {
    if (cents == null) return "Not set";
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  };
}
