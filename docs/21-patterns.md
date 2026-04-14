# Patterns & Recipes

## Pattern 1: Pipeline (Sequential Steps)

```ts
const pipeline: WorkflowFn<{ url: string }> = async (input, wf) => {
	const [html] = await wf.step("fetch", () => fetchPage(input.url));
	const [parsed] = await wf.step("parse", () => parseListingData(html));
	const [filtered] = await wf.step("filter", () => applyFilters(parsed));
	const [stored] = await wf.step("store", () => saveToDB(filtered));
	return { listingId: stored.id };
};
```

## Pattern 2: Fan-Out with Memoized Spawn Plan

Use `memo()` to freeze random ordering, then spawn children:

```ts
const fanOut: WorkflowFn = async (input, wf) => {
  const [brokers] = await wf.step("find-brokers", () => matchBrokers(input));

  const [spawnPlan] = await wf.memo("spawn_plan", () => {
    const shuffled = [...brokers];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled.map((b, i) => ({
      brokerId: b.id,
      runAt: i > 0 ? new Date(Date.now() + i * 25 * 60_000).toISOString() : undefined,
    }));
  });

  for (const entry of spawnPlan) {
    await wf.step(`spawn:${entry.brokerId}`, () =>
      engine.run("outreach:1", { ...input, brokerId: entry.brokerId }, {
        instance: { leadId: input.leadId, brokerId: entry.brokerId },
        parentRunId: wf.runId,
        queue: "leads",
        runAt: entry.runAt,
      }),
    );
  }

  wf.log("info", "Fan-out complete", { spawned: spawnPlan.length });
  return { spawned: spawnPlan.length };
};
```

## Pattern 3: Wait for External Approval

```ts
const gatedWorkflow: WorkflowFn = async (input, wf) => {
  await wf.step("send-email", () => sendEmail(input.to, input.body));

  // Suspend until: POST /api/workflows/{runId}/events/approval { approved: true }
  const response = await wf.waitForEvent<{ approved: boolean }>("approval");

  if (!response.approved) {
    throw new FatalError("Approval denied");
  }

  await wf.step("process", () => processApprovedItem(input));
  return { status: "done" };
};
```

## Pattern 4: Sleep Until a Scheduled Time

```ts
const scheduledSend: WorkflowFn = async (input, wf) => {
  const [listing] = await wf.step("fetch", () => fetchListing(input.listingId));

  const [sendTime] = await wf.memo("pick_slot", () =>
    pickEveningSlot(new Date(), { hour: 17, tz: "Europe/Berlin" }, { hour: 19, tz: "Europe/Berlin" })
  );

  wf.log("info", "Waiting for send slot", { sendTime: sendTime.toISOString() });
  await wf.waitForDate(sendTime, "wait-for-slot");

  await wf.step("send", () => sendMessage(listing));
  return { sent: true };
};
```

## Pattern 5: Poll for Rate-Limit Clearance

```ts
const rateLimitedSend: WorkflowFn = async (input, wf) => {
  const [message] = await wf.step("generate", () => generateMessage(input));

  const [{ jitterMs }] = await wf.memo("jitter", () => ({
    jitterMs: Math.random() * 120_000,
  }));

  await wf.poll("send_slot", {
    check: async () => {
      const result = await canSendNow(input.platform, input.email, jitterMs);
      if (result.ready) return { ready: true };
      return { ready: false, retryAfterMs: result.waitMs };
    },
    minIntervalMs: 30_000,
  });

  wf.log("info", "Send slot acquired");
  await wf.step("send", () => sendNow(input, message));
  return { sent: true };
};
```

## Pattern 6: Fail-Open Optional Steps

```ts
const enrichedPipeline: WorkflowFn = async (input, wf) => {
  const [listing] = await wf.step("fetch", () => fetchListing(input.id));

  const [enrichment, err] = await wf.step("enrich", () => enrichListing(listing), {
    maxAttempts: 2,
    onAllAttemptsFailed: "complete",
    timeout: "10s",
  });

  const [score] = await wf.step("score", () => {
    if (err) {
      return scoreListing(listing, null);  // enrichment failed — score without it
    } else {
      return scoreListing(listing, enrichment);
    }
  });

  return { score };
};
```

## Pattern 7: Conditional Branching (Early Exit)

```ts
const qualificationWorkflow: WorkflowFn = async (input, wf) => {
  const [listing] = await wf.step("fetch", () => fetchListing(input.id));

  const [staticResult] = await wf.step("static-filter", () => staticFilter(listing));
  if (!staticResult.passed) {
    wf.log("info", "Static filter rejected", { reason: staticResult.reason });
    return { verdict: `disqualified:${staticResult.reason}` };
  }

  const [llmResult, llmErr] = await wf.step("llm-filter", () => llmFilter(listing), {
    maxAttempts: 2,
    onAllAttemptsFailed: "complete",
    timeout: "60s",
  });
  if (llmErr) {
    wf.log("info", "LLM filter failed — skipping", { error: llmErr });
  } else if (!llmResult!.passed) {
    wf.log("info", "LLM filter rejected", { reason: llmResult!.reason });
    return { verdict: `disqualified:${llmResult!.reason}` };
  }

  return { verdict: "qualified" };
};
```

## Pattern 8: Idempotent Re-entry (Scraper Events)

The engine does not deduplicate by itself — the caller checks the domain table to avoid double-starting:

