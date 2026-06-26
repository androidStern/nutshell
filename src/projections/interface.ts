import type { ProjectionReport, ProjectionRequest } from "../core/types";
import type { TraceStore } from "../store/interface";

export interface Projection {
  render(store: TraceStore, request: ProjectionRequest, root: string): Promise<ProjectionReport>;
}
