# The canonicalization vectors (plan 12d, Task 6)

These files hold the examples of two W3C Recommendations. `c14n.test.ts` reads each canonical form pair. `xml.test.ts` reads each refusal input.

## The fetch

| URL | Fetched (UTC) | HTTP status | Title of the page |
| --- | --- | --- | --- |
| https://www.w3.org/TR/xml-exc-c14n/ | 2026-10-20T08:15:18Z | 200 | Exclusive XML Canonicalization Version 1.0, W3C Recommendation 18 July 2002 |
| https://www.w3.org/TR/xml-c14n/ | 2026-10-20T08:15:18Z | 200 | Canonical XML Version 1.1 |
| https://www.w3.org/TR/2001/REC-xml-c14n-20010315 | 2026-10-20T08:15:32Z | 200 | Canonical XML Version 1.0, W3C Recommendation 15 March 2001 |

The undated URL `https://www.w3.org/TR/xml-c14n/` now gives Canonical XML 1.1. So the vectors come from the dated 1.0 URL. Each example of 1.0 section 3 (3.1 to 3.7) is also in section 3 of the 1.1 page with the same text. A script compared the HTML comment copy of each example on the two pages.

Each input and output is the text of an example block of the page. Each `&nbsp;` is a space, and each `<br/>` is a line end. No file ends with a line end.

## The license

The two pages give these lines, word for word:

- Exclusive XML Canonicalization 1.0: "Copyright © 2002 W3C® (MIT, INRIA, Keio), All Rights Reserved. W3C liability, trademark, document use and software licensing rules apply."
- Canonical XML 1.0: "Copyright © 2001 W3C® (MIT, INRIA, Keio), All Rights Reserved. W3C liability, trademark, document use and software licensing rules apply."

The document use rules: https://www.w3.org/Consortium/Legal/copyright-documents-19990405.

## Canonical form vectors

The apex is the element whose subtree the test canonicalizes, with no comments and an empty `inclusivePrefixes`.

- `c14n-3.2`: Canonical XML 1.0 section 3.2, "Whitespace in Document Content". The apex is `doc`. The input and the output are the text of the page.
- `c14n-3.4-body`: Canonical XML 1.0 section 3.4, "Character Modifications and Character References", with four lines removed. The input has no DOCTYPE, no CDATA `compute` line, no `normNames` line, and no `normId` line. The output has no `compute` text line, no `normNames` line, and no `normId` line. The DTD gives those two attributes their extra normalization, and the profile refuses CDATA. Every other line is the text of the page. The apex is `doc`.
- `exc-2.1-alone`: Exclusive XML Canonicalization 1.0 section 2.1, the first document. The page says that it is in canonical form. The output is the input without the three spaces of the page's indent before the apex. The apex is `n1:elem1`.
- `exc-2.1-enveloped`: section 2.1, the second document. The apex is `n1:elem1`. The output keeps the text nodes of this input and writes no `n0` declaration.
- `exc-2.2-first`: section 2.2, the first document. The apex is `n1:elem2`.
- `exc-2.2-second`: section 2.2, the second document. The apex is `n1:elem2`.

The page prints the output of section 2.2 "except for line wrapping". Each 2.2 output joins the wrapped start tag of the page with one space. Its text nodes are the text nodes of its input. The two inputs give one output, as the page says.

## Refusal vectors

Each input holds a construct outside the profile. The test expects the refusal that the parser meets first.

- `c14n-3.1`: section 3.1, "PIs, Comments, and Outside of Document Element". `processing_instruction` (the `xml-stylesheet` instruction comes before the DOCTYPE).
- `c14n-3.3`: section 3.3, "Start and End Tags". `doctype`.
- `c14n-3.4`: section 3.4, the full input. `doctype`.
- `c14n-3.5`: section 3.5, "Entity References". `doctype`.
- `c14n-3.6`: section 3.6, "UTF-8 Encoding". `encoding` (the declaration names ISO-8859-1).
- `c14n-3.7`: section 3.7, "Document Subsets". `doctype`.