```ts
async function handleListingEvent(event: ListingEvent) {
  // Check domain table first — avoid creating a duplicate run
  const existing = await db.query.leads.findFirst({
    where: eq(leads.listingId, event.listingId),
  });

  if (existing?.workflowInstanceId) {
    // Instance already exists — rerun it if it's in a terminal state,
    // or let it continue if it's still in progress.
    const latest = await engine.getLatestRun(existing.workflowInstanceId);
    if (latest && ["completed", "failed", "cancelled"].includes(latest.status)) {
      await engine.rerun(existing.workflowInstanceId);
    }
    return;
  }

  // First time — start a fresh instance
  const { instanceId, runId } = await engine.run("lead-qualification:1", {
    platform: "ka",
    listingId: event.listingId,
    triggeredBy: "auto",
  }, {
    instance: { platform: "ka", listingId: event.listingId },
    queue: "leads",
  });

  await db.update(leads)
    .set({ workflowInstanceId: instanceId })
    .where(eq(leads.listingId, event.listingId));
}
```

## Pattern 9: Rerun a Lead

```ts
async function rerunLead(leadId: number) {
  const lead = getLeadById(leadId);

  if (lead.workflowInstanceId) {
    await engine.rerun(lead.workflowInstanceId);
  } else {
    const { instanceId } = await engine.run("lead-qualification:1", {
      platform: lead.platform,
      listingId: lead.listingId,
      triggeredBy: "manual",
    }, {
      instance: { platform: lead.platform, listingId: lead.listingId },
      queue: "leads",
    });
    await db.update(leads).set({ workflowInstanceId: instanceId }).where(eq(leads.id, leadId));
  }
}
```

## Pattern 10: Rerun Single Child

```ts
async function rerunOutreach(leadId: number, brokerId: number) {
  const assignment = getAssignmentByLeadAndBroker(leadId, brokerId);

  if (assignment?.workflowInstanceId) {
    await engine.rerun(assignment.workflowInstanceId);
  } else {
    const lead = getLeadById(leadId);
    const { instanceId } = await engine.run("lead-outreach:1", {
      platform: lead.platform,
      listingId: lead.listingId,
      leadId,
      brokerId,
      brokerageId: assignment?.brokerageId ?? null,
      triggeredBy: "manual",
    }, {
      instance: { leadId, brokerId },
      queue: "leads",
      parentRunId: lead.latestRunId ?? undefined,
    });
    await db.update(brokerAssignments)
      .set({ workflowInstanceId: instanceId })
      .where(and(eq(brokerAssignments.leadId, leadId), eq(brokerAssignments.brokerId, brokerId)));
  }
}
```

## Pattern 11: Selective Re-run with Change Detection

```ts
const smartRefresh: WorkflowFn = async (input, wf) => {
  // Always re-fetch (get latest data)
  const [listing] = await wf.step("fetch", () => fetchListing(input.id), { rerun: true });

  // Only re-process if the listing data actually changed
  const listingChanged = await wf.changed("listing", listing);

  const [filtered] = await wf.step("filter", () => filter(listing), { rerun: listingChanged });
  const [scored] = await wf.step("score", () => score(filtered), { rerun: listingChanged });
  const [matched] = await wf.step("match", () => matchBrokers(scored), { rerun: listingChanged });

  wf.log("info", "Refresh complete", { listingChanged, matchCount: matched.length });
  return { matchCount: matched.length };
};
```

## Pattern 12: Webhook Callback

```ts
// Workflow: send request and wait for webhook callback
const webhookWorkflow: WorkflowFn = async (input, wf) => {
  await wf.step("send-request", () =>
    callExternalApi(input.payload, {
      callbackUrl: `https://api.example.com/api/workflows/${wf.runId}/events/callback`,
    }),
  );

  const result = await wf.waitForEvent<{ status: string; data: unknown }>("callback");

  await wf.step("process-result", () => processResult(result));
  return { status: result.status };
};

// The external system POSTs to the callback URL when done:
// POST /api/workflows/42/events/callback { "status": "ok", "data": {...} }
```

## Pattern 13: diff() + kv() for Child Lifecycle

Use `diff()` to detect which children were added or removed across reruns, and `kv()` to track the instance IDs of spawned children so they can be reruned or cancelled.

```ts
const coordinatorWorkflow: WorkflowFn<{ leadId: number }> = async (input, wf) => {
	// Always re-fetch the current broker list
	const [brokers] = await wf.step("fetch-brokers", () => matchBrokers(input.leadId), { rerun: true });

	// Diff against previous run — find what changed
	const { added, removed, kept } = await wf.diff("brokers", brokers, (b) => String(b.id));

	// kv() tracks brokerId → workflowInstanceId
	const childInstances = wf.kv<number>("child-instances");

	// Cancel workflows for removed brokers
	for (const broker of removed) {
		const instanceId = childInstances.get(String(broker.id));
		if (instanceId) {
			const latest = await engine.getLatestRun(instanceId);
			if (latest && !["completed", "failed", "cancelled"].includes(latest.status)) {
				await engine.cancel(latest.id);
			}
			await childInstances.delete(String(broker.id));
		}
	}

	// Rerun or start workflows for added brokers
	for (const broker of added) {
		await wf.step(`spawn:${broker.id}`, async () => {
			const { instanceId } = await engine.run("outreach:1", {
				leadId: input.leadId,
				brokerId: broker.id,
			}, {
				instance: { leadId: input.leadId, brokerId: broker.id },
				parentRunId: wf.runId,
				queue: "leads",
			});
			await childInstances.set(String(broker.id), instanceId);
		});
	}

	// Rerun kept brokers (e.g. listing data changed)
	for (const broker of kept) {
		const instanceId = childInstances.get(String(broker.id));
		if (instanceId) {
			await engine.rerun(instanceId);
		}
	}

	return { added: added.length, removed: removed.length, kept: kept.length };
};
```

---

Next: [CLI & REST API](22-cli-and-rest.md)
