import type { HealthFinding, SourceId } from "../core/types";
import type { TracePlugin } from "../plugins/interface";
import type { SetupProber } from "../setup/probe";

// Scripted prober for setup tests. Each source gets a sequence of findings
// arrays: successive probe() calls consume the sequence and the last entry
// repeats forever. Sources without a script always pass (no findings).
// An optional shared event log records probe order across fakes, so tests can
// assert ordering against other recorded events (e.g. the permission window
// opening before the first probe).
export class FakeSetupProber implements SetupProber {
  readonly calls: SourceId[] = [];
  private readonly sequences = new Map<SourceId, HealthFinding[][]>();

  constructor(
    sequences: Record<string, HealthFinding[][]> = {},
    private readonly events?: string[],
  ) {
    for (const [source, sequence] of Object.entries(sequences)) {
      this.sequences.set(source, [...sequence]);
    }
  }

  callCount(source: SourceId): number {
    return this.calls.filter((call) => call === source).length;
  }

  async probe(plugin: TracePlugin, _signal: AbortSignal): Promise<HealthFinding[]> {
    const source = plugin.manifest.id;
    this.calls.push(source);
    this.events?.push(`probe:${source}`);
    const sequence = this.sequences.get(source);
    if (!sequence?.length) return [];
    return sequence.length > 1 ? sequence.shift()! : sequence[0]!;
  }
}
