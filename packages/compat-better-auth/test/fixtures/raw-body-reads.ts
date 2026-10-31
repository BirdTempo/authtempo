// A raw body read and a Response read that the source scan sees (ruling 46
// Minor 1 of the 12j lane). body-reads.test.ts scans this file alone.

export async function rawReads(request: Request, res: Response) {
  await res.clone().json();
  return request.clone().json();
}
