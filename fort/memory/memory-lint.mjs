#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const root = process.argv[2] ?? process.cwd();
const factsDirectory = join(root, "fort", "memory", "facts");
const required = ["source", "declared-by", "date", "origin"];
const coreFactOverheadLines = 12;
const coreFactBudget = 30;
const coreLineBudget = 300;
const failures = [];

function parseFact(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (match === null) return null;
  const frontmatter = Object.fromEntries(
    [...match[1].matchAll(/^([a-z-]+):\s*(.*)$/gmu)].map(([, key, value]) => [
      key,
      value === "null" ? null : value.replace(/^"|"$/gu, ""),
    ]),
  );
  const provenance =
    /^provenance:\s*\r?\n((?:\s+.+\r?\n?)+)/mu.exec(match[1])?.[1] ?? "";
  for (const [, key, value] of provenance.matchAll(/^\s+([a-z-]+):\s*(.*)$/gmu))
    frontmatter[key] = value.replace(/^"|"$/gu, "");
  const scope = /^scope:\s*\r?\n((?:\s+.+\r?\n?)+)/mu.exec(match[1])?.[1] ?? "";
  return { frontmatter, scope, body: match[2].trim() };
}

function scopeSeats(scope) {
  const match = /^\s+seats:\s*\[([^\]]*)\]\s*$/mu.exec(scope);
  if (match === null) return [];
  return match[1]
    .split(",")
    .map((seat) => seat.trim())
    .filter(Boolean);
}

let files = [];
try {
  files = (await readdir(factsDirectory))
    .filter((file) => file.endsWith(".md"))
    .sort();
} catch {
  failures.push("fort/memory/facts is unreadable");
}
let seats = [];
try {
  seats = (await readdir(join(root, "fort", "seats")))
    .filter((file) => file.endsWith(".md"))
    .map((file) => basename(file, ".md"))
    .sort();
} catch {
  // A partial fixture may have facts before its seat directory is founded.
}
const coreBySeat = new Map(seats.map((seat) => [seat, { facts: 0, lines: 0 }]));
let sharedCoreFacts = 0;
let sharedCoreLines = 0;
const supersededFactKeys = [];
for (const file of files) {
  const path = join(factsDirectory, file);
  const parsed = parseFact(await readFile(path, "utf8"));
  if (parsed === null) {
    failures.push(`${path}: missing YAML frontmatter`);
    continue;
  }
  const { frontmatter, scope, body } = parsed;
  const key = basename(file, ".md");
  if (frontmatter.key !== key)
    failures.push(`${path}: key must equal filename`);
  if (!["active", "superseded"].includes(frontmatter.status))
    failures.push(`${path}: invalid status`);
  if (!["core", "on-demand"].includes(frontmatter.tier))
    failures.push(`${path}: invalid tier`);
  if (scope.trim() === "") failures.push(`${path}: scope is required`);
  if (body === "") failures.push(`${path}: body is required`);
  for (const field of required)
    if (!frontmatter[field])
      failures.push(`${path}: provenance.${field} is required`);
  if (!["trusted", "untrusted"].includes(frontmatter.origin))
    failures.push(`${path}: invalid provenance.origin`);
  if (frontmatter.origin === "untrusted" && frontmatter.tier === "core")
    failures.push(`${path}: untrusted facts cannot be core`);
  if (frontmatter.status === "superseded" && !frontmatter["superseded-by"])
    failures.push(`${path}: superseded facts need superseded-by`);
  if (frontmatter.status === "superseded") supersededFactKeys.push(key);
  if (
    frontmatter["superseded-by"] &&
    !files.includes(`${frontmatter["superseded-by"]}.md`)
  )
    failures.push(`${path}: superseded-by does not resolve`);
  if (frontmatter.tier === "core") {
    const factSeats = scopeSeats(scope);
    const factLines = body.split(/\r?\n/u).length + coreFactOverheadLines;
    const shared = factSeats.includes("all");
    if (shared) {
      sharedCoreFacts += 1;
      sharedCoreLines += factLines;
    }
    for (const seat of factSeats) {
      if (seat === "all" || shared) continue;
      if (!coreBySeat.has(seat)) coreBySeat.set(seat, { facts: 0, lines: 0 });
      const total = coreBySeat.get(seat);
      total.facts += 1;
      total.lines += factLines;
    }
  }
}
const retiredReferences = ["fort/remember.md", ...supersededFactKeys];
for (const instructionFile of ["AGENTS.md", "CLAUDE.md"]) {
  const path = join(root, instructionFile);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    continue;
  }
  for (const reference of retiredReferences)
    if (text.includes(reference))
      failures.push(`${path}: references retired memory item ${reference}`);
}
console.log(
  `core shared floor [all]: ${sharedCoreFacts} facts / ${sharedCoreLines} lines`,
);
for (const [seat, ownCore] of coreBySeat) {
  const facts = ownCore.facts + sharedCoreFacts;
  const lines = ownCore.lines + sharedCoreLines;
  console.log(`core budget [${seat}]: ${facts} facts / ${lines} lines`);
  if (facts > coreFactBudget)
    failures.push(
      `core tier exceeds ${coreFactBudget} facts for seat ${seat} (${facts})`,
    );
  if (lines > coreLineBudget)
    failures.push(
      `core tier exceeds ${coreLineBudget} lines for seat ${seat} (${lines})`,
    );
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
