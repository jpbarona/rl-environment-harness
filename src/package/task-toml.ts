/**
 * Minimal TOML emit/parse for the task descriptor (task.toml).
 *
 * Supported subset: [section] headers (dot-joined), key = "string" or
 * key = integer, blank lines, and # comments. Strings must not contain
 * double quotes or backslashes. This covers exactly what the exporter
 * emits; anything outside the subset fails validation loudly rather
 * than being guessed at.
 */

export type TomlValue = string | number;
export type TomlDocument = Map<string, Map<string, TomlValue>>;

export function renderTaskToml(entries: ReadonlyArray<{ readonly section: string; readonly key: string; readonly value: TomlValue }>): string {
  const lines: string[] = [];
  let currentSection: string | null = null;
  for (const entry of entries) {
    if (entry.section !== currentSection) {
      lines.push(`[${entry.section}]`);
      currentSection = entry.section;
    }
    if (typeof entry.value === "number") {
      lines.push(`${entry.key} = ${entry.value}`);
    } else {
      assertPlainTomlString(entry.value, `${entry.section}.${entry.key}`);
      lines.push(`${entry.key} = "${entry.value}"`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parseTaskToml(text: string): TomlDocument {
  const doc: TomlDocument = new Map();
  let section = "";
  const sectionFor = (name: string): Map<string, TomlValue> => {
    let map = doc.get(name);
    if (map === undefined) {
      map = new Map();
      doc.set(name, map);
    }
    return map;
  };
  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1] ?? "";
      sectionFor(section);
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (pair === null || section === "") {
      throw new Error(`task.toml line ${index + 1} is not in the supported subset: ${JSON.stringify(rawLine)}`);
    }
    const key = pair[1] ?? "";
    const rawValue = pair[2] ?? "";
    const quoted = /^"([^"\\]*)"$/.exec(rawValue);
    if (quoted !== null) {
      sectionFor(section).set(key, quoted[1] ?? "");
      continue;
    }
    if (/^-?\d+$/.test(rawValue)) {
      sectionFor(section).set(key, Number(rawValue));
      continue;
    }
    throw new Error(`task.toml line ${index + 1} has an unsupported value: ${JSON.stringify(rawValue)}`);
  }
  return doc;
}

export function tomlValue(doc: TomlDocument, section: string, key: string): TomlValue | undefined {
  return doc.get(section)?.get(key);
}

function assertPlainTomlString(value: string, label: string): void {
  if (value.includes('"') || value.includes("\\")) {
    throw new Error(`task.toml value for ${label} contains a quote or backslash, which the supported subset forbids`);
  }
}
