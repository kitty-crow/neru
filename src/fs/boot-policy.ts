import type { SharedSnapshot } from "./protocol.js";

export type MissingSharedPolicy = "fail" | "read-only-checkpoint" | "recovery";

export type SharedBootDecision =
  | { mode: "shared"; generation: number; baseGeneration: number; readOnly: false }
  | { mode: "checkpoint"; generation: number; baseGeneration: number; readOnly: true; reason: string }
  | { mode: "recovery"; generation: number; baseGeneration: number; readOnly: true; reason: string };

export const decideSharedBoot = (
  imageGeneration: number,
  shared: SharedSnapshot | null,
  policy: MissingSharedPolicy = "fail",
): SharedBootDecision => {
  if (shared) {
    return {
      mode: "shared",
      generation: shared.generation,
      baseGeneration: imageGeneration,
      readOnly: false,
    };
  }
  if (policy === "fail") {
    throw new Error("authoritative mikuOS userspace is unavailable; refusing to create a divergent NERU installation");
  }
  return {
    mode: policy === "recovery" ? "recovery" : "checkpoint",
    generation: imageGeneration,
    baseGeneration: imageGeneration,
    readOnly: true,
    reason: "authoritative userspace unavailable",
  };
};
