import { config } from "../config.js";
import { TABS } from "./schema.js";

const ID_COLUMNS = {
  Leads: "leadId",
  ScrapedData: "scrapedId",
  AuditReports: "auditId",
  EmailDrafts: "draftId",
  AgentRuns: "runId",
  AgentLogs: "logId",
  Users: "email",
  LeadUnlocks: "unlockId",
  CreditTransactions: "transactionId",
  PlaceCache: "googlePlaceId",
  GeocodeCache: "cacheKey",
  SearchCache: "cacheKey",
  WebsiteScanCache: "domain",
  UsageEvents: "eventId",
};

export class SupabaseStorage {
  constructor() {
    this.url = config.supabase.url.replace(/\/+$/, "");
    this.key = config.supabase.serviceRoleKey;
  }

  assertConfigured() {
    if (!this.url || !this.key) {
      throw new Error(
        "Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
  }

  async ensure() {
    this.assertConfigured();
    try {
      await this.request("/rest/v1/openclaw_records", {
        method: "GET",
        query: {
          select: "tab,key",
          limit: "1",
        },
      });
    } catch (error) {
      if (/openclaw_records|relation .* does not exist|42P01/i.test(error.message)) {
        throw new Error(
          "Supabase table openclaw_records is missing. Run supabase/schema.sql in the Supabase SQL editor.",
        );
      }
      throw error;
    }
  }

  async list(tab) {
    this.assertTab(tab);
    const rows = await this.request("/rest/v1/openclaw_records", {
      method: "GET",
      query: {
        tab: `eq.${tab}`,
        select: "data,created_at",
        order: "created_at.asc",
      },
    });
    return (rows || []).map((row) => row.data || {});
  }

  async append(tab, record) {
    this.assertTab(tab);
    const key = record[ID_COLUMNS[tab]];
    if (!key) throw new Error(`Cannot append ${tab}: missing ${ID_COLUMNS[tab]}.`);

    await this.request("/rest/v1/openclaw_records", {
      method: "POST",
      headers: { prefer: "return=minimal" },
      body: {
        tab,
        key,
        data: record,
      },
    });
    return record;
  }

  async updateById(tab, idColumn, idValue, patch) {
    this.assertTab(tab);
    const current = await this.findById(tab, idColumn, idValue);
    if (!current) return null;

    const updated = { ...current, ...patch };
    await this.request("/rest/v1/openclaw_records", {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      query: {
        tab: `eq.${tab}`,
        key: `eq.${idValue}`,
      },
      body: {
        data: updated,
      },
    });
    return updated;
  }

  async findById(tab, idColumn, idValue) {
    this.assertTab(tab);
    const rows = await this.request("/rest/v1/openclaw_records", {
      method: "GET",
      query: {
        tab: `eq.${tab}`,
        key: `eq.${idValue}`,
        select: "data",
        limit: "1",
      },
    });
    return rows?.[0]?.data || null;
  }

  assertTab(tab) {
    if (!TABS[tab]) throw new Error(`Unknown storage tab: ${tab}`);
  }

  async request(pathname, options = {}) {
    const url = new URL(`${this.url}${pathname}`);
    for (const [key, value] of Object.entries(options.query || {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        "content-type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Supabase API failed: HTTP ${response.status} ${text}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}
