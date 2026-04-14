# CLI & REST API

## CLI

The workflow engine is observable via the `mm` CLI:

```bash
# List all runs (paginated)
mm workflows list

# Filter by status
mm workflows list --status failed
mm workflows list --status sleeping

# Filter by workflow name (substring match, also matches instance keys and IDs)
mm workflows list --name lead-qualification

# Filter by queue
mm workflows list --queue leads

# Pagination
mm workflows list --page 2 --limit 100

# Get a single run with all steps and logs
mm workflows get 42
```

## REST API

### List Runs

```
GET /api/workflows
```

Query parameters: `status`, `name` (substring), `queue`, `page`, `limit`, `order` (`asc`/`desc`).

Response:

```json
{
  "items": [...],
  "total": 150,
  "page": 1,
  "limit": 50,
  "totalPages": 3,
  "summary": {
    "pending": 5,
    "running": 2,
    "sleeping": 10,
    "waiting": 1,
    "completed": 120,
    "failed": 8,
    "cancelled": 4
  }
}
```

### Get Single Run

```
GET /api/workflows/:id
```

Response includes steps, children, and logs:

```json
{
  "id": 42,
  "instanceId": 17,
  "name": "lead-qualification:1",
  "status": "completed",
  "input": "...",
  "output": "...",
  "steps": [...],
  "children": [...],
  "logs": [...]
}
```

### Send Event to a Waiting Run

```
POST /api/workflows/:id/events/:name
Content-Type: application/json

{ "approved": true }
```

Response:

```json
{ "ok": true, "runId": 42, "event": "approval" }
```

This endpoint delivers an event to an run suspended on `wf.waitForEvent(name)`. Returns 404 if the run doesn't exist.

---

Next: [Testing](23-testing.md)
