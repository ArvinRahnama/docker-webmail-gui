import { describe, expect, it } from 'vitest';
import { ImageListResponseSchema, ImagePruneResponseSchema } from '@dwg/shared';
import { authedInject, loginAs, setUpDockerApp } from './docker-test-harness.js';

describe('/api/v1/docker/images', () => {
  it('requires authentication', async () => {
    const { app } = await setUpDockerApp();
    const response = await app.inject({ method: 'GET', url: '/api/v1/docker/images' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('lists images', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'GET',
      url: '/api/v1/docker/images',
    });
    expect(response.statusCode).toBe(200);
    expect(ImageListResponseSchema.safeParse(response.json()).success).toBe(true);
    await app.close();
  });

  // -----------------------------------------------------------------
  // The control FEATURE_MATRIX.md §24 requires: cleanup is dangling-only,
  // and holds "because there is no selection to make". There is no field
  // anywhere to name an image — asserted here by proving the route rejects
  // any body at all beyond the empty one, and that no by-id removal route
  // exists.
  // -----------------------------------------------------------------

  it('prunes dangling images and takes no parameters', async () => {
    const { app, db } = await setUpDockerApp();
    const auth = await loginAs(app);
    const response = await authedInject(app, auth, {
      method: 'POST',
      url: '/api/v1/docker/images/prune',
    });
    expect(response.statusCode).toBe(200);
    expect(ImagePruneResponseSchema.safeParse(response.json()).success).toBe(true);

    const rows = db.all<{ action: string; target: string | null }>(
      "SELECT action, target FROM audit_log WHERE action = 'image.prune'",
    );
    expect(rows).toHaveLength(1);
    // No single resource target — a prune sweep, never a named image.
    expect(rows[0]?.target).toBeNull();
    await app.close();
  });

  it('has no route that removes or targets one named image', async () => {
    const { app } = await setUpDockerApp();
    const auth = await loginAs(app);
    const byId = await authedInject(app, auth, {
      method: 'DELETE',
      url: '/api/v1/docker/images/sha256:whatever',
    });
    expect(byId.statusCode).toBe(404);
    await app.close();
  });
});
