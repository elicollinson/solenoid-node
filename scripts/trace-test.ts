/**
 * Diagnostic: verify OTel spans reach W&B Weave end-to-end
 *
 * Usage: WANDB_API_KEY=<key> WANDB_PROJECT_ID=<entity/project> bun run scripts/trace-test.ts
 */
import { maybeSetOtelProviders } from '@google/adk';
import { trace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

const apiKey = process.env.WANDB_API_KEY;
const projectId = process.env.WANDB_PROJECT_ID;

if (!apiKey || !projectId) {
  console.error('Set WANDB_API_KEY and WANDB_PROJECT_ID');
  process.exit(1);
}

const url = 'https://trace.wandb.ai/otel/v1/traces';
const auth = Buffer.from(`api:${apiKey}`).toString('base64');

console.log('Config:');
console.log('  url:', url);
console.log('  project_id:', projectId);

const otlpExporter = new OTLPTraceExporter({
  url,
  headers: {
    Authorization: `Basic ${auth}`,
    project_id: projectId,
  },
});

// Use BatchSpanProcessor directly (no WeaveSpanProcessor) to test raw export
const batchProcessor = new BatchSpanProcessor(otlpExporter);
maybeSetOtelProviders([{ spanProcessors: [batchProcessor] }]);

const tracer = trace.getTracer('solenoid');

// Test span with sanitized name (no special chars) + Weave thread attributes
const span = tracer.startSpan('diagnostic_agent_run');
span.setAttribute('gen_ai.agent.name', 'diagnostic_agent');
span.setAttribute('gen_ai.operation.name', 'invoke_agent');
span.setAttribute('wandb.thread_id', 'test-thread-123');
span.setAttribute('wandb.is_turn', true);
span.end();

console.log('Span created and ended. Flushing to Weave...');

// Call forceFlush directly to surface any export errors
try {
  await batchProcessor.forceFlush();
  console.log('Export OK! Check: https://wandb.ai/' + projectId + '/weave/traces');
} catch (e) {
  console.error('Export FAILED:', e);
}

await batchProcessor.shutdown();
