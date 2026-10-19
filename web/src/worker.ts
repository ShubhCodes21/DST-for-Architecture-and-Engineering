// Web Worker entry: hosts the EngineService and answers RPC calls from the page.
import { EngineService } from "./engine/service";
import ruleset from "../data/ruleset.json";
import sample from "../data/sample.json";
import lamp from "../test/fixtures/lamp_results.json";
import summary from "../test/fixtures/summary.json";

const svc = new EngineService(ruleset as any, sample, { lamp: lamp as any, summary });
const post = (m: any) => (self as any).postMessage(m);
svc.emit = (event, data) => post({ event, data });

const METHODS: Record<string, (...a: any[]) => any> = {
  meta: () => svc.meta(),
  loadSample: () => svc.loadSample(),
  importFile: (buf: ArrayBuffer, name: string) => svc.importFile(buf, name),
  importCsvs: (files: any[]) => svc.importCsvs(files),
  state: () => svc.state(),
  setSettings: (p: any, label?: string) => svc.setSettings(p, label),
  decide: (d: any) => svc.decide(d),
  verify: () => svc.verify(),
  structures: (q: any) => svc.structures(q),
  structure: (id: string) => svc.structure(id),
  explainPriority: (id: string) => svc.explainPriority(id),
  scenario: (p: any, label?: string) => svc.scenario(p, label),
  uncertainty: (runs?: number, seed?: number) => svc.uncertainty(runs, seed),
  w1Record: (id: string, ch: any) => svc.w1Record(id, ch),
  w1Evaluate: (id: string) => svc.w1Evaluate(id),
  w1Programme: (id: string) => svc.w1Programme(id),
  w1LongTerm: (id: string) => svc.w1LongTerm(id),
  w1Commit: (id: string, by?: string) => svc.w1Commit(id, by),
  w1Discard: (id: string) => svc.w1Discard(id),
  lookups: () => svc.lookups(),
  newBlank: (name?: string) => svc.newBlank(name),
  inventoryTables: () => svc.inventoryTables(),
  checkRecord: (t: any, row: any, original?: any) => svc.checkRecord(t, row, original),
  saveStructure: (row: any, original?: any) => svc.saveStructure(row, original),
  deleteStructure: (id: string) => svc.deleteStructure(id),
  saveElement: (row: any, original?: any) => svc.saveElement(row, original),
  deleteElement: (seq: any) => svc.deleteElement(seq),
  savePlanned: (rows: any[]) => svc.savePlanned(rows),
  saveRoutine: (rows: any[]) => svc.saveRoutine(rows),
  saveInventorySettings: (p: any) => svc.saveInventorySettings(p),
  validationIssues: () => svc.validation?.issues ?? [],
  workPlanCsvRows: () => svc.workPlanCsvRows(),
  programmeCsvRows: () => svc.programmeCsvRows(),
};

(self as any).onmessage = async (ev: MessageEvent) => {
  const { id, method, args } = ev.data || {};
  const t = performance.now();
  try {
    const fn = METHODS[method];
    if (!fn) throw new Error(`Unknown engine method ${method}`);
    const result = await fn(...(args || []));
    post({ id, ok: true, result, ms: performance.now() - t });
  } catch (e: any) {
    post({ id, ok: false, error: String(e?.message ?? e), ms: performance.now() - t });
  }
};
