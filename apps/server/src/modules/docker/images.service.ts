/**
 * Images service (M9 — FEATURE_MATRIX.md §24). `prune` always means
 * "remove every dangling image" — there is no by-id removal anywhere in
 * this service, this module's routes, or the broker protocol underneath
 * it (`@dwg/shared`'s `ImagePruneRequestSchema` takes no parameters at
 * all), so §24's "an image in use by any container — running or stopped —
 * can never be selected" holds because there is no selection to make, not
 * only because the UI declines to offer one.
 */
import type { ImagePruneResponse, ImageSummary } from '@dwg/shared';
import type { BrokerClient } from '../../drivers/broker/types.js';

export class ImagesService {
  constructor(private readonly broker: BrokerClient) {}

  async list(): Promise<readonly ImageSummary[]> {
    return this.broker.imageList();
  }

  async prune(): Promise<ImagePruneResponse> {
    return this.broker.imagePrune();
  }
}
