import type { TraceConfig } from "../config/config";
import { objectAt, pluginConfig } from "../config/config";
import type { SourceId } from "../core/types";
import type { TracePlugin } from "./interface";
import { createAppleNotesPlugin } from "./builtin/apple-notes/plugin";
import { createPodcastsPlugin } from "./builtin/podcasts/plugin";
import { createTwitterPlugin } from "./builtin/twitter/plugin";
import { createYouTubePlugin } from "./builtin/youtube/plugin";

export class PluginRegistry {
  private readonly plugins = new Map<SourceId, TracePlugin>();

  constructor(plugins: TracePlugin[]) {
    for (const plugin of plugins) {
      this.plugins.set(plugin.manifest.id, plugin);
    }
  }

  list(): TracePlugin[] {
    return [...this.plugins.values()];
  }

  get(source: SourceId): TracePlugin {
    const plugin = this.plugins.get(source);
    if (!plugin) throw new Error(`unknown plugin: ${source}`);
    return plugin;
  }

  enabled(config: TraceConfig): TracePlugin[] {
    return this.list().filter((plugin) => {
      const cfg = pluginConfig(config, plugin.manifest.id);
      return cfg.enabled !== false;
    });
  }
}

export function loadBuiltinPlugins(): PluginRegistry {
  return new PluginRegistry([createYouTubePlugin(), createPodcastsPlugin(), createAppleNotesPlugin(), createTwitterPlugin()]);
}

export function enabledPluginIds(config: TraceConfig): SourceId[] {
  const plugins = objectAt(config.data, "plugins");
  return Object.entries(plugins)
    .filter(([, value]) => !value || typeof value !== "object" || Array.isArray(value) || value.enabled !== false)
    .map(([key]) => key as SourceId);
}

