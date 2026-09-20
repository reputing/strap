import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';

export async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

/**
 * Strips things that identify the machine or the account out of text that may
 * be written to a log file or copied into a diagnostics report.
 *
 * This is deliberately conservative: it is easier to explain a `%USER%` in a
 * log line than to explain why a support bundle contained an auth ticket.
 */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;

  const home = homedir();
  if (home && home.length > 3) {
    out = out.split(home).join('%USER_HOME%');
  }

  out = out
    .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/g, '$1%USER%')
    .replace(/(\/home\/)[^/\s"']+/g, '$1%USER%')
    .replace(/(\/Users\/)[^/\s"']+/g, '$1%USER%')
    // Roblox join tickets and auth cookies must never reach a log or a report.
    .replace(/(gameinfo:)[^\s+"']+/gi, '$1%TICKET%')
    .replace(/(\.ROBLOSECURITY=)[^;\s"']+/gi, '$1%REDACTED%')
    .replace(/(browsertrackerid:)\d+/gi, '$1%ID%')
    .replace(/(accesscode[=:])[^\s&"']+/gi, '$1%REDACTED%')
    .replace(/(authorization:\s*bearer\s+)\S+/gi, '$1%REDACTED%');

  return out;
}
