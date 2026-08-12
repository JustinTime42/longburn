#!/usr/bin/env node
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.argv[2] ?? process.cwd();
const memory = join(root, "fort", "memory");
const factsDirectory = join(memory, "facts");
const current = join(memory, "current.md");
const index = join(memory, "index.db");

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareBeads(left, right) {
  const leftPriority = Number(left.priority);
  const rightPriority = Number(right.priority);
  return (
    (Number.isFinite(leftPriority) ? leftPriority : 4) -
      (Number.isFinite(rightPriority) ? rightPriority : 4) ||
    compare(left.id, right.id)
  );
}

function hasGateLabel(bead) {
  return (
    Array.isArray(bead.labels) &&
    bead.labels.some((label) => /^gate-[1-3]$/u.test(label))
  );
}

function parseFact(text, path) {
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
  for (const [, key, value] of provenance.matchAll(
    /^\s+([a-z-]+):\s*(.*)$/gmu,
  )) {
    frontmatter[key] = value.replace(/^"|"$/gu, "");
  }
  const scope = /^scope:\s*\r?\n((?:\s+.+\r?\n?)+)/mu.exec(match[1])?.[1] ?? "";
  for (const [, key, value] of scope.matchAll(/^\s+([a-z-]+):\s*(.*)$/gmu)) {
    frontmatter[key] = value;
  }
  return { ...frontmatter, body: match[2].trim(), path };
}

