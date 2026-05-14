import crypto from "node:crypto";
import { config } from "../config.js";
import { objectToRow, rowToObject, TABS } from "./schema.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function quoteSheet(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

export class GoogleSheetsStorage {
  constructor() {
    this.spreadsheetId = config.googleSheets.spreadsheetId;
    this.email = config.googleSheets.serviceAccountEmail;
    this.privateKey = config.googleSheets.privateKey;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  assertConfigured() {
    if (!this.spreadsheetId || !this.email || !this.privateKey) {
      throw new Error(
        "Google Sheets storage is not configured. Set GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_PRIVATE_KEY.",
      );
    }
  }

  async accessToken() {
    this.assertConfigured();

    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64Url(
      JSON.stringify({
        iss: this.email,
        scope: SHEETS_SCOPE,
        aud: TOKEN_URL,
        exp: now + 3600,
        iat: now,
      }),
    );
    const unsigned = `${header}.${claim}`;
    const signature = crypto.sign(
      "RSA-SHA256",
      Buffer.from(unsigned),
      this.privateKey,
    );
    const assertion = `${unsigned}.${base64Url(signature)}`;

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google auth failed: ${response.status} ${body}`);
    }

    const data = await response.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + Number(data.expires_in || 3600) * 1000;
    return this.token;
  }

  async request(path, options = {}) {
    const token = await this.accessToken();
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`,
      {
        ...options,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(options.headers || {}),
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Sheets API failed: ${response.status} ${body}`);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  async ensure() {
    this.assertConfigured();
    const metadata = await this.request("?fields=sheets.properties");
    const existing = new Map(
      (metadata.sheets || []).map((sheet) => [
        sheet.properties.title,
        sheet.properties.sheetId,
      ]),
    );

    const requests = [];
    for (const tab of Object.keys(TABS)) {
      if (!existing.has(tab)) {
        requests.push({ addSheet: { properties: { title: tab } } });
      }
    }

    if (requests.length) {
      await this.request(":batchUpdate", {
        method: "POST",
        body: JSON.stringify({ requests }),
      });
    }

    for (const [tab, headers] of Object.entries(TABS)) {
      await this.request(
        `/values/${encodeURIComponent(`${quoteSheet(tab)}!A1:${columnName(
          headers.length,
        )}1`)}?valueInputOption=RAW`,
        {
          method: "PUT",
          body: JSON.stringify({ values: [headers] }),
        },
      );
    }
  }

  async list(tab) {
    const headers = TABS[tab];
    const data = await this.request(
      `/values/${encodeURIComponent(`${quoteSheet(tab)}!A1:${columnName(headers.length)}10000`)}`,
      { method: "GET" },
    );

    const values = data.values || [];
    if (values.length <= 1) return [];
    return values.slice(1).map((row) => rowToObject(headers, row));
  }

  async append(tab, record) {
    const headers = TABS[tab];
    await this.request(
      `/values/${encodeURIComponent(`${quoteSheet(tab)}!A:${columnName(
        headers.length,
      )}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        body: JSON.stringify({ values: [objectToRow(headers, record)] }),
      },
    );
    return record;
  }

  async updateById(tab, idColumn, idValue, patch) {
    const headers = TABS[tab];
    const rows = await this.list(tab);
    const index = rows.findIndex((row) => row[idColumn] === idValue);
    if (index === -1) return null;

    const updated = { ...rows[index], ...patch };
    const sheetRow = index + 2;
    await this.request(
      `/values/${encodeURIComponent(`${quoteSheet(tab)}!A${sheetRow}:${columnName(
        headers.length,
      )}${sheetRow}`)}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [objectToRow(headers, updated)] }),
      },
    );
    return updated;
  }

  async findById(tab, idColumn, idValue) {
    const rows = await this.list(tab);
    return rows.find((row) => row[idColumn] === idValue) || null;
  }
}

function columnName(length) {
  let dividend = length;
  let name = "";
  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    name = String.fromCharCode(65 + modulo) + name;
    dividend = Math.floor((dividend - modulo) / 26);
  }
  return name;
}
