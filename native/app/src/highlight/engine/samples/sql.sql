-- Balance per account, with the latest posting.
CREATE TABLE IF NOT EXISTS entries (
    id          BIGSERIAL PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    cents       BIGINT  NOT NULL DEFAULT 0,
    memo        VARCHAR(255),
    posted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_entries_account ON entries (account_id, posted_at DESC);

/* TODO: partition by month */
WITH latest AS (
    SELECT account_id, MAX(posted_at) AS last_posted
    FROM entries
    GROUP BY account_id
)
SELECT a.name,
       COALESCE(SUM(e.cents), 0) / 100.0 AS balance,
       l.last_posted
FROM accounts AS a
LEFT JOIN entries e ON e.account_id = a.id AND e.memo NOT LIKE 'void%'
JOIN latest l ON l.account_id = a.id
WHERE a.closed_at IS NULL
  AND a.created_at >= '2026-01-01'
  AND a.kind IN ('checking', 'savings')
GROUP BY a.name, l.last_posted
HAVING SUM(e.cents) <> 0
ORDER BY balance DESC
LIMIT 20;

UPDATE accounts SET closed_at = now() WHERE id = 42 RETURNING id;

INSERT INTO entries (account_id, cents, memo)
VALUES ($1, -250, 'refund'), ($2, 1_000, NULL)
ON CONFLICT DO NOTHING;

SELECT account_id,
       CASE WHEN cents < 0 THEN 'debit' ELSE 'credit' END AS kind,
       SUM(cents) OVER (PARTITION BY account_id ORDER BY posted_at) AS running,
       posted_at::date AS day
FROM public.entries
WHERE posted_at > now() - INTERVAL '30 days' AND memo IS NOT NULL;

DELETE FROM entries WHERE account_id IN (SELECT id FROM accounts WHERE closed_at IS NOT NULL);