function section(text, heading) {
  const pattern =
    heading === "State of work" ? "State of(?: [^\\r\\n]*?)?work" : heading;
  const match = new RegExp(
    `^##\\s+(?:\\d+\\.\\s+)?${pattern}(?:\\b[^\\r\\n]*)?\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "imu",
  ).exec(text);
  return match?.[1].trim() ?? "";
}

function handoffStamp(text, fallback) {
  const heading = /^# Handoff: .+? (\S+)/mu.exec(text)?.[1];
  const instant = heading === undefined ? Number.NaN : Date.parse(heading);
  return Number.isNaN(instant) ? fallback : instant;
}

function markdownSections(text, fallback = "document") {
  const matches = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)];
  if (matches.length === 0) return [{ heading: fallback, body: text.trim() }];
  return matches.map((match, index) => ({
    heading: match[1].trim(),
    body: text
      .slice(match.index + match[0].length, matches[index + 1]?.index)
      .trim(),
  }));
}

function addMarkdownRows(rows, metadata, text, fallback) {
  for (const { heading, body } of markdownSections(text, fallback)) {
    if (body) rows.push({ ...metadata, section: heading, snippet: body });
  }
}

async function files(directory, extension, gaps, required = false) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        found.push(...(await files(path, extension, gaps)));
      else if (entry.isFile() && entry.name.endsWith(extension))
        found.push(path);
    }
    return found.sort(compare);
  } catch (error) {
    if (required || (await exists(directory)))
      gaps.push({
        source: relative(root, directory),
        reason: String(error.message),
      });
    return [];
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function read(path, gaps) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    gaps.push({ source: relative(root, path), reason: String(error.message) });
    return null;
  }
}

async function build() {
  const rows = [];
  const gaps = [];
  const facts = [];
  for (const path of await files(factsDirectory, ".md", gaps, true)) {
    const text = await read(path, gaps);
    if (text === null) continue;
    const parsed = parseFact(text, relative(root, path));
    if (parsed === null) {
      gaps.push({
        source: relative(root, path),
        reason: "unparseable fact frontmatter",
      });
      continue;
    }
    facts.push(parsed);
    addMarkdownRows(
      rows,
      {
        source: parsed.path,
        ts: parsed.date ?? "",
        actor: parsed["declared-by"] ?? "",
        seat: "",
        provenance: parsed.source ?? parsed.path,
        scopeSeats: /^\[?(.*?)\]?$/u.exec(parsed.seats ?? "")?.[1] ?? "",
        scopeTopics: /^\[?(.*?)\]?$/u.exec(parsed.topics ?? "")?.[1] ?? "",
        scopeBeads: /^\[?(.*?)\]?$/u.exec(parsed.beads ?? "")?.[1] ?? "",
      },
      parsed.body,
      "fact",
    );
  }

  const beadsPath = join(root, ".beads", "issues.jsonl");
  const open = [];
  const beads = await read(beadsPath, gaps);
  if (beads !== null) {
    for (const [lineNumber, line] of beads.split(/\r?\n/u).entries()) {
      if (line.trim() === "") continue;
      try {
        const bead = JSON.parse(line);
        if (
          ["open", "in_progress", "blocked"].includes(bead.status) &&
          typeof bead.id === "string"
        )
          open.push(bead);
        if (typeof bead.id === "string")
          rows.push({
            source: ".beads/issues.jsonl",
            ts: bead.updated_at ?? "",
            actor: bead.assignee ?? "",
            seat: "",
            section: bead.id,
            provenance: `.beads/issues.jsonl:${lineNumber + 1}`,
            scopeSeats: "",
            scopeTopics: "",
            scopeBeads: bead.id,
            snippet: `${bead.id}: ${bead.title ?? ""}`,
          });
      } catch (error) {
        gaps.push({
          source: `.beads/issues.jsonl:${lineNumber + 1}`,
          reason: `unparseable JSON: ${error.message}`,
        });
      }
    }
  }
  const snapshot = [
    ...new Map(
      [
        ...open
          .filter((bead) => bead.status === "in_progress")
          .sort(compareBeads),
        ...open.filter(hasGateLabel).sort(compareBeads),
        ...open
          .filter((bead) => bead.status === "open")
          .sort(compareBeads)
          .slice(0, 15),
      ].map((bead) => [bead.id, bead]),
    ).values(),
  ];

  const handoffDirectory = join(root, "fort", "handoffs");
  const newest = new Map();
  for (const path of await files(handoffDirectory, ".md", gaps, true)) {
    const file = path.slice(handoffDirectory.length + 1);
    const seat = /^([a-z0-9_-]+)-\d{4}-\d{2}-\d{2}/iu.exec(file)?.[1];
    if (seat === undefined) continue;
    const text = await read(path, gaps);
    if (text === null) continue;
    const stamp = handoffStamp(text, 0);
    const old = newest.get(seat);
    if (
      old === undefined ||
      stamp > old.stamp ||
      (stamp === old.stamp && compare(file, old.file) > 0)
    )
      newest.set(seat, { file, text, stamp });
    for (const heading of ["State of work", "Next actions"]) {
      const body = section(text, heading);
      if (body)
        rows.push({
          source: relative(root, path),
          ts: new Date(stamp).toISOString(),
          actor: "",
          seat,
          section: heading,
          provenance: relative(root, path),
          scopeSeats: seat,
          scopeTopics: "",
          scopeBeads: "",
          snippet: body,
        });
    }
  }
  for (const [seat, handoff] of newest) {
    for (const heading of ["State of work", "Next actions"]) {
      if (!section(handoff.text, heading)) {
        gaps.push({
          source: `fort/handoffs/${handoff.file}`,
          reason: `latest ${seat} handoff lacks a parseable ${heading} section`,
        });
      }
    }
  }

  const incidents = [];
  const eventsDirectory = join(root, "fort", "events");
  for (const path of await files(eventsDirectory, ".jsonl", gaps, true)) {
    const text = await read(path, gaps);
    if (text === null) continue;
    for (const [lineNumber, line] of text.split(/\r?\n/u).entries()) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line);
        if (event.category === "incident")
          incidents.push({
            event,
            file: relative(root, path),
            duplicateKey: `${event.category}\u0000${event.target ?? ""}\u0000${event.detail ?? ""}`,
          });
        rows.push({
          source: relative(root, path),
          ts: event.ts ?? "",
          actor: event.actor ?? "",
          seat: event.seat ?? "",
          section: event.category ?? "event",
          provenance: `${relative(root, path)}:${lineNumber + 1}`,
          scopeSeats: event.seat ?? "",
          scopeTopics: event.category ?? "",
          scopeBeads: event.target ?? "",
          snippet: event.detail ?? "",
        });
      } catch (error) {
        gaps.push({
          source: `${relative(root, path)}:${lineNumber + 1}`,
          reason: `unparseable JSON: ${error.message}`,
        });
      }
    }
  }

  const annalsDirectory = join(root, "fort", "annals");
  for (const path of await files(annalsDirectory, ".md", gaps, true)) {
    const text = await read(path, gaps);
    if (text !== null)
      addMarkdownRows(
        rows,
        {
          source: relative(root, path),
          ts: "",
          actor: "",
          seat: "",
          provenance: relative(root, path),
          scopeSeats: "",
          scopeTopics: "",
          scopeBeads: "",
        },
        text,
        "annal",
      );
  }
  const interactionsPath = join(root, "interactions.jsonl");
  if (await exists(interactionsPath)) {
    const text = await read(interactionsPath, gaps);
    if (text !== null)
      rows.push({
        source: "interactions.jsonl",
        ts: "",
        actor: "",
        seat: "",
        section: "interactions",
        provenance: "interactions.jsonl",
        scopeSeats: "",
        scopeTopics: "",
        scopeBeads: "",
        snippet: text,
      });
  } else {
    gaps.push({
      source: "interactions.jsonl",
      reason: "missing or not configured",
    });
  }

  await mkdir(memory, { recursive: true });
  const indexTemp = `${index}.tmp`;
  await rm(indexTemp, { force: true });
  const db = new DatabaseSync(indexTemp);
  try {
    db.exec(
      "CREATE TABLE source (source TEXT NOT NULL, ts TEXT NOT NULL, actor TEXT NOT NULL, seat TEXT NOT NULL, section TEXT NOT NULL, provenance TEXT NOT NULL, scope_seats TEXT NOT NULL, scope_topics TEXT NOT NULL, scope_beads TEXT NOT NULL, snippet TEXT NOT NULL); CREATE TABLE gaps (source TEXT NOT NULL, reason TEXT NOT NULL);",
    );
    const insert = db.prepare(
      "INSERT INTO source VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows)
      insert.run(
        row.source,
        row.ts,
        row.actor,
        row.seat,
        row.section,
        row.provenance,
        row.scopeSeats,
        row.scopeTopics,
        row.scopeBeads,
        row.snippet,
      );
    const insertGap = db.prepare("INSERT INTO gaps VALUES (?, ?)");
    for (const gap of gaps.sort(
      (left, right) =>
        compare(left.source, right.source) ||
        compare(left.reason, right.reason),
    ))
      insertGap.run(gap.source, gap.reason);
  } finally {
    db.close();
  }

  const lines = [
    "# Current operational truth",
    "",
    "_Generated by `fort/memory/consolidate-memory.mjs`; do not edit. Every item links to its source._",
    "",
    "## Core facts",
    "",
  ];
  for (const item of facts
    .filter((item) => item.status === "active" && item.tier === "core")
    .sort((left, right) => compare(left.key, right.key)))
    lines.push(
      `- ${item.body.replaceAll("\n", " ")} — [${item.path}](${item.path})`,
    );
  lines.push(
    "",
    "## Open work",
    "",
    ...snapshot.map(
      (bead) =>
        `- ${bead.id} [${bead.status}]: ${bead.title ?? "(untitled)"} — [${bead.id}](bead:${bead.id})`,
    ),
    `${snapshot.length} of ${open.length} open beads shown; full list via bd ready`,
  );
  lines.push("", "## Latest handoffs", "");
  for (const [seat, handoff] of [...newest].sort(([left], [right]) =>
    compare(left, right),
  )) {
    for (const heading of ["State of work", "Next actions"]) {
      const body = section(handoff.text, heading);
      if (body)
        lines.push(
          `- ${seat} — ${heading}: ${body.replaceAll("\n", " ")} — [fort/handoffs/${handoff.file}](fort/handoffs/${handoff.file})`,
        );
    }
  }
  lines.push(
    "",
    "## Incident log — resolution linkage not yet implemented",
    "",
    ...incidents
      .sort(
        (left, right) =>
          compare(String(left.event.ts), String(right.event.ts)) ||
          compare(left.file, right.file),
      )
      .filter(
        ({ duplicateKey }, index, sorted) =>
          index ===
          sorted.findIndex((item) => item.duplicateKey === duplicateKey),
      )
      .map(
        ({ event, file }) =>
          `- ${event.detail ?? "incident"} — [${file}](${file})`,
      ),
  );
  lines.push(
    "",
    "## Index build gaps",
    "",
    "- Incident resolution linkage is not implemented; the incident log above is historical and not an unresolved-work list. — [fort/memory/consolidate-memory.mjs](fort/memory/consolidate-memory.mjs)",
    ...gaps
      .sort(
        (left, right) =>
          compare(left.source, right.source) ||
          compare(left.reason, right.reason),
      )
      .map(
        (gap) =>
          `- ${gap.source}: ${gap.reason} — [${gap.source.split(":")[0]}](${gap.source.split(":")[0]})`,
      ),
    "",
  );
  const currentTemp = `${current}.tmp`;
  await writeFile(currentTemp, `${lines.join("\n")}\n`, "utf8");
  await rename(indexTemp, index);
  await rename(currentTemp, current);
  for (const gap of gaps)
    console.warn(`memory index gap: ${gap.source}: ${gap.reason}`);
}

await build();
