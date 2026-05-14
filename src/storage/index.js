import { config, hasGoogleSheetsConfig, hasSupabaseConfig } from "../config.js";
import { GoogleSheetsStorage } from "./sheets.js";
import { LocalStorage } from "./local.js";
import { SupabaseStorage } from "./supabase.js";

export function createStorage() {
  if (hasSupabaseConfig()) return new SupabaseStorage();
  if (hasGoogleSheetsConfig()) return new GoogleSheetsStorage();

  if (config.localDevStorage) {
    console.warn(
      "Using local development storage because LOCAL_DEV_STORAGE=true. Configure Google Sheets for V1 production use.",
    );
    return new LocalStorage();
  }

  return new GoogleSheetsStorage();
}
