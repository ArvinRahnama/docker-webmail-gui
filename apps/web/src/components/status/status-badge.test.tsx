import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from './status-badge';
import { STATUS_STATES } from './status';

describe('StatusBadge', () => {
  it.each(STATUS_STATES)('renders visible text for the %s state, not just an icon', (status) => {
    render(<StatusBadge status={status} />);
    // The default label text must be real, visible DOM text — §2 principle
    // 5 / §3.3: colour/icon alone is never enough.
    expect(screen.getByText(new RegExp(status, 'i'))).toBeInTheDocument();
  });

  it.each(STATUS_STATES)(
    'marks its icon aria-hidden for the %s state (text carries the meaning)',
    (status) => {
      const { container } = render(<StatusBadge status={status} />);
      const icon = container.querySelector('svg');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    },
  );

  it('renders a caller-supplied label instead of the default state word', () => {
    render(<StatusBadge status="critical" label="3 problems" />);
    expect(screen.getByText('3 problems')).toBeInTheDocument();
    expect(screen.queryByText('Critical')).not.toBeInTheDocument();
  });

  it('gives every one of the six states a visually distinct icon (no two states share a component)', () => {
    const seen = new Set<string>();
    for (const status of STATUS_STATES) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      const svg = container.querySelector('svg');
      // lucide-react tags each icon's <svg> with a stable class derived
      // from its component name (e.g. "lucide-circle-check-big"); comparing
      // that class is a cheap way to assert six genuinely different icons
      // without snapshotting full markup.
      const iconClass = [...(svg?.classList ?? [])].find(
        (c) => c.startsWith('lucide-') && c !== 'lucide',
      );
      expect(iconClass, `status ${status} should render a lucide icon`).toBeTruthy();
      seen.add(iconClass!);
      unmount();
    }
    expect(seen.size).toBe(STATUS_STATES.length);
  });

  it("renders the unknown state as grey, distinct from the warning state's amber (never conflated)", () => {
    const { container: unknownContainer } = render(<StatusBadge status="unknown" />);
    const { container: warningContainer } = render(<StatusBadge status="warning" />);
    const unknownSpan = unknownContainer.firstElementChild!;
    const warningSpan = warningContainer.firstElementChild!;
    // They must not resolve to the exact same colour utility class set —
    // the whole point of §3.3's "unknown is grey, not yellow" rule.
    expect(unknownSpan.className).not.toBe(warningSpan.className);
  });

  it('renders the solid variant with the same status colour and a bold border rather than a tinted fill', () => {
    render(<StatusBadge status="critical" variant="solid" />);
    // getByText resolves to the inner <span>{text}</span>; the outer
    // badge element (which carries the variant classes) is its parent.
    const badge = screen.getByText('Critical').parentElement!;
    expect(badge.className).toContain('border-2');
    expect(badge.className).toContain('text-status-critical-fg');
  });
});
