/**
 * MemoryVault Agent Protocol — Hello World (Scaffolding Verification)
 *
 * Minimal CRE workflow to verify that the cre-memoryvault project scaffolding
 * is correct. This workflow will be removed after verification.
 *
 * Test: cre workflow simulate protocol/hello-world --target staging-settings
 */

import {
    cre,
    Runner,
    type Runtime,
    type CronPayload,
} from "@chainlink/cre-sdk";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────────────────────

const configSchema = z.object({
    schedule: z.string(),
});

type Config = z.infer<typeof configSchema>;

// ── Cron Handler ────────────────────────────────────────────────────────────

const onCronTrigger = (
    runtime: Runtime<Config>,
    _payload: CronPayload
): string => {
    const timestamp = runtime.now();
    runtime.log(`[MemoryVault] Hello World — scaffolding verified at ${timestamp}`);
    runtime.log(`[MemoryVault] CRE SDK loaded successfully`);
    runtime.log(`[MemoryVault] Config schedule: ${runtime.config.schedule}`);

    return JSON.stringify({
        status: "success",
        message: "MemoryVault scaffolding verified",
        timestamp,
    });
};

// ── Workflow Init ───────────────────────────────────────────────────────────

const initWorkflow = (config: Config) => {
    const cron = new cre.capabilities.CronCapability();

    return [
        cre.handler(
            cron.trigger({ schedule: config.schedule }),
            onCronTrigger
        ),
    ];
};

// ── Main ────────────────────────────────────────────────────────────────────

export async function main() {
    const runner = await Runner.newRunner<Config>({ configSchema });
    await runner.run(initWorkflow);
}

main();
