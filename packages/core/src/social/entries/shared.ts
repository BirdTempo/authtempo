/**
 * The JSON object of a provider answer, or a throw (plan 12i Task 22). A
 * throw names the provider and the step, never a value of the answer.
 */
export async function answerObject(res: Response, what: string): Promise<Record<string, unknown>> {
  if (!res.ok) throw new Error(`${what} answered ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error(`${what} is not an object`);
  return body as Record<string, unknown>;
}

/** A non-empty string field, or a throw that names the field. */
export function requiredText(body: Record<string, unknown>, key: string, what: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${what} has no ${key}`);
  return v;
}
