/**
 * RFC 7515 Appendix A.2, "Example JWS Using RSASSA-PKCS1-v1_5 SHA-256".
 * Read from https://www.rfc-editor.org/rfc/rfc7515.txt on 2026-10-19.
 * Each string joins the display lines of the RFC text with no other change.
 * The public members only: the test needs `n` and `e`, never the private key.
 */

/** The `n` and `e` of the RSA key of A.2.1. */
export const RFC7515_A2_KEY = {
  kty: "RSA",
  n: [
    "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddx",
    "HmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMs",
    "D1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSH",
    "SXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdV",
    "MTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8",
    "NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ",
  ].join(""),
  e: "AQAB",
} as const;

/** The JWS Protected Header of A.2.1: `{"alg":"RS256"}`, with no `kid` and no `typ`. */
export const RFC7515_A2_HEADER = "eyJhbGciOiJSUzI1NiJ9";

/** The complete JWS of A.2.1 in the JWS Compact Serialization. */
export const RFC7515_A2_JWS = [
  "eyJhbGciOiJSUzI1NiJ9",
  ".",
  "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFt",
  "cGxlLmNvbS9pc19yb290Ijp0cnVlfQ",
  ".",
  "cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7",
  "AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4",
  "BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K",
  "0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqv",
  "hJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrB",
  "p0igcN_IoypGlUPQGe77Rw",
].join("");
