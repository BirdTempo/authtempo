// The forms of a raw body read that the source scan finds (ruling 46 Minor 1
// of the 12j lane). body-reads.test.ts scans this file alone. No test runs it.

export async function rawReads(request: Request, maybe: Request | null, res: Response) {
  await request.json();
  await request.text();
  await request.formData();
  await request.arrayBuffer();
  await request.blob();
  await request.clone().json();
  void request.body;
  const { body } = request;
  await maybe?.text();
  // A Response read is not a request body read.
  await res.json();
  await res.clone().text();
  return body;
}

// The forms of ruling 51 Low 2, which the scan of ruling 46 missed.
export async function moreReads(request: Request, tagged: Request & { tag?: 1 }) {
  // biome-ignore lint/complexity/useLiteralKeys: the scan must find an element access with a literal name.
  await request["json"]();
  await tagged.text();
  const bound = request.arrayBuffer.bind(request);
  const ctx = { request };
  const {
    request: { body: nested },
  } = ctx;
  let assigned: unknown = null;
  ({ body: assigned } = request);
  return [bound, nested, assigned];
}

export const fromParameter = ({ body }: Request) => body;

// The forms of ruling 59 Low 3, which the scan of ruling 51 missed.
class SubRequest extends Request {}

export async function typedReads<T extends Request>(generic: T, sub: SubRequest) {
  await generic.json();
  await sub.text();
  // biome-ignore lint/complexity/useLiteralKeys: the scan must find a computed name with a literal.
  const { ["body"]: computed } = generic;
  const key = "arrayBuffer" as const;
  await generic[key]();
  return [computed, Reflect.get(sub, "body")];
}

// The note of rr-12j-bodycap4: an alias of Reflect.get, which the scan of ruling 59 missed.
export function aliasedReflect(request: Request, response: Response) {
  const { get } = Reflect;
  const read = Reflect.get;
  return [get(request, "body"), read(request, "text"), get(response, "body")];
}
