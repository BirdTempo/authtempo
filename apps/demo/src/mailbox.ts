import type { MailPort } from "@authtempo/core";

/** The mailbox keeps the newest mails of a sandbox only (Task 11 moves the number into DEMO_LIMITS). */
const KEEP = 50;

/** The mail table of a sandbox. create() of the sandbox runs it. */
export const MAILBOX_DDL =
  "CREATE TABLE demo_mail (id INTEGER PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)";

export interface DemoMail {
  id: number;
  to: string;
  subject: string;
  text: string;
  at: number;
}

export interface Mailbox {
  send: MailPort["send"];
  /** The mails of the sandbox, newest first. */
  list(): DemoMail[];
}

/**
 * The mail port of a sandbox. send writes a row into the store of the
 * sandbox and nothing more: no mail leaves the Worker.
 */
export function createMailbox(sql: SqlStorage): Mailbox {
  return {
    async send(message) {
      sql.exec(
        "INSERT INTO demo_mail (to_addr, subject, text, at) VALUES (?, ?, ?, ?)",
        message.to,
        message.subject,
        message.text,
        Date.now(),
      );
      sql.exec(
        "DELETE FROM demo_mail WHERE id NOT IN (SELECT id FROM demo_mail ORDER BY id DESC LIMIT ?)",
        KEEP,
      );
    },
    list() {
      return sql
        .exec<{ id: number; to_addr: string; subject: string; text: string; at: number }>(
          "SELECT id, to_addr, subject, text, at FROM demo_mail ORDER BY id DESC",
        )
        .toArray()
        .map((r) => ({ id: r.id, to: r.to_addr, subject: r.subject, text: r.text, at: r.at }));
    },
  };
}
