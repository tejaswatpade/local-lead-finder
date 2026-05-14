import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) process.env[key] = value;
  }
}

parseEnvFile(path.join(ROOT, ".env.local"));
parseEnvFile(path.join(ROOT, ".env"));

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizePrivateKey(key) {
  return key ? key.replace(/\\n/g, "\n") : "";
}

function serviceAccountFromEnv() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return {
        email: parsed.client_email || "",
        privateKey: normalizePrivateKey(parsed.private_key || ""),
      };
    } catch {
      return { email: "", privateKey: "" };
    }
  }

  return {
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    privateKey: normalizePrivateKey(process.env.GOOGLE_PRIVATE_KEY || ""),
  };
}

const serviceAccount = serviceAccountFromEnv();

export const config = {
  rootDir: ROOT,
  port: Number(process.env.PORT || 3000),
  appBaseUrl: process.env.APP_BASE_URL || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  devDashboardPassword: process.env.DEV_DASHBOARD_PASSWORD || "",
  placeCacheTtlDays: Number(process.env.PLACE_CACHE_TTL_DAYS || 30),
  geocodeCacheTtlDays: Number(process.env.GEOCODE_CACHE_TTL_DAYS || 30),
  searchCacheTtlDays: Number(process.env.SEARCH_CACHE_TTL_DAYS || 7),
  websiteScanCacheTtlDays: Number(process.env.WEBSITE_SCAN_CACHE_TTL_DAYS || 14),
  defaultUserCredits: Number(process.env.DEFAULT_USER_CREDITS || 500),
  ownerEmails: String(process.env.OWNER_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
  sessionSecret:
    process.env.SESSION_SECRET ||
    process.env.ADMIN_PASSWORD ||
    "openclaw-dev-session-secret",
  host: process.env.HOST || "127.0.0.1",
  localDevStorage: boolEnv("LOCAL_DEV_STORAGE", false),
  googleSheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "",
    serviceAccountEmail: serviceAccount.email,
    privateKey: serviceAccount.privateKey,
  },
  supabase: {
    url: process.env.SUPABASE_URL || "",
    serviceRoleKey:
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY ||
      "",
  },
  googleOAuth: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
    allowedEmails: String(process.env.GOOGLE_ALLOWED_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },
  maps: {
    browserKey:
      process.env.GOOGLE_MAPS_BROWSER_KEY ||
      process.env.GOOGLE_MAPS_JS_API_KEY ||
      "",
  },
  postgres: {
    databaseUrl:
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      "",
  },
  search: {
    googlePlacesApiKey:
      process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || "",
    googleGeocodingApiKey:
      process.env.GOOGLE_GEOCODING_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY ||
      process.env.GOOGLE_PLACES_API_KEY ||
      "",
    serpApiKey: process.env.SERPAPI_KEY || "",
    bingSearchKey: process.env.BING_SEARCH_KEY || "",
    googleCseApiKey: process.env.GOOGLE_CSE_API_KEY || "",
    googleCseId: process.env.GOOGLE_CSE_ID || "",
    publicSearchFallback: boolEnv("PUBLIC_SEARCH_FALLBACK", false),
  },
};

export function hasGoogleSheetsConfig() {
  return Boolean(
    config.googleSheets.spreadsheetId &&
      config.googleSheets.serviceAccountEmail &&
      config.googleSheets.privateKey,
  );
}

export function hasSupabaseConfig() {
  return Boolean(config.supabase.url && config.supabase.serviceRoleKey);
}

export function hasGoogleOAuthConfig() {
  return Boolean(config.googleOAuth.clientId && config.googleOAuth.clientSecret);
}

export function hasPostgresConfig() {
  return Boolean(config.postgres.databaseUrl);
}

export function hasSearchProvider() {
  return Boolean(config.search.googlePlacesApiKey);
}
