import { printSummary, resetCounters } from "./harness";
import * as backoffTimeout from "./test-backoff-timeout";
import * as changed from "./test-changed";
import * as children from "./test-children";
import * as events from "./test-events";
import * as rerun from "./test-rerun";
import * as sleep from "./test-sleep";
import * as state from "./test-state";
import * as steps from "./test-steps";

async function main() {
	resetCounters();
	await steps.run();
	await sleep.run();
	await events.run();
	await rerun.run();
	await changed.run();
	await state.run();
	await backoffTimeout.run();
	await children.run();
	printSummary();
}

main();
