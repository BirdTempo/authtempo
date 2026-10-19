/** One mail of a sandbox. This module has no Workers type, so the Node tests render the mailbox page with it. */
export interface DemoMail {
  id: number;
  to: string;
  subject: string;
  text: string;
  at: number;
}
