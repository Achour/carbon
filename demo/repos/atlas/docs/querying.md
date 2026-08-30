# Querying

Nimbus speaks a subset of SQL. Queries run against the last 90 days by default.

```sql
SELECT path, count() AS views
FROM events
WHERE name = 'page_view' AND ts > now() - INTERVAL 7 DAY
GROUP BY path
ORDER BY views DESC
LIMIT 10
```
