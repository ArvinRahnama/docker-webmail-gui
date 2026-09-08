export type { SelfUpdateRelease, SelfUpdateReleaseSourcePort } from './types.js';
export { RealSelfUpdateReleaseSource } from './real-self-update-release-source.js';
export {
  FakeSelfUpdateReleaseSource,
  FIXTURE_LATEST_VERSION,
  FIXTURE_LATEST_PUBLISHED_AT,
} from './fake-self-update-release-source.js';
export { createSelfUpdateReleaseSource } from './create-self-update-release-source.js';
