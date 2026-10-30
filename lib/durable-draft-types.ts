/** JSON-serialized normal or schedule composer state. No browser/Node runtime dependencies. */
export type DraftPayload = Record<string, unknown>;

export interface DraftRecord {
  key: string;
  /** Monotonic CAS token; explicit cleanup returns a nonzero empty tombstone. */
  revision: number;
  payload: DraftPayload | null;
  updatedAt: string;
}

export interface DraftVersion {
  revision: number;
  updatedAt: string;
  reason: "save" | "clear" | "conflict";
  preview: string;
}

/** Images may use same-key draftImageId references. Nested images may instead
 * use draftImageIndex into payload.images; this transport field is not retained. */
export interface SaveDurableDraftInput {
  key: string;
  baseRevision: number;
  mutationId: string;
  payload: DraftPayload | null;
}
