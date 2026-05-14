import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { TABS } from "./schema.js";

export class LocalStorage {
  constructor() {
    this.filePath = path.join(config.rootDir, ".data", "openclaw-outreach.json");
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch {
      const empty = Object.fromEntries(Object.keys(TABS).map((tab) => [tab, []]));
      await fs.writeFile(this.filePath, JSON.stringify(empty, null, 2));
    }
  }

  async readDb() {
    await this.queue.catch(() => {});
    return this.readDbFile();
  }

  async readDbFile() {
    await this.init();
    return JSON.parse(await fs.readFile(this.filePath, "utf8"));
  }

  async writeDb(db) {
    await this.init();
    const tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(db, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }

  async transaction(update) {
    const work = this.queue.catch(() => {}).then(async () => {
      const db = await this.readDbFile();
      const result = await update(db);
      await this.writeDb(db);
      return result;
    });
    this.queue = work.catch(() => {});
    return work;
  }

  async ensure() {
    await this.init();
  }

  async list(tab) {
    const db = await this.readDb();
    return db[tab] || [];
  }

  async append(tab, record) {
    return this.transaction((db) => {
      db[tab] ||= [];
      db[tab].push(record);
      return record;
    });
  }

  async updateById(tab, idColumn, idValue, patch) {
    return this.transaction((db) => {
      db[tab] ||= [];
      const index = db[tab].findIndex((row) => row[idColumn] === idValue);
      if (index === -1) return null;
      db[tab][index] = { ...db[tab][index], ...patch };
      return db[tab][index];
    });
  }

  async findById(tab, idColumn, idValue) {
    const rows = await this.list(tab);
    return rows.find((row) => row[idColumn] === idValue) || null;
  }
}
