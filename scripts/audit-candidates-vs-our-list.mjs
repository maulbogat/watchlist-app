#!/usr/bin/env node
/**
 * Compare candidate lines (Title|Year and/or tt123... lines) to a shared list's items.
 * Prints summary + writes backups/audit-candidates-manual-review.txt for manual checking:
 *   - UNRESOLVED: no titleRegistry match
 *   - NOT_ON_OUR_LIST: resolved id not in shared list items
 *   - NOT_EXACT_MATCH: title|year text ≠ registry title/year (trimmed), or tt-line comment ≠ registry,
 *     or row was matched via a fallback resolver (title-only, year scan, etc.)
 *
 *   node -r dotenv/config scripts/audit-candidates-vs-our-list.mjs [path-to-lines.txt]
 *
 * Default path: scripts/audit-candidates-input.txt
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { getDb } from "./lib/admin-init.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultPath = join(__dirname, "audit-candidates-input.txt");
const reportPath = join(__dirname, "..", "backups", "audit-candidates-manual-review.txt");

function normTitle(t) {
  return String(t || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'");
}

async function main() {
  const path = process.argv[2] || defaultPath;
  if (!existsSync(path)) {
    console.error("Missing file:", path);
    process.exit(1);
  }
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\d+[\.)]\s+/, "").trim())
    .filter(Boolean);

  const db = getDb();
  const snap = await db.collection("sharedLists").get();
  const our = snap.docs.find((d) => {
    const n = String(d.data().name || "").toLowerCase();
    return n.includes("our list") || n === "our list";
  });
  if (!our) throw new Error("No shared list named like 'Our list'");
  const inList = new Set((our.data().items || []).map((m) => m?.registryId).filter(Boolean));

  const regSnap = await db.collection("titleRegistry").get();
  /** @type {Map<string, object>} */
  const regById = new Map(regSnap.docs.map((d) => [d.id, d.data() || {}]));
  /** @type {Map<string, string>} title|year -> registry id (first wins) */
  const byTitleYear = new Map();
  /** @type {Map<string, string[]>} normalized title -> [ids] */
  const byTitle = new Map();
  for (const d of regSnap.docs) {
    const x = d.data() || {};
    const t = normTitle(x.title);
    const y = x.year != null && x.year !== "" ? Number(x.year) : NaN;
    const yk = Number.isFinite(y) ? y : "";
    byTitleYear.set(`${t}|${yk}`, d.id);
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(d.id);
  }

  function resolveLine(line) {
    const tt = line.match(/\b(tt\d{7,})\b/i);
    if (tt) return { rid: tt[1].toLowerCase(), via: "tt" };
    if (line.includes("|")) {
      const pipe = line.indexOf("|");
      const title = line.slice(0, pipe).trim();
      const yearPart = line.slice(pipe + 1).trim().replace(/\([^)]*\)\s*$/, "").trim();
      const y = parseInt(yearPart, 10);
      const nk = `${normTitle(title)}|${Number.isFinite(y) ? y : yearPart}`;
      let rid = byTitleYear.get(nk);
      if (rid) return { rid, via: "title|year" };
      const yAlt = Number.isFinite(y) ? y : "";
      rid = byTitleYear.get(`${normTitle(title)}|${yAlt}`);
      if (rid) return { rid, via: "title|year~alt" };
      const candidates = byTitle.get(normTitle(title)) || [];
      if (candidates.length === 1) return { rid: candidates[0], via: "title-only" };
      if (Number.isFinite(y) && candidates.length > 1) {
        for (const id of candidates) {
          const yr = regById.get(id)?.year;
          if (Number(yr) === y) return { rid: id, via: "title+year-scan" };
        }
      }
      return { rid: null, via: null };
    }
    return { rid: null, via: null };
  }

  /** @type {{ section: string; line: string; detail: string }[]} */
  const reportRows = [];

  const seenRid = new Map();
  const notInList = [];
  const unresolved = [];
  const inListOk = [];

  for (const line of lines) {
    const { rid, via } = resolveLine(line);
    if (!rid) {
      unresolved.push(line);
      reportRows.push({
        section: "UNRESOLVED (no titleRegistry match for this line)",
        line,
        detail: "",
      });
      continue;
    }

    const reg = regById.get(rid) || {};
    const regTitle = String(reg.title ?? "").trim();
    const regYear = reg.year;

    const ttMatch = line.match(/\b(tt\d{7,})\b/i);
    if (ttMatch) {
      const comment = line.match(/[—–-]\s*(.+?)\s*\((\d{4})\)\s*$/);
      if (comment) {
        const cTitle = comment[1].trim();
        const cYear = parseInt(comment[2], 10);
        const titleOk = cTitle === regTitle;
        const yearOk = !Number.isFinite(cYear) || Number(regYear) === cYear;
        if (!titleOk || !yearOk) {
          reportRows.push({
            section: "NOT_EXACT: tt-line comment ≠ registry title/year",
            line,
            detail: `registry: "${regTitle}" (${regYear})`,
          });
        }
      }
    } else if (line.includes("|")) {
      const pipe = line.indexOf("|");
      const cTitle = line.slice(0, pipe).trim();
      const yearPart = line.slice(pipe + 1).trim().replace(/\([^)]*\)\s*$/, "").trim();
      const cYear = parseInt(yearPart, 10);
      const titleExact = cTitle === regTitle;
      const yearExact = !Number.isFinite(cYear) || Number(regYear) === cYear;
      const fallback = via !== "title|year";
      if (!titleExact || !yearExact || fallback) {
        const bits = [];
        if (!titleExact) bits.push(`title: you "${cTitle}" vs registry "${regTitle}"`);
        if (!yearExact) bits.push(`year: you ${Number.isFinite(cYear) ? cYear : yearPart} vs registry ${regYear}`);
        if (fallback) bits.push(`matched via: ${via} (not exact key lookup)`);
        reportRows.push({
          section: "NOT_EXACT: Title|Year line vs registry",
          line,
          detail: bits.join(" | "),
        });
      }
    }

    if (seenRid.has(rid)) continue;
    seenRid.set(rid, line);
    if (inList.has(rid)) inListOk.push({ rid, line, via });
    else {
      notInList.push({ rid, line, via });
      reportRows.push({
        section: "NOT_ON_OUR_LIST (resolved id, but not in shared list items)",
        line,
        detail: `${rid} — "${regTitle}" (${regYear})`,
      });
    }
  }

  console.log(`Our list "${our.data().name}" (${our.id}): ${inList.size} items in Firestore`);
  console.log(`Candidates file: ${path} (${lines.length} non-empty lines)`);
  console.log(`Unique registry ids from candidates: ${seenRid.size}`);
  console.log(`Resolved and IN list: ${inListOk.length}`);
  console.log(`Resolved and NOT in list: ${notInList.length}`);
  console.log(`Unresolved (no registry match): ${unresolved.length}`);
  console.log(`Report lines (manual review): ${reportRows.length}`);
  console.log(`Wrote: ${reportPath}`);

  if (notInList.length) {
    console.log("\n--- NOT IN OUR LIST (resolved id) ---");
    for (const { rid, line, via } of notInList) {
      const x = regById.get(rid) || {};
      console.log(`${rid}\t(${x.title}, ${x.year})\tvia ${via}\t| ${line}`);
    }
  }
  if (unresolved.length) {
    console.log("\n--- UNRESOLVED (check spelling / year vs titleRegistry) ---");
    for (const u of unresolved) console.log(u);
  }

  mkdirSync(dirname(reportPath), { recursive: true });
  const header = [
    `Generated: ${new Date().toISOString()}`,
    `Candidates file: ${path}`,
    `Our list: ${our.data().name} (${our.id})`,
    "",
    "Below: every line that needs manual review — unresolved, not on list, or text not exactly equal to titleRegistry.",
    "Same line may appear under multiple sections if it hits multiple rules.",
    "",
    "=".repeat(80),
    "",
  ].join("\n");

  const body = reportRows
    .map((r) => `[${r.section}]\n  Line: ${r.line}${r.detail ? `\n  ${r.detail}` : ""}\n`)
    .join("\n");

  writeFileSync(reportPath, header + body, "utf-8");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
