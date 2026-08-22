import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Notification, NotificationListResponse } from '@dwg/shared';
import { NotificationBell } from './notification-bell';
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '@/lib/notifications-api';

vi.mock('@/lib/notifications-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notifications-api')>()),
  fetchNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'ntf_1',
    severity: 'critical',
    title: 'Broker connectivity',
    body: 'The Docker broker did not respond to a ping.',
    createdAt: '2026-08-22T09:00:00.000Z',
    readAt: null,
    resolvedAt: null,
    link: '/docker/health',
    ...overrides,
  };
}

function makeList(
  notifications: readonly Notification[],
  unreadCount?: number,
): NotificationListResponse {
  return {
    notifications: [...notifications],
    unreadCount: unreadCount ?? notifications.filter((n) => n.readAt === null).length,
  };
}

function renderBell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('NotificationBell', () => {
  it('shows no unread badge and an empty state when there is nothing to report', async () => {
    vi.mocked(fetchNotifications).mockResolvedValue(makeList([]));
    const user = userEvent.setup();
    renderBell();

    await waitFor(() => expect(fetchNotifications).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('Nothing to report.')).toBeInTheDocument();
  });

  it('shows the real unread count, and a real notification with its title and severity', async () => {
    vi.mocked(fetchNotifications).mockResolvedValue(makeList([makeNotification()]));
    const user = userEvent.setup();
    renderBell();

    expect(
      await screen.findByRole('button', { name: 'Notifications, 1 unread' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    expect(await screen.findByText('Broker connectivity')).toBeInTheDocument();
    expect(screen.getByText('The Docker broker did not respond to a ping.')).toBeInTheDocument();
  });

  it('a real link takes the admin to the page that explains the problem, and dismiss marks it read via the real API', async () => {
    vi.mocked(fetchNotifications).mockResolvedValue(makeList([makeNotification()]));
    vi.mocked(markNotificationRead).mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    const link = await screen.findByRole('link', { name: /Broker connectivity/ });
    expect(link).toHaveAttribute('href', '/docker/health');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith('ntf_1'));
  });

  it("a notification with no real link to point to (dashboard.ts's own Rspamd gap) renders without becoming a broken link", async () => {
    vi.mocked(fetchNotifications).mockResolvedValue(
      makeList([makeNotification({ id: 'ntf_2', title: 'Rspamd unreachable', link: null })]),
    );
    const user = userEvent.setup();
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    expect(await screen.findByText('Rspamd unreachable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Rspamd unreachable/ })).not.toBeInTheDocument();
  });

  it('Mark all read calls the real API and the dropdown drops the Dismiss affordance once nothing is unread', async () => {
    // A stateful mock, not a fixed once/always sequence — robust to
    // however many times React Query happens to refetch, since the read
    // state this simulates never regresses once applied.
    let read = false;
    vi.mocked(fetchNotifications).mockImplementation(async () =>
      makeList([makeNotification(read ? { readAt: '2026-08-22T09:05:00.000Z' } : {})]),
    );
    vi.mocked(markAllNotificationsRead).mockImplementation(async () => {
      read = true;
    });
    const user = userEvent.setup();
    renderBell();

    await user.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    expect(await screen.findByRole('button', { name: 'Dismiss' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => expect(markAllNotificationsRead).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument(),
    );
  });
});
