import type { MySqlTable } from "drizzle-orm/mysql-core";
import * as worldSchema from "./schema/world.ts";
import { WorldTables } from "./world-tables.ts";

/**
 * World rows for tests, written as the `INSERT` statements of an AzerothCore SQL dump:
 * `INSERT INTO item_template (entry, name) VALUES (25, 'Worn Shortsword'), (…);`. `CREATE TABLE` statements only
 * name the column order for later `INSERT`s without a column list into the same `WorldTables`; the real columns
 * and defaults come from the schema.
 * Values are SQL literals: numbers, 'strings' (with '' escapes), and NULL. Whole-line `--` comments are skipped.
 */
const columnOrders = new WeakMap<WorldTables, Map<string, string[]>>();

export function worldFromSql(sql: string, into: WorldTables = WorldTables.fromRows()): WorldTables {
  let columnOrder = columnOrders.get(into);
  if (!columnOrder) {
    columnOrder = new Map();
    columnOrders.set(into, columnOrder);
  }
  for (const statement of splitStatements(sql.replace(/^\s*--.*$/gm, ""))) {
    const create = /^CREATE TABLE(?: IF NOT EXISTS)?\s+[`"]?(\w+)[`"]?\s*\(([\s\S]*)\)\s*$/i.exec(statement);
    if (create) {
      columnOrder.set(
        create[1]!,
        splitTopLevel(create[2]!)
          .map((item) => item.trim())
          .filter((item) => !/^(PRIMARY|UNIQUE|KEY|INDEX|CONSTRAINT|FOREIGN|CHECK)\b/i.test(item))
          .map((item) => /^[`"]?(\w+)/.exec(item)![1]!),
      );
      continue;
    }
    const insert = /^INSERT(?: OR \w+)? INTO\s+[`"]?(\w+)[`"]?\s*(?:\(([^)]*)\))?\s*VALUES\s*([\s\S]*)$/i.exec(statement);
    if (!insert) {
      if (statement.trim()) throw new Error(`worldFromSql: unsupported statement ${statement.slice(0, 60)}`);
      continue;
    }
    const name = insert[1]!;
    const table = (worldSchema as Record<string, unknown>)[name] as MySqlTable | undefined;
    if (!table) throw new Error(`worldFromSql: ${name} is not an acore_world table`);
    const columns = insert[2]
      ? insert[2].split(",").map((column) => column.trim().replace(/[`"]/g, ""))
      : columnOrder.get(name);
    if (!columns) throw new Error(`worldFromSql: no column list for ${name}`);
    const rows = tuples(insert[3]!).map((values) => {
      if (values.length !== columns.length) throw new Error(`worldFromSql: ${name} row has ${values.length} values for ${columns.length} columns`);
      return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    });
    into.insert(table, rows);
  }
  return into;
}

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]!;
    if (char === "'") {
      if (quoted && sql[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (char === ";" && !quoted) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

function tuples(text: string): unknown[][] {
  const rows: unknown[][] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "(") {
      i++;
      continue;
    }
    i++;
    const row: unknown[] = [];
    while (i < text.length && text[i] !== ")") {
      while (text[i] === " " || text[i] === "\n" || text[i] === "\t" || text[i] === ",") i++;
      if (text[i] === ")") break;
      if (text[i] === "'") {
        let value = "";
        i++;
        while (i < text.length) {
          if (text[i] === "'" && text[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          if (text[i] === "'") break;
          value += text[i++];
        }
        i++;
        row.push(value);
        continue;
      }
      let token = "";
      while (i < text.length && text[i] !== "," && text[i] !== ")") token += text[i++];
      token = token.trim();
      row.push(/^NULL$/i.test(token) ? null : Number(token));
    }
    i++;
    rows.push(row);
  }
  return rows;
}
