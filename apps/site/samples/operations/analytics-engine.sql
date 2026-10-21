-- Analytics Engine samples on write. Each row counts for _sample_interval
-- events, so a count is SUM(_sample_interval), never COUNT().
-- The blobs: blob1 name, blob2 route, blob3 outcome, blob4 code,
-- blob5 method, blob6 provider, blob7 family, blob8 traceId.

-- The password sign-ins that failed in the last hour.
SELECT SUM(_sample_interval) AS failures
FROM authtempo_events
WHERE index1 = 'sign_in' AND blob5 = 'password' AND blob3 = 'failure'
  AND timestamp > NOW() - INTERVAL '1' HOUR;

-- The limit hits of each family, for each day of the last week.
SELECT toStartOfDay(timestamp) AS day, blob7 AS family, SUM(_sample_interval) AS hits
FROM authtempo_events
WHERE index1 = 'limit.hit' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY day, family
ORDER BY day, hits DESC;

-- The answers of each route by outcome in the last hour.
SELECT blob2 AS route, blob3 AS outcome, SUM(_sample_interval) AS answers
FROM authtempo_events
WHERE index1 = 'request' AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY route, outcome
ORDER BY answers DESC;
