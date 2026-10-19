// Reading inventories in the browser: a SAVI v1.10 workbook (.xlsm/.xlsx) or our own
// tidy tables (CSV / XLSX with named columns). Port of dst_engine/io/savi_workbook.py.
import * as XLSX from "xlsx";
import { Row } from "./core";
import { Inventory } from "./valuation";

export const STRUCTURE_COLUMNS = ["structure_seq", "structure_id", "name", "reference", "structure_type", "number_in_group",
  "length_m", "width_m", "headroom_m", "spans", "location", "route_supported", "route_salted", "traffic", "obstacle_crossed",
  "obstacle_salted", "pf_heritage", "pf_2", "pf_3", "pf_4", "pf_5", "pf_6", "adj_heritage", "adj_conservation_area",
  "adj_environmentally_sensitive", "adj_river_coastal_wall", "adj_substandard", "adj_spare_1", "adj_spare_2", "adj_spare_3",
  "adj_spare_4", "adj_spare_5", "adj_spare_6"];
export const ELEMENT_COLUMNS = ["element_seq", "structure_id", "element_type", "material", "condition_code", "spray_proximity",
  "pf_heritage", "pf_2", "pf_3", "pf_4", "pf_5", "pf_6", "intervention_threshold"];
export const PLANNED_COLUMNS = ["element_seq", "structure_id", "structure_name", "element_type", "material", "year_of_work",
  "maintenance_action", "total_cost", "condition_after"];
export const ROUTINE_COLUMNS = ["year", "routine_maintenance", "general_inspections", "principal_inspections",
  "structural_assessments", "other_regular_maintenance"];

const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

function grid(ws: XLSX.WorkSheet, c0: number, c1: number, r0: number, r1: number): any[][] {
  const out: any[][] = [];
  for (let r = r0; r <= r1; r++) {
    const row: any[] = [];
    for (let c = c0; c <= c1; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c })];
      row.push(cell === undefined || cell.t === "e" ? null : cell.v === "" ? null : cell.v);
    }
    out.push(row);
  }
  return out;
}

function lastRow(ws: XLSX.WorkSheet, col: number, start: number): number {
  const ref = ws["!ref"];
  if (!ref) return start - 1;
  const end = XLSX.utils.decode_range(ref).e.r + 1;
  let last = start - 1;
  for (let r = start; r <= end; r++) { const c = ws[XLSX.utils.encode_cell({ r: r - 1, c: col })]; if (c && !blank(c.v)) last = r; }
  return last;
}

function frame(ws: XLSX.WorkSheet, cols: string[], start: number, keyCol: number, dropOn: string): Row[] {
  const n = Math.max(lastRow(ws, keyCol, start), start);
  return grid(ws, 0, cols.length - 1, start, n)
    .map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])))
    .filter((r) => !blank(r[dropOn]));
}

const cell = (ws: XLSX.WorkSheet | undefined, a1: string) => (ws ? ws[a1]?.v ?? null : null);

/** A SAVI v1.10 workbook: Structures A5:AG, Elements A5:M, Planned A5:I, Routine A5:F124, Main Page settings. */
export function readSaviWorkbook(wb: XLSX.WorkBook, name: string): Inventory {
  const S = wb.Sheets["Structures"], E = wb.Sheets["Elements"];
  if (!S || !E) throw new Error("This workbook has no 'Structures' and 'Elements' sheets - is it a SAVI v1.10 file?");
  const structures = frame(S, STRUCTURE_COLUMNS, 5, 1, "structure_id");
  const elements = frame(E, ELEMENT_COLUMNS, 5, 1, "structure_id");
  const planned = wb.Sheets["Planned"] ? frame(wb.Sheets["Planned"], PLANNED_COLUMNS, 5, 0, "element_seq") : [];
  const routine = wb.Sheets["Routine"] ? grid(wb.Sheets["Routine"], 0, 5, 5, 124)
    .map((r) => Object.fromEntries(ROUTINE_COLUMNS.map((c, i) => [c, r[i]]))).filter((r) => !blank(r.year)) : [];
  const M = wb.Sheets["Main Page"];
  const bands = M ? grid(M, XLSX.utils.decode_col("BW"), XLSX.utils.decode_col("CA"), 19, 21) : [];
  const settings = {
    organisation: cell(M, "N27"), authority_type: cell(M, "N29"), price_year: cell(M, "AO46"),
    intervention_strategy: cell(M, "BU31"), input_date: String(cell(M, "AO18") ?? ""), years_long_term: cell(M, "CB16"),
    budget_5yr_annual: cell(M, "BH19"), budget_long_term: bands,
  };
  return { name, structures, elements, planned, routine, settings };
}

/** Tidy tables: sheets or CSV files named structures / elements / planned / routine with our column names. */
export function readTidyWorkbook(wb: XLSX.WorkBook, name: string): Partial<Inventory> {
  const out: Partial<Inventory> = { name };
  for (const sheet of wb.SheetNames) {
    const k = sheet.toLowerCase();
    const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[sheet], { defval: null, raw: true });
    if (k.startsWith("structure")) out.structures = rows;
    else if (k.startsWith("element")) out.elements = rows;
    else if (k.startsWith("planned")) out.planned = rows;
    else if (k.startsWith("routine")) out.routine = rows;
  }
  return out;
}

/** Guess what a CSV holds from its header row. */
export function readCsv(text: string): { kind: "structures" | "elements" | "planned" | "routine" | "unknown"; rows: Row[] } {
  const wb = XLSX.read(text, { type: "string", raw: false });
  const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { defval: null, raw: false })
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.trim(), typeof v === "string" && v.trim() !== "" && !isNaN(+v) ? +v : v === "" ? null : v])));
  const cols = new Set(rows.length ? Object.keys(rows[0]) : []);
  const kind = cols.has("structure_type") ? "structures" : cols.has("condition_code") ? "elements"
    : cols.has("year_of_work") ? "planned" : cols.has("routine_maintenance") ? "routine" : "unknown";
  return { kind, rows };
}

export function readWorkbookFile(buf: ArrayBuffer, name: string): Inventory | Partial<Inventory> {
  const opts = { type: "array" as const, cellFormula: false, cellHTML: false, cellStyles: false, cellText: false, bookVBA: false };
  const names = XLSX.read(buf, { ...opts, bookSheets: true }).SheetNames;
  if (names.includes("Structures") && names.includes("Main Page")) {
    // A SAVI workbook: read only the five input sheets (the full file has ~60 sheets).
    return readSaviWorkbook(XLSX.read(buf, { ...opts, sheets: ["Structures", "Elements", "Planned", "Routine", "Main Page"] }), name);
  }
  return readTidyWorkbook(XLSX.read(buf, opts), name);
}

export function toCsv(rows: Row[], cols?: string[]): string {
  const c = cols ?? (rows.length ? Object.keys(rows[0]) : []);
  const esc = (v: unknown) => { if (v === null || v === undefined) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [c.join(","), ...rows.map((r) => c.map((k) => esc(r[k])).join(","))].join("\n");
}
