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
