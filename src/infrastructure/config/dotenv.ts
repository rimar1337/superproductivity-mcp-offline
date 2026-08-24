import { readFileSync } from 'node:fs';
import type { EnvSource } from './config.js';

/**
 * A minimal `.env` reader.
 *
 * Deliberately literal: a value is everything after the first `=`, with only
 * matched surrounding quotes removed. No variable expansion, no command
 * substitution.
 *
 * That is the whole point. Nextcloud app passwords routinely contain `$`, and
 * `source .env` in a shell expands `$Nyd0DQjp…` to the empty string — producing
 * an authentication failure that looks exactly like a wrong password and sends
 * people hunting in the wrong place. Reading the file ourselves removes that
 * class of confusion entirely.
 *
 * Existing `process.env` values win, so a real environment variable always
 * beats the file.
 */
export const parseDotenv = (contents: string): Record<string, string> => {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf('=');
    if (separator === -1) {
      continue;
    }

    const key = line
      .slice(0, separator)
      .trim()
      .replace(/^export\s+/, '');
    if (key === '') {
      continue;
    }

    let value = line.slice(separator + 1).trim();
    const isQuoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (isQuoted) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
};

/**
 * Loads `.env` into a fresh env object, without mutating `process.env`.
 *
 * A missing file is not an error: the server may be configured entirely
 * through real environment variables, which is the normal case when it runs
 * under a process manager or inside a container.
 */
export const loadEnvFile = (path: string, base: EnvSource = process.env): EnvSource => {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return base;
  }
  return { ...parseDotenv(contents), ...stripUndefined(base) };
};

const stripUndefined = (source: EnvSource): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};
